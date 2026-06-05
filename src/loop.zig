//! libuv callbacks + per-connection request pipeline. Runs on Node's JS thread.
//! Connection state lives in engine.zig; this module drives it.

const std = @import("std");
const napi = @import("napi.zig");
const uv = @import("uv.zig");
const parser = @import("parser.zig");
const router = @import("router.zig");
const response = @import("response.zig");
const request = @import("request.zig");
const static = @import("static.zig");
const ratelimit = @import("ratelimit.zig");
const eng = @import("engine.zig");

const alloc = eng.alloc;
const Conn = eng.Conn;
const Outcome = eng.Outcome;

// flush threshold: leave room so the next response can't overflow the cork
const MAX_RESPONSE = response.max_overhead + (eng.read_buf_size * 2);

pub fn onConnection(server: *anyopaque, status: c_int) callconv(.c) void {
    if (status != 0) return;
    if (eng.server_closing) return;
    const conn = eng.conn_pool.create(alloc) catch return;
    conn.* = .{
        .tcp = undefined,
        .read_buf = undefined,
        .overflow = null,
        .filled = 0,
        .awaiting = false,
        .reading = false,
        .closing = false,
        .dispatch_id = 0,
        .pending_consume = 0,
        .pending_keep_alive = true,
        .pending_is_head = false,
        .last_read = uv.uv_now(eng.loop.?),
        .queued_bytes = 0,
        .peer_ip = [_]u8{0} ** 46,
        .next = null,
        .prev = null,
    };
    if (eng.unix_path != null) {
        _ = uv.uv_pipe_init(eng.loop.?, eng.opaqueOf(&conn.tcp), 0);
    } else {
        _ = uv.uv_tcp_init(eng.loop.?, eng.opaqueOf(&conn.tcp));
    }
    eng.addConn(conn);
    if (uv.uv_accept(server, eng.opaqueOf(&conn.tcp)) != 0) {
        closeConn(eng.opaqueOf(&conn.tcp));
        return;
    }
    // TCP-only: Nagle off + peer ip. A unix socket has no peer ip (req.ip stays "").
    if (eng.unix_path == null) {
        _ = uv.uv_tcp_nodelay(eng.opaqueOf(&conn.tcp), 1);
        recordPeerIp(conn);
    }
    armRead(conn);
}

// peer ip captured once at accept, for req.ip
fn recordPeerIp(conn: *Conn) void {
    var storage: [128]u8 align(8) = undefined;
    var namelen: c_int = storage.len;
    if (uv.uv_tcp_getpeername(eng.opaqueOf(&conn.tcp), &storage, &namelen) == 0) {
        _ = uv.uv_ip_name(&storage, &conn.peer_ip, conn.peer_ip.len);
    }
}

fn allocBuf(handle: *anyopaque, suggested: usize, buf: *uv.Buf) callconv(.c) void {
    _ = suggested;
    const conn: *Conn = @ptrCast(@alignCast(handle));
    // hand libuv the unused tail so a partial request already in the buffer survives
    const active = eng.activeBuf(conn);
    buf.* = .{ .base = @ptrCast(active[conn.filled..].ptr), .len = @intCast(active.len - conn.filled) };
}

fn onRead(stream: *anyopaque, nread: isize, buf: *const uv.Buf) callconv(.c) void {
    _ = buf;
    if (nread <= 0) {
        closeConn(stream); // EOF or error
        return;
    }
    const conn: *Conn = @ptrCast(@alignCast(stream));
    conn.filled += @intCast(nread);
    conn.last_read = uv.uv_now(eng.loop.?);
    drain(stream, conn);
}

/// Process buffered requests, corking sync responses into one write. An async
/// (Promise) handler suspends: earlier responses flush, read stops, and
/// submitResponse resumes the drain later.
pub fn drain(stream: *anyopaque, conn: *Conn) void {
    const env = eng.env;
    var scope: napi.HandleScope = undefined;
    _ = napi.napi_open_handle_scope(env, &scope);
    defer _ = napi.napi_close_handle_scope(env, scope);

    var undef: napi.Value = undefined;
    _ = napi.napi_get_undefined(env, &undef);
    var dispatch_fn: napi.Value = undefined;
    _ = napi.napi_get_reference_value(env, eng.dispatch_ref, &dispatch_fn);

    var off: usize = 0;
    var keep_alive = true;

    while (true) {
        const view = eng.activeBuf(conn)[0..conn.filled];
        const head_end = parser.findHeadEnd(view, 0) orelse {
            // no terminator yet; but a full inline buffer means the head won't fit -> 400
            if (conn.overflow == null and conn.filled == eng.read_buf_size) {
                off += response.renderError(eng.cork[off..], .bad_request, null, false);
                keep_alive = false;
                eng.resetConn(conn);
            }
            break;
        };

        const head = parser.parse(view[0..head_end], eng.max_headers) catch {
            off += response.renderError(eng.cork[off..], .bad_request, null, false);
            keep_alive = false;
            eng.resetConn(conn);
            break;
        };

        const total = head_end +| head.content_length; // saturate so a bogus Content-Length can't wrap
        if (head.content_length > eng.max_body) {
            off += response.renderError(eng.cork[off..], .payload_too_large, null, false);
            keep_alive = false;
            eng.resetConn(conn);
            break;
        }
        // body bigger than the inline buffer spills to a heap buffer sized to it
        if (total > eng.activeBuf(conn).len) {
            if (!eng.growForBody(conn, total)) {
                off += response.renderError(eng.cork[off..], .payload_too_large, null, false);
                keep_alive = false;
                eng.resetConn(conn);
                break;
            }
            break; // rest of body arrives on the next read
        }
        if (conn.filled < total) break; // body still arriving

        if (eng.cork.len - off < MAX_RESPONSE) {
            writeAll(stream, eng.cork[0..off]);
            off = 0;
        }
        if (!head.keep_alive) keep_alive = false;

        const body: ?[]const u8 = if (head.content_length > 0) view[head_end..total] else null;
        const ip = std.mem.sliceTo(&conn.peer_ip, 0);
        // native 429 before the request ever reaches JS
        if (ratelimit.enabled() and ratelimit.exceeded(ip, conn.last_read)) {
            const retry = ratelimit.retryAfterSeconds(ip, conn.last_read);
            off += response.renderRateLimited(eng.cork[off..], retry, head.keep_alive);
            eng.finishRequest(conn, total);
            if (conn.filled == 0) break;
            continue;
        }
        var sc: router.Scratch = .{};
        switch (eng.routes.resolve(head.method, head.path, &sc)) {
            .found => |f| {
                if (dispatchAndEmit(stream, conn, &off, env, undef, dispatch_fn, ip, &head, body, f, total)) return;
            },
            .method_not_allowed => |allow| {
                off += response.renderError(eng.cork[off..], .method_not_allowed, allow, head.keep_alive);
            },
            .not_found => {
                if (staticEntry(&head)) |entry| {
                    // body goes straight from the table (bypasses cork), so flush cork first to keep order
                    if (off > 0) {
                        writeAll(stream, eng.cork[0..off]);
                        off = 0;
                    }
                    serveStaticDirect(stream, entry, &head);
                } else if (eng.not_found_dispatch) {
                    // no route, no static file -> hand off to the JS not-found handler
                    const f = router.Found{ .index = eng.not_found_index, .params = &.{} };
                    if (dispatchAndEmit(stream, conn, &off, env, undef, dispatch_fn, ip, &head, body, f, total)) return;
                } else {
                    off += response.renderError(eng.cork[off..], .not_found, null, head.keep_alive);
                }
            },
        }

        eng.finishRequest(conn, total);
        if (conn.filled == 0) break;
    }

    if (off > 0) writeAll(stream, eng.cork[0..off]);
    if (!keep_alive) closeConn(stream);
}

/// Dispatch to JS: frame the sync response into the cork, or suspend for an async
/// handler. Returns true when suspended — caller must then return from drain,
/// leaving the request buffered for submitResponse.
fn dispatchAndEmit(stream: *anyopaque, conn: *Conn, off: *usize, env: napi.Env, undef: napi.Value, dispatch_fn: napi.Value, ip: []const u8, head: *const parser.ParsedHead, body: ?[]const u8, match: router.Found, total: usize) bool {
    const id = eng.nextId();
    switch (dispatchFound(env, undef, dispatch_fn, ip, head, body, id, match)) {
        .sync => |r| {
            emitResponse(stream, off, r.status, r.headers, r.body, head.keep_alive, isHead(head));
            return false;
        },
        .awaiting => {
            // flush earlier responses, then suspend. the awaited request stays
            // in the buffer so head.body's view into it survives the await.
            if (off.* > 0) writeAll(stream, eng.cork[0..off.*]);
            conn.awaiting = true;
            conn.dispatch_id = id;
            conn.pending_consume = total;
            conn.pending_keep_alive = head.keep_alive;
            conn.pending_is_head = isHead(head);
            eng.pending.put(alloc, id, conn) catch {};
            stopRead(conn);
            return true;
        },
    }
}

// returns a sync response, or .awaiting when the handler went async (it'll call submitResponse)
fn dispatchFound(env: napi.Env, undef: napi.Value, dispatch_fn: napi.Value, ip: []const u8, head: *const parser.ParsedHead, body: ?[]const u8, id: u32, match: router.Found) Outcome {
    const req = request.build(env, head, body, match.index, id, ip, match.params);
    const args = [_]napi.Value{req};
    var result: napi.Value = undefined;
    if (napi.napi_call_function(env, undef, dispatch_fn, 1, &args, &result) != napi.ok) {
        var ex: napi.Value = undefined;
        _ = napi.napi_get_and_clear_last_exception(env, &ex);
        return .{ .sync = .{ .status = 500, .headers = "Content-Type: text/plain; charset=utf-8\r\n", .body = "Internal Server Error" } };
    }
    // object = sync response; undefined = went async
    var kind: c_int = 0;
    _ = napi.napi_typeof(env, result, &kind);
    if (kind != napi.valuetype.object) return .awaiting;

    return .{ .sync = readJsResponse(env, result) };
}

// Buffer body is used zero-copy; a string body is read into the grown response buffer
fn readJsResponse(env: napi.Env, value: napi.Value) request.Response {
    const meta = request.readMeta(env, value, &eng.headers_scratch);
    if (request.bufferBody(env, meta.body_value)) |bytes| {
        return .{ .status = meta.status, .headers = meta.headers, .body = bytes };
    }
    const buffer = eng.ensureRespBody(request.bodyLen(env, meta.body_value));
    return .{ .status = meta.status, .headers = meta.headers, .body = request.readStringBody(env, meta.body_value, buffer) };
}

// frame into the cork at off; if it won't fit, flush the cork and write head+body
// straight out (handles bodies larger than the cork). a HEAD response carries the
// would-be Content-Length but no body bytes (RFC 9110 §9.3.2) — sending them would
// desync keep-alive framing.
fn emitResponse(stream: *anyopaque, off: *usize, status: u16, headers: []const u8, body: []const u8, keep_alive: bool, is_head: bool) void {
    if (is_head) {
        if (response.max_overhead +| headers.len > eng.cork_size - off.*) {
            writeAll(stream, eng.cork[0..off.*]);
            off.* = 0;
        }
        off.* += response.serializeHead(eng.cork[off.*..], status, headers, body.len, keep_alive);
        return;
    }
    const needed = response.max_overhead +| headers.len +| body.len;
    if (needed <= eng.cork_size - off.*) {
        off.* += response.serializeInto(eng.cork[off.*..], status, headers, body, keep_alive);
        return;
    }
    if (off.* > 0) {
        writeAll(stream, eng.cork[0..off.*]);
        off.* = 0;
    }
    const head_len = response.serializeHead(eng.cork[0..], status, headers, body.len, keep_alive);
    writeAll(stream, eng.cork[0..head_len]);
    if (body.len > 0) writeAll(stream, body);
}

inline fn isHead(head: *const parser.ParsedHead) bool {
    return std.mem.eql(u8, head.method, "HEAD");
}

// static entry for head, only on GET/HEAD
fn staticEntry(head: *const parser.ParsedHead) ?static.Entry {
    if (eng.static_table.isEmpty()) return null;
    if (!std.mem.eql(u8, head.method, "GET") and !std.mem.eql(u8, head.method, "HEAD")) return null;
    return eng.static_table.get(head.path);
}

// head bytes, then body straight from the table — never through the cork
fn serveStaticDirect(stream: *anyopaque, entry: static.Entry, head: *const parser.ParsedHead) void {
    var head_buf: [2048]u8 = undefined;
    const is_head = std.mem.eql(u8, head.method, "HEAD");
    const rendered = static.render(&head_buf, entry, head.accept_encoding, head.if_none_match, is_head, head.keep_alive);
    writeAll(stream, head_buf[0..rendered.head_len]);
    if (rendered.body.len > 0) writeAll(stream, rendered.body);
}

/// submitResponse(dispatchId, response) — completes an async handler: write the
/// response and resume the connection's drain. Stale/closed id is a no-op.
pub fn submitResponse(env: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
    var argc: usize = 2;
    var argv: [2]napi.Value = undefined;
    _ = napi.napi_get_cb_info(env, info, &argc, &argv, null, null);

    var id: u32 = 0;
    _ = napi.napi_get_value_uint32(env, argv[0], &id);

    const conn = eng.pending.get(id) orelse return eng.undefinedValue(env); // stale id
    _ = eng.pending.remove(id);
    if (conn.closing) return eng.undefinedValue(env);
    conn.awaiting = false;

    const r = readJsResponse(env, argv[1]);
    var off: usize = 0;
    emitResponse(eng.opaqueOf(&conn.tcp), &off, r.status, r.headers, r.body, conn.pending_keep_alive, conn.pending_is_head);
    if (off > 0) writeAll(eng.opaqueOf(&conn.tcp), eng.cork[0..off]);

    eng.finishRequest(conn, conn.pending_consume);
    if (conn.pending_keep_alive) {
        armRead(conn);
        drain(eng.opaqueOf(&conn.tcp), conn); // drain any pipelined remainder
    } else {
        closeConn(eng.opaqueOf(&conn.tcp));
    }
    return eng.undefinedValue(env);
}

pub fn armRead(conn: *Conn) void {
    if (conn.reading or conn.closing) return;
    _ = uv.uv_read_start(eng.opaqueOf(&conn.tcp), &allocBuf, &onRead);
    conn.reading = true;
}

fn stopRead(conn: *Conn) void {
    if (!conn.reading) return;
    _ = uv.uv_read_stop(eng.opaqueOf(&conn.tcp));
    conn.reading = false;
}

pub fn closeConn(stream: *anyopaque) void {
    const conn: *Conn = @ptrCast(@alignCast(stream));
    if (conn.closing) return;
    conn.closing = true;
    uv.uv_close(stream, &onClose);
}

// fast path: one synchronous uv_try_write, zero heap. only a short write falls
// back to a queued uv_write of the unsent tail.
pub fn writeAll(stream: *anyopaque, bytes: []const u8) void {
    var b = uv.Buf{ .base = @ptrCast(@constCast(bytes.ptr)), .len = @intCast(bytes.len) };
    const rc = uv.uv_try_write(stream, @ptrCast(&b), 1);
    const written: usize = if (rc > 0) @intCast(rc) else 0;
    if (written == bytes.len) return;
    queueTail(stream, bytes[written..]);
}

// cold path: socket buffer full. dup the unsent tail and queue it, charging the
// bytes to the conn's backpressure counter until onWrite fires.
fn queueTail(stream: *anyopaque, tail: []const u8) void {
    const wire = alloc.dupe(u8, tail) catch return;
    const wr = alloc.create(eng.WriteReq) catch {
        alloc.free(wire);
        return;
    };
    const conn: *Conn = @ptrCast(@alignCast(stream));
    wr.body = wire;
    wr.conn = conn;
    conn.queued_bytes +|= wire.len;
    var b = uv.Buf{ .base = @ptrCast(wire.ptr), .len = @intCast(wire.len) };
    if (uv.uv_write(eng.opaqueOf(&wr.req), stream, @ptrCast(&b), 1, &onWrite) != 0) {
        conn.queued_bytes -|= wire.len;
        alloc.free(wr.body);
        alloc.destroy(wr);
    }
}

// libuv fires write callbacks before the handle's close callback, so wr.conn is
// still live here even when the write was cancelled by a close.
fn onWrite(req: *anyopaque, status: c_int) callconv(.c) void {
    _ = status;
    const wr: *eng.WriteReq = @ptrCast(@alignCast(req));
    if (wr.conn) |conn| conn.queued_bytes -|= wr.body.len;
    alloc.free(wr.body);
    alloc.destroy(wr);
}

fn onClose(handle: *anyopaque) callconv(.c) void {
    const conn: *Conn = @ptrCast(@alignCast(handle));
    // drop any pending entry so a late submitResponse can't touch freed memory
    if (conn.awaiting) _ = eng.pending.remove(conn.dispatch_id);
    if (conn.overflow) |buffer| alloc.free(buffer);
    eng.removeConn(conn);
    eng.conn_pool.destroy(conn);
}
