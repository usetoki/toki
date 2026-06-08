//! socket bind, listen options, static table, slowloris sweep, shutdown.
//! hot path is in loop.zig; this just wires it up and tears it down.

const std = @import("std");
const builtin = @import("builtin");
const napi = @import("../ffi/napi.zig");
const uv = @import("../ffi/uv.zig");
const router = @import("../http/router.zig");
const static = @import("../http/static.zig");
const ratelimit = @import("../security/ratelimit.zig");
const websocket = @import("../websocket/session.zig");
const tlsmod = @import("../tls/tls.zig");
const eng = @import("engine.zig");
const loop = @import("loop.zig");

const alloc = eng.alloc;

// remove the unix socket file (no-op on Windows, where it's a named pipe, not a file)
const removeSocketFile = if (builtin.os.tag == .windows)
    struct {
        fn run(_: [*c]const u8) void {}
    }.run
else
    struct {
        extern fn unlink(path: [*c]const u8) c_int;
        fn run(path: [*c]const u8) void {
            _ = unlink(path);
        }
    }.run;

/// listen(port, methods, paths, dispatch, staticEntries, options, wsDispatch, wsRouteIndices, wsProtocols)
pub fn listen(env: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
    var argc: usize = 9;
    var argv: [9]napi.Value = undefined;
    _ = napi.napi_get_cb_info(env, info, &argc, &argv, null, null);

    var port: i32 = 0;
    _ = napi.napi_get_value_int32(env, argv[0], &port);

    // arena is scratch; build copies what it keeps.
    var scratch = std.heap.ArenaAllocator.init(alloc);
    defer scratch.deinit();
    const methods = readStringArray(env, argv[1], scratch.allocator()) catch return eng.undefinedValue(env);
    const paths = readStringArray(env, argv[2], scratch.allocator()) catch return eng.undefinedValue(env);
    eng.routes = router.RouteTable.build(alloc, methods, paths) catch return eng.undefinedValue(env);

    _ = napi.napi_create_reference(env, argv[3], 1, &eng.dispatch_ref);
    eng.static_table = static.Table.init(alloc);
    buildStaticTable(env, argv[4]);
    ratelimit.init(alloc);
    readOptions(env, argv[5]);
    if (!setupTls(env, argv[5])) return eng.undefinedValue(env); // bad cert/key → threw
    websocket.configure(env, argv[6], argv[7], argv[8], methods.len);

    boot(env, port);
    return portValue(env);
}

// Reads the PEM cert chain + private key (if present) and builds the TLS config so
// the server terminates HTTPS directly. Returns false after throwing a JS error on a
// missing key or unparsable PEM; true when TLS is off or configured cleanly. The
// buffers are valid for this synchronous call — init parses + copies what it keeps.
fn setupTls(env: napi.Env, options: napi.Value) bool {
    const cert = readBufferProp(env, options, "tlsCert") orelse return true; // no cert → plain HTTP
    const key = readBufferProp(env, options, "tlsKey") orelse {
        _ = napi.napi_throw_error(env, null, "tls: `key` is required alongside `cert`");
        return false;
    };
    // HTTPS keeps today's behavior: no client-certificate auth (client_auth = null).
    tlsmod.init(alloc, cert, key, null) catch |e| {
        var msg: [128]u8 = undefined;
        const text = std.fmt.bufPrintZ(&msg, "tls: {s}", .{@errorName(e)}) catch "tls: setup failed";
        _ = napi.napi_throw_error(env, null, text.ptr);
        return false;
    };
    return true;
}

fn portValue(env: napi.Env) napi.Value {
    var out: napi.Value = undefined;
    _ = napi.napi_create_uint32(env, eng.bound_port, &out);
    return out;
}

// binds onto node's own libuv loop, not a private one.
fn boot(env: napi.Env, port: i32) void {
    eng.env = env;
    _ = napi.napi_get_uv_event_loop(env, &eng.loop);

    if (eng.unix_path != null) {
        _ = uv.uv_pipe_init(eng.loop.?, eng.opaqueOf(&eng.listen_socket), 0);
        removeSocketFile(&eng.unix_path_buf); // clear a stale socket file so the bind succeeds
        const bind_rc = uv.uv_pipe_bind(eng.opaqueOf(&eng.listen_socket), &eng.unix_path_buf);
        if (bind_rc != 0) {
            _ = napi.napi_throw_error(env, null, uv.uv_strerror(bind_rc));
            return;
        }
    } else {
        _ = uv.uv_tcp_init(eng.loop.?, eng.opaqueOf(&eng.listen_socket));
        var addr: uv.SockaddrIn = undefined;
        _ = uv.uv_ip4_addr(&eng.host_buf, port, eng.opaqueOf(&addr));
        const bind_rc = uv.uv_tcp_bind(eng.opaqueOf(&eng.listen_socket), eng.opaqueOf(&addr), eng.bind_flags);
        if (bind_rc != 0) {
            // e.g. UV_TCP_REUSEPORT unsupported on macOS — surface it rather than swallow.
            _ = napi.napi_throw_error(env, null, uv.uv_strerror(bind_rc));
            return;
        }
    }

    const rc = uv.uv_listen(eng.opaqueOf(&eng.listen_socket), eng.backlog, &loop.onConnection);
    if (rc != 0) _ = napi.napi_throw_error(env, null, uv.uv_strerror(rc));

    // requested port 0 means OS-assigned; read back what we actually got (TCP only).
    if (eng.unix_path == null) {
        var bound: uv.SockaddrIn = undefined;
        var blen: c_int = @sizeOf(uv.SockaddrIn);
        if (uv.uv_tcp_getsockname(eng.opaqueOf(&eng.listen_socket), eng.opaqueOf(&bound), &blen) == 0) {
            eng.bound_port = std.mem.bigToNative(u16, bound.port);
        }
    }

    // only arm the sweep if a guard needs it
    if (eng.header_timeout_ms > 0 or ratelimit.enabled()) {
        _ = uv.uv_timer_init(eng.loop.?, eng.opaqueOf(&eng.sweep_timer));
        _ = uv.uv_timer_start(eng.opaqueOf(&eng.sweep_timer), &onSweep, 1000, 1000);
    }
}

fn readOptions(env: napi.Env, options: napi.Value) void {
    if (readOptUint(env, options, "maxBodyBytes")) |v| eng.max_body = v;
    if (readOptUint(env, options, "headerTimeoutMs")) |v| eng.header_timeout_ms = v;
    if (readOptUint(env, options, "maxHeaders")) |v| eng.max_headers = v;
    if (readOptUint(env, options, "backlog")) |v| eng.backlog = @intCast(v);
    if (readOptBool(env, options, "reusePort")) eng.bind_flags = 2; // UV_TCP_REUSEPORT
    if (readOptBool(env, options, "notFound")) eng.not_found_dispatch = true;
    if (readOptUint(env, options, "rateLimitMax")) |v| ratelimit.max = @intCast(v);
    if (readOptUint(env, options, "rateLimitWindowMs")) |v| ratelimit.window_ms = v;
    if (readOptUint(env, options, "maxWsMessageBytes")) |v| eng.max_ws_message = v;
    if (readOptBool(env, options, "wsCompression")) eng.ws_compression = true;

    var value: napi.Value = undefined;
    _ = napi.napi_get_named_property(env, options, "host", &value);
    var kind: c_int = 0;
    _ = napi.napi_typeof(env, value, &kind);
    if (kind == napi.valuetype.string) {
        var copied: usize = 0;
        _ = napi.napi_get_value_string_utf8(env, value, &eng.host_buf, eng.host_buf.len, &copied);
    }

    // unixPath: bind a unix-domain socket instead of TCP.
    var upath: napi.Value = undefined;
    _ = napi.napi_get_named_property(env, options, "unixPath", &upath);
    var ukind: c_int = 0;
    _ = napi.napi_typeof(env, upath, &ukind);
    if (ukind == napi.valuetype.string) {
        var copied: usize = 0;
        _ = napi.napi_get_value_string_utf8(env, upath, &eng.unix_path_buf, eng.unix_path_buf.len, &copied);
        eng.unix_path = eng.unix_path_buf[0..copied];
    }
}

fn readOptUint(env: napi.Env, options: napi.Value, name: [*c]const u8) ?usize {
    var value: napi.Value = undefined;
    _ = napi.napi_get_named_property(env, options, name, &value);
    var kind: c_int = 0;
    _ = napi.napi_typeof(env, value, &kind);
    if (kind != napi.valuetype.number) return null;
    var out: u32 = 0;
    _ = napi.napi_get_value_uint32(env, value, &out);
    return out;
}

fn readOptBool(env: napi.Env, options: napi.Value, name: [*c]const u8) bool {
    var value: napi.Value = undefined;
    _ = napi.napi_get_named_property(env, options, name, &value);
    var kind: c_int = 0;
    _ = napi.napi_typeof(env, value, &kind);
    if (kind != napi.valuetype.boolean) return false;
    var out: bool = false;
    _ = napi.napi_get_value_bool(env, value, &out);
    return out;
}

/// loads { path, body, mtimeMs, cacheControl, gzip?, brotli? }[]
fn buildStaticTable(env: napi.Env, entries: napi.Value) void {
    var len: u32 = 0;
    if (napi.napi_get_array_length(env, entries, &len) != napi.ok) return;

    var scratch = std.heap.ArenaAllocator.init(alloc);
    defer scratch.deinit();
    const a = scratch.allocator();

    var i: u32 = 0;
    while (i < len) : (i += 1) {
        var entry: napi.Value = undefined;
        _ = napi.napi_get_element(env, entries, i, &entry);
        const path = readProp(env, entry, "path", a) catch continue;
        const cache_control = readProp(env, entry, "cacheControl", a) catch continue;
        const body = readBufferProp(env, entry, "body") orelse "";

        var mtime_val: napi.Value = undefined;
        _ = napi.napi_get_named_property(env, entry, "mtimeMs", &mtime_val);
        var mtime_f: f64 = 0;
        _ = napi.napi_get_value_double(env, mtime_val, &mtime_f);

        eng.static_table.putFile(
            path,
            body,
            @intFromFloat(@max(mtime_f, 0)),
            cache_control,
            readBufferProp(env, entry, "gzip"),
            readBufferProp(env, entry, "brotli"),
        ) catch {};
    }
}

fn readProp(env: napi.Env, obj: napi.Value, name: [*c]const u8, gpa: std.mem.Allocator) ![]u8 {
    var value: napi.Value = undefined;
    _ = napi.napi_get_named_property(env, obj, name, &value);
    var need: usize = 0;
    _ = napi.napi_get_value_string_utf8(env, value, null, 0, &need);
    const buf = try gpa.alloc(u8, need + 1);
    var copied: usize = 0;
    _ = napi.napi_get_value_string_utf8(env, value, buf.ptr, buf.len, &copied);
    return buf[0..copied];
}

// null when absent or empty — empty buffer is treated as not-present.
fn readBufferProp(env: napi.Env, obj: napi.Value, name: [*c]const u8) ?[]const u8 {
    var value: napi.Value = undefined;
    _ = napi.napi_get_named_property(env, obj, name, &value);
    var data: ?*anyopaque = null;
    var body_len: usize = 0;
    if (napi.napi_get_buffer_info(env, value, &data, &body_len) != napi.ok) return null;
    const ptr = data orelse return null;
    if (body_len == 0) return null;
    return @as([*]const u8, @ptrCast(ptr))[0..body_len];
}

fn readStringArray(env: napi.Env, arr: napi.Value, gpa: std.mem.Allocator) ![]const []const u8 {
    var len: u32 = 0;
    _ = napi.napi_get_array_length(env, arr, &len);
    const out = try gpa.alloc([]const u8, len);
    var i: u32 = 0;
    while (i < len) : (i += 1) {
        var el: napi.Value = undefined;
        _ = napi.napi_get_element(env, arr, i, &el);
        var need: usize = 0;
        _ = napi.napi_get_value_string_utf8(env, el, null, 0, &need);
        const buf = try gpa.alloc(u8, need + 1);
        var copied: usize = 0;
        _ = napi.napi_get_value_string_utf8(env, el, buf.ptr, buf.len, &copied);
        out[i] = buf[0..copied];
    }
    return out;
}

// closes conns stalled mid-request past the header timeout.
// filled>0 means we're mid-read; idle and awaiting conns are left alone.
fn onSweep(handle: *anyopaque) callconv(.c) void {
    _ = handle;
    const now = uv.uv_now(eng.loop.?);
    if (eng.header_timeout_ms > 0) {
        var node = eng.conn_list;
        while (node) |conn| {
            const next = conn.next; // grab before closeConn unlinks conn
            // partial plaintext request, or buffered TLS bytes mid-handshake / mid-record
            const partial = conn.filled > 0 or (if (conn.tls) |st| st.in_len > 0 else false);
            if (!conn.closing and !conn.awaiting and partial and now - conn.last_read > eng.header_timeout_ms) {
                loop.closeConn(eng.opaqueOf(&conn.tcp));
            }
            node = next;
        }
    }
    ratelimit.sweep(now);
}

/// close() — stop accepting, then close every live connection.
pub fn closeServer(env: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
    _ = info;
    if (!eng.server_closing) {
        eng.server_closing = true;
        uv.uv_close(eng.opaqueOf(&eng.listen_socket), null);
        if (eng.header_timeout_ms > 0 or ratelimit.enabled()) uv.uv_close(eng.opaqueOf(&eng.sweep_timer), null);
        ratelimit.reset();
        if (eng.unix_path != null) removeSocketFile(&eng.unix_path_buf); // don't leave the socket file behind
    }
    var node = eng.conn_list;
    while (node) |conn| {
        const next = conn.next; // grab before closeConn unlinks conn
        loop.closeConn(eng.opaqueOf(&conn.tcp));
        node = next;
    }
    return eng.undefinedValue(env);
}
