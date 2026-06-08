//! Raw TCP server on Node's libuv loop. No HTTP, no parsing — accept a connection,
//! hand each read straight to JS as a zero-copy buffer, and write back with the same
//! try-write-then-queue backpressure the HTTP path uses. One server per process.
//!
//! Memory: a connection is just its uv handle plus a few fields (no per-conn read
//! buffer — reads land in a shared scratch and are forwarded synchronously), so a
//! million idle sockets cost about what the kernel charges, not megabytes of our own.

const std = @import("std");
const napi = @import("../ffi/napi.zig");
const uv = @import("../ffi/uv.zig");
const addr = @import("addr.zig");

const alloc = std.heap.c_allocator;

// event tags handed to the JS dispatcher, matched in ts/net/tcp.ts
const ev_connection: u32 = 0;
const ev_data: u32 = 1;
const ev_drain: u32 = 2;
const ev_close: u32 = 3;

// uv handle leads so a *handle is the same address as the *Conn (libuv keeps `data`
// at offset 0; we recover the Conn by plain cast, never by touching a field).
const Conn = struct {
    handle: [uv.tcp_size]u8 align(16),
    id: u32,
    queued_bytes: usize,
    closing: bool,
    reading: bool,
    // peer half-closed (we got EOF): stop reading, but keep flushing our queued writes,
    // then close — a uv_close now would cancel them and truncate the response.
    read_ended: bool,
    remote_port: u16,
    remote_ip: [46]u8, // null-terminated; "" for an address we couldn't read
    next: ?*Conn,
    prev: ?*Conn,
};

const WriteReq = struct {
    req: [uv.write_size]u8 align(16),
    body: []u8,
    conn: ?*Conn,
};

const ShutdownReq = struct {
    req: [uv.shutdown_size]u8 align(16),
    conn: *Conn,
};

const read_scratch_size = 64 * 1024;

var env: napi.Env = null;
var loop: ?*anyopaque = null;
var dispatch_ref: napi.Ref = null;
var server: [uv.tcp_size]u8 align(16) = undefined;
var listening = false;
var closing = false;
var no_delay = true;

var pool: std.heap.MemoryPool(Conn) = .empty;
var write_pool: std.heap.MemoryPool(WriteReq) = .empty;
var conns: std.AutoHashMapUnmanaged(u32, *Conn) = .empty;
var conn_list: ?*Conn = null;
var next_id: u32 = 1;

// shared by every connection's reads; a read is forwarded to JS before the next one runs.
var read_scratch: [read_scratch_size]u8 = undefined;

fn opaqueOf(p: anytype) *anyopaque {
    return @ptrCast(p);
}

fn nextId() u32 {
    const id = next_id;
    next_id +%= 1;
    if (next_id == 0) next_id = 1;
    return id;
}

// tcpListen(port, host, options, dispatch) -> bound port (0 on bind failure, after throwing)
pub fn listen(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
    var argc: usize = 4;
    var argv: [4]napi.Value = undefined;
    _ = napi.napi_get_cb_info(e, info, &argc, &argv, null, null);

    env = e;
    _ = napi.napi_get_uv_event_loop(e, &loop);

    // a close from a previous server is still draining on the loop — the handle block
    // can't be re-initialized until its close callback fires.
    if (closing) {
        _ = napi.napi_throw_error(e, null, "toki: the previous TCP server is still closing");
        return uintValue(e, 0);
    }

    var port: i32 = 0;
    _ = napi.napi_get_value_int32(e, argv[0], &port);

    var host: [256]u8 = .{ '0', '.', '0', '.', '0', '.', '0' } ++ .{0} ** 249;
    var copied: usize = 0;
    _ = napi.napi_get_value_string_utf8(e, argv[1], &host, host.len, &copied);

    var bind_flags: c_uint = 0;
    if (optBool(e, argv[2], "reusePort")) bind_flags = 2; // UV_TCP_REUSEPORT
    no_delay = !optBoolDefaultFalse(e, argv[2], "noDelay", false);
    const backlog: c_int = optInt(e, argv[2], "backlog") orelse 512;

    _ = napi.napi_create_reference(e, argv[3], 1, &dispatch_ref);

    _ = uv.uv_tcp_init(loop.?, opaqueOf(&server));
    // sockaddr_storage-sized: an IPv6 sockaddr is larger than SockaddrIn.
    var sa: [128]u8 align(8) = undefined;
    if (!addr.parse(&host, copied, port, &sa)) {
        _ = napi.napi_throw_error(e, null, "tcp: invalid bind address");
        return uintValue(e, 0);
    }
    const bind_rc = uv.uv_tcp_bind(opaqueOf(&server), opaqueOf(&sa), bind_flags);
    if (bind_rc != 0) {
        _ = napi.napi_throw_error(e, null, uv.uv_strerror(bind_rc));
        return uintValue(e, 0);
    }
    const rc = uv.uv_listen(opaqueOf(&server), backlog, &onConnection);
    if (rc != 0) {
        _ = napi.napi_throw_error(e, null, uv.uv_strerror(rc));
        return uintValue(e, 0);
    }
    listening = true;

    var bound: [128]u8 align(8) = undefined;
    var blen: c_int = bound.len;
    var bound_port: u16 = 0;
    if (uv.uv_tcp_getsockname(opaqueOf(&server), opaqueOf(&bound), &blen) == 0) {
        bound_port = addr.portOf(&bound);
    }
    return uintValue(e, bound_port);
}

fn onConnection(srv: *anyopaque, status: c_int) callconv(.c) void {
    if (status != 0 or closing) return;
    const conn = pool.create(alloc) catch return;
    conn.* = .{
        .handle = undefined,
        .id = nextId(),
        .queued_bytes = 0,
        .closing = false,
        .reading = false,
        .read_ended = false,
        .remote_port = 0,
        .remote_ip = [_]u8{0} ** 46,
        .next = null,
        .prev = null,
    };
    _ = uv.uv_tcp_init(loop.?, opaqueOf(&conn.handle));
    addConn(conn);
    if (uv.uv_accept(srv, opaqueOf(&conn.handle)) != 0) {
        closeConn(conn);
        return;
    }
    if (no_delay) _ = uv.uv_tcp_nodelay(opaqueOf(&conn.handle), 1);
    recordPeer(conn);
    conns.put(alloc, conn.id, conn) catch {
        closeConn(conn);
        return;
    };

    var scope: napi.HandleScope = undefined;
    _ = napi.napi_open_handle_scope(env, &scope);
    defer _ = napi.napi_close_handle_scope(env, scope);
    dispatch(conn.id, ev_connection, remoteInfo(conn));

    armRead(conn);
}

fn recordPeer(conn: *Conn) void {
    var storage: [128]u8 align(8) = undefined;
    var namelen: c_int = storage.len;
    if (uv.uv_tcp_getpeername(opaqueOf(&conn.handle), &storage, &namelen) != 0) return;
    addr.name(&storage, &conn.remote_ip);
    conn.remote_port = addr.portOf(&storage);
}

fn remoteInfo(conn: *Conn) napi.Value {
    var obj: napi.Value = undefined;
    _ = napi.napi_create_object(env, &obj);
    const ip = std.mem.sliceTo(&conn.remote_ip, 0);
    var addr_val: napi.Value = undefined;
    _ = napi.napi_create_string_utf8(env, ip.ptr, ip.len, &addr_val);
    _ = napi.napi_set_named_property(env, obj, "address", addr_val);
    var port_val: napi.Value = undefined;
    _ = napi.napi_create_uint32(env, conn.remote_port, &port_val);
    _ = napi.napi_set_named_property(env, obj, "port", port_val);
    return obj;
}

fn armRead(conn: *Conn) void {
    if (conn.reading or conn.closing) return;
    _ = uv.uv_read_start(opaqueOf(&conn.handle), &allocBuf, &onRead);
    conn.reading = true;
}

fn allocBuf(handle: *anyopaque, suggested: usize, buf: *uv.Buf) callconv(.c) void {
    _ = handle;
    _ = suggested;
    buf.* = .{ .base = @ptrCast(&read_scratch), .len = @intCast(read_scratch.len) };
}

fn onRead(stream: *anyopaque, nread: isize, buf: *const uv.Buf) callconv(.c) void {
    _ = buf;
    const conn: *Conn = @ptrCast(@alignCast(stream));
    // nread == 0 is EAGAIN, not EOF — closing here would cancel an in-flight queued
    // write (uv_close aborts pending uv_write). Only nread < 0 means the read side ended.
    if (nread == 0) return;
    if (nread < 0) {
        // peer half-closed: drain our queued writes first, then close (onWrite finishes
        // the close once the backlog clears). Close now only when nothing is pending.
        conn.read_ended = true;
        if (conn.reading) {
            _ = uv.uv_read_stop(opaqueOf(&conn.handle));
            conn.reading = false;
        }
        if (conn.queued_bytes == 0) closeConn(conn);
        return;
    }
    var scope: napi.HandleScope = undefined;
    _ = napi.napi_open_handle_scope(env, &scope);
    defer _ = napi.napi_close_handle_scope(env, scope);

    // copy into a V8-owned Buffer so a handler may keep it past this synchronous dispatch
    // (the shared scratch is reused by the next read).
    var data_val: napi.Value = undefined;
    _ = napi.napi_create_buffer_copy(env, @intCast(nread), &read_scratch, null, &data_val);
    dispatch(conn.id, ev_data, data_val);
}

// --- write path (shared invariant: once anything is queued, everything queues so a
//     fast uv_try_write can never reorder ahead of the FIFO write queue) ------------

fn writeAll(conn: *Conn, bytes: []const u8) void {
    if (conn.closing) return;
    if (conn.queued_bytes != 0) {
        queueTail(conn, bytes);
        return;
    }
    var b = uv.Buf{ .base = @ptrCast(@constCast(bytes.ptr)), .len = @intCast(bytes.len) };
    const rc = uv.uv_try_write(opaqueOf(&conn.handle), @ptrCast(&b), 1);
    const written: usize = if (rc > 0) @intCast(rc) else 0;
    if (written == bytes.len) return;
    queueTail(conn, bytes[written..]);
}

fn queueTail(conn: *Conn, tail: []const u8) void {
    const wire = alloc.dupe(u8, tail) catch return;
    const wr = write_pool.create(alloc) catch {
        alloc.free(wire);
        return;
    };
    wr.body = wire;
    wr.conn = conn;
    conn.queued_bytes +|= wire.len;
    var b = uv.Buf{ .base = @ptrCast(wire.ptr), .len = @intCast(wire.len) };
    if (uv.uv_write(opaqueOf(&wr.req), opaqueOf(&conn.handle), @ptrCast(&b), 1, &onWrite) != 0) {
        conn.queued_bytes -|= wire.len;
        alloc.free(wr.body);
        write_pool.destroy(wr);
    }
}

fn onWrite(req: *anyopaque, status: c_int) callconv(.c) void {
    _ = status;
    const wr: *WriteReq = @ptrCast(@alignCast(req));
    if (wr.conn) |conn| {
        conn.queued_bytes -|= wr.body.len;
        if (!conn.closing and conn.queued_bytes == 0) {
            // the backlog cleared: if the peer already half-closed, finish the close now
            // that everything has flushed; otherwise tell the producer it can resume.
            if (conn.read_ended) {
                closeConn(conn);
            } else {
                var scope: napi.HandleScope = undefined;
                _ = napi.napi_open_handle_scope(env, &scope);
                defer _ = napi.napi_close_handle_scope(env, scope);
                dispatch(conn.id, ev_drain, undefinedValue());
            }
        }
    }
    alloc.free(wr.body);
    write_pool.destroy(wr);
}

// tcpSend(id, buffer) -> queued backlog bytes (0 when flushed); 0 for an unknown id.
pub fn send(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
    var argc: usize = 2;
    var argv: [2]napi.Value = undefined;
    _ = napi.napi_get_cb_info(e, info, &argc, &argv, null, null);

    var id: u32 = 0;
    _ = napi.napi_get_value_uint32(e, argv[0], &id);
    var data: ?*anyopaque = null;
    var len: usize = 0;
    _ = napi.napi_get_buffer_info(e, argv[1], &data, &len);

    const conn = conns.get(id) orelse return uintValue(e, 0);
    if (data) |d| if (len != 0) writeAll(conn, @as([*]const u8, @ptrCast(d))[0..len]);
    return uintValue(e, @intCast(@min(conn.queued_bytes, std.math.maxInt(u32))));
}

// tcpEnd(id) — half-close: flush queued writes, then send FIN. The peer reads the rest,
// then sees EOF; onClose still fires when the socket finally goes away.
pub fn end(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
    var argc: usize = 1;
    var argv: [1]napi.Value = undefined;
    _ = napi.napi_get_cb_info(e, info, &argc, &argv, null, null);
    var id: u32 = 0;
    _ = napi.napi_get_value_uint32(e, argv[0], &id);

    const conn = conns.get(id) orelse return undefinedValue();
    if (conn.closing) return undefinedValue();
    const sr = alloc.create(ShutdownReq) catch {
        closeConn(conn);
        return undefinedValue();
    };
    sr.conn = conn;
    if (uv.uv_shutdown(opaqueOf(&sr.req), opaqueOf(&conn.handle), &onShutdown) != 0) {
        alloc.destroy(sr);
        closeConn(conn);
    }
    return undefinedValue();
}

fn onShutdown(req: *anyopaque, status: c_int) callconv(.c) void {
    _ = status;
    const sr: *ShutdownReq = @ptrCast(@alignCast(req));
    const conn = sr.conn;
    alloc.destroy(sr);
    closeConn(conn);
}

// tcpClose(id) — drop a connection now (RST/FIN, no flush guarantee).
pub fn closeSocket(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
    var argc: usize = 1;
    var argv: [1]napi.Value = undefined;
    _ = napi.napi_get_cb_info(e, info, &argc, &argv, null, null);
    var id: u32 = 0;
    _ = napi.napi_get_value_uint32(e, argv[0], &id);
    if (conns.get(id)) |conn| closeConn(conn);
    return undefinedValue();
}

fn closeConn(conn: *Conn) void {
    if (conn.closing) return;
    conn.closing = true;
    if (conn.reading) {
        _ = uv.uv_read_stop(opaqueOf(&conn.handle));
        conn.reading = false;
    }
    uv.uv_close(opaqueOf(&conn.handle), &onClose);
}

fn onClose(handle: *anyopaque) callconv(.c) void {
    const conn: *Conn = @ptrCast(@alignCast(handle));
    _ = conns.remove(conn.id);
    removeConn(conn);

    var scope: napi.HandleScope = undefined;
    _ = napi.napi_open_handle_scope(env, &scope);
    defer _ = napi.napi_close_handle_scope(env, scope);
    dispatch(conn.id, ev_close, undefinedValue());

    pool.destroy(conn);
}

// tcpCloseServer() — stop accepting, then close every live connection.
pub fn closeServer(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
    _ = e;
    _ = info;
    if (listening and !closing) {
        closing = true; // stays set until onServerClose fires, blocking a racing re-listen
        listening = false;
        uv.uv_close(opaqueOf(&server), &onServerClose);
    }
    var node = conn_list;
    while (node) |conn| {
        const nxt = conn.next; // grab before closeConn unlinks conn
        closeConn(conn);
        node = nxt;
    }
    return undefinedValue();
}

// the server handle block is free to be re-initialized by a later listen() only once
// libuv has finished closing it.
fn onServerClose(handle: *anyopaque) callconv(.c) void {
    _ = handle;
    closing = false;
}

fn dispatch(id: u32, event: u32, arg: napi.Value) void {
    if (dispatch_ref == null) return;
    var fn_val: napi.Value = undefined;
    if (napi.napi_get_reference_value(env, dispatch_ref, &fn_val) != napi.ok) return;
    var undef: napi.Value = undefined;
    _ = napi.napi_get_undefined(env, &undef);
    var id_val: napi.Value = undefined;
    _ = napi.napi_create_uint32(env, id, &id_val);
    var ev_val: napi.Value = undefined;
    _ = napi.napi_create_uint32(env, event, &ev_val);
    const args = [_]napi.Value{ id_val, ev_val, arg };
    var result: napi.Value = undefined;
    if (napi.napi_call_function(env, undef, fn_val, 3, &args, &result) != napi.ok) {
        var ex: napi.Value = undefined;
        _ = napi.napi_get_and_clear_last_exception(env, &ex); // one bad handler can't kill the loop
    }
}

// --- intrusive list, for closeServer's sweep --------------------------------------

fn addConn(conn: *Conn) void {
    conn.prev = null;
    conn.next = conn_list;
    if (conn_list) |head| head.prev = conn;
    conn_list = conn;
}

fn removeConn(conn: *Conn) void {
    if (conn.prev) |p| p.next = conn.next else conn_list = conn.next;
    if (conn.next) |n| n.prev = conn.prev;
}

// --- small napi helpers ------------------------------------------------------------

fn undefinedValue() napi.Value {
    var undef: napi.Value = undefined;
    _ = napi.napi_get_undefined(env, &undef);
    return undef;
}

fn uintValue(e: napi.Env, v: u32) napi.Value {
    var out: napi.Value = undefined;
    _ = napi.napi_create_uint32(e, v, &out);
    return out;
}

fn optBool(e: napi.Env, options: napi.Value, name: [*c]const u8) bool {
    return optBoolDefaultFalse(e, options, name, false);
}

fn optBoolDefaultFalse(e: napi.Env, options: napi.Value, name: [*c]const u8, default: bool) bool {
    var value: napi.Value = undefined;
    _ = napi.napi_get_named_property(e, options, name, &value);
    var kind: c_int = 0;
    _ = napi.napi_typeof(e, value, &kind);
    if (kind != napi.valuetype.boolean) return default;
    var out: bool = false;
    _ = napi.napi_get_value_bool(e, value, &out);
    return out;
}

fn optInt(e: napi.Env, options: napi.Value, name: [*c]const u8) ?c_int {
    var value: napi.Value = undefined;
    _ = napi.napi_get_named_property(e, options, name, &value);
    var kind: c_int = 0;
    _ = napi.napi_typeof(e, value, &kind);
    if (kind != napi.valuetype.number) return null;
    var out: i32 = 0;
    _ = napi.napi_get_value_int32(e, value, &out);
    return @intCast(out);
}
