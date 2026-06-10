//! libuv callbacks + per-connection request pipeline. Runs on Node's JS thread.
//! Connection state lives in engine.zig; this module drives it.

const std = @import("std");
const napi = @import("../ffi/napi.zig");
const uv = @import("../ffi/uv.zig");
const parser = @import("../http/parser.zig");
const router = @import("../http/router.zig");
const response = @import("../http/response.zig");
const request = @import("../http/request.zig");
const static = @import("../http/static.zig");
const ratelimit = @import("../security/ratelimit.zig");
const websocket = @import("../websocket/session.zig");
const tlsmod = @import("../tls/tls.zig");
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
        .ip_ref = null,
        .is_ws = false,
        .ws_id = 0,
        .ws_frag = null,
        .ws_frag_len = 0,
        .ws_frag_opcode = 0,
        .ws_close_code = 1006,
        .ws_close_reason = undefined,
        .ws_close_reason_len = 0,
        .ws_deflate = false,
        .ws_msg_compressed = false,
        .tls = null,
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
    // HTTPS: every connection starts a TLS handshake before any HTTP is seen. HTTPS never
    // enables client_auth, so now_sec is unused here, but pass real time anyway (correct if
    // mTLS is ever added to this path).
    if (tlsmod.enabled()) {
        var tv: uv.TimeVal64 = undefined;
        const now_sec: i64 = if (uv.uv_gettimeofday(&tv) == 0) tv.tv_sec else 0;
        conn.tls = tlsmod.newState(alloc, now_sec) orelse {
            closeConn(eng.opaqueOf(&conn.tcp));
            return;
        };
    }
    armRead(conn);
}

// peer ip captured once at accept, for req.ip. Build the V8 string here and pin it
// with a reference so every request on this connection reuses it instead of re-encoding.
fn recordPeerIp(conn: *Conn) void {
    var storage: [128]u8 align(8) = undefined;
    var namelen: c_int = storage.len;
    if (uv.uv_tcp_getpeername(eng.opaqueOf(&conn.tcp), &storage, &namelen) != 0) return;
    _ = uv.uv_ip_name(&storage, &conn.peer_ip, conn.peer_ip.len);
    if (conn.peer_ip[0] == 0) return;

    // onConnection has no open handle scope; one is needed to create the value before
    // the reference makes it persistent.
    const env = eng.env;
    var scope: napi.HandleScope = undefined;
    _ = napi.napi_open_handle_scope(env, &scope);
    defer _ = napi.napi_close_handle_scope(env, scope);
    const ip = std.mem.sliceTo(&conn.peer_ip, 0);
    var ip_val: napi.Value = undefined;
    _ = napi.napi_create_string_utf8(env, ip.ptr, ip.len, &ip_val);
    _ = napi.napi_create_reference(env, ip_val, 1, &conn.ip_ref);
}

fn allocBuf(handle: *anyopaque, suggested: usize, buf: *uv.Buf) callconv(.c) void {
    _ = suggested;
    const conn: *Conn = @ptrCast(@alignCast(handle));
    // TLS reads ciphertext into st.in; plain reads plaintext into the conn buffer.
    // either way hand libuv the unused tail so a buffered partial survives.
    if (conn.tls) |st| {
        const tail = st.in[st.in_len..];
        buf.* = .{ .base = @ptrCast(tail.ptr), .len = @intCast(tail.len) };
        return;
    }
    const active = eng.activeBuf(conn);
    buf.* = .{ .base = @ptrCast(active[conn.filled..].ptr), .len = @intCast(active.len - conn.filled) };
}

fn onRead(stream: *anyopaque, nread: isize, buf: *const uv.Buf) callconv(.c) void {
    _ = buf;
    // nread == 0 is EAGAIN, not EOF: no data right now, the read callback just
    // fired spuriously. Closing here would cancel any in-flight queued write
    // (uv_close aborts pending uv_write with UV_ECANCELED), dropping a frame mid
    // backpressure. Only a negative nread (UV_EOF / error) means the peer is gone.
    if (nread == 0) return;
    if (nread < 0) {
        closeConn(stream); // EOF or error
        return;
    }
    const conn: *Conn = @ptrCast(@alignCast(stream));
    conn.last_read = uv.uv_now(eng.loop.?);
    if (conn.tls) |st| {
        st.in_len += @intCast(nread);
        tlsDrive(stream, conn, st);
        return;
    }
    conn.filled += @intCast(nread);
    if (conn.is_ws) websocket.onData(conn) else drain(stream, conn);
}

// finish the handshake, then decrypt buffered records straight into the plaintext
// buffer and run the normal HTTP/WS pipeline on them. records decrypt in place, so if
// an async handler suspends, undecrypted records stay in st.in and are picked up on
// resume. nothing is stranded.
fn tlsDrive(stream: *anyopaque, conn: *Conn, st: *tlsmod.State) void {
    if (!st.established) {
        const h = tlsmod.handshake(st, eng.tls_out[0..]);
        if (h.send.len > 0) rawWriteAll(stream, h.send);
        if (h.failed) {
            closeConn(stream);
            return;
        }
        if (!st.established) return; // need more of the client's handshake
    }

    while (tlsmod.recordReady(st)) {
        var active = eng.activeBuf(conn);
        if (active.len - conn.filled < tlsmod.in_size) {
            // no room for a full record yet; drain/slide/grow, then retry
            const space_before = active.len - conn.filled;
            if (conn.is_ws) websocket.onData(conn) else drain(stream, conn);
            if (conn.closing or conn.awaiting) return; // leftover records stay encrypted
            active = eng.activeBuf(conn);
            if (active.len - conn.filled <= space_before) {
                // buffer full of an incomplete request bigger than we'll hold; drop it
                closeConn(stream);
                return;
            }
            continue;
        }
        const r = tlsmod.readRecord(st, active[conn.filled..]);
        if (r.failed) {
            closeConn(stream);
            return;
        }
        conn.filled += r.plain_len;
        if (r.closed) {
            if (conn.is_ws) websocket.onData(conn) else drain(stream, conn);
            closeConn(stream); // peer's close_notify; our own rides along in closeConn
            return;
        }
    }

    if (conn.is_ws) websocket.onData(conn) else drain(stream, conn);
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
    // cursor is the absolute offset of the next request's head. Pipelined requests
    // advance it without consuming, so the buffer is slid exactly once (at exit) rather
    // than per request. that turns an O(n^2) re-scan + memmove into O(n).
    var cursor: usize = 0;
    var keep_alive = true;

    while (true) {
        const active = eng.activeBuf(conn);
        if (cursor >= conn.filled) break; // every buffered request handled
        const view = active[cursor..conn.filled];
        const head_end_rel = parser.findHeadEnd(view, 0) orelse {
            // incomplete head at the tail. A full buffer with nothing parsed yet means the
            // head alone can't fit -> 400; otherwise wait (the prefix is consumed at exit).
            if (cursor == 0 and conn.overflow == null and conn.filled == eng.read_buf_size) {
                off += response.renderError(eng.cork[off..], .bad_request, null, false);
                keep_alive = false;
                eng.resetConn(conn);
                cursor = 0;
            }
            break;
        };
        const head_end = cursor + head_end_rel; // absolute offset of the body start

        const head = parser.parse(view[0..head_end_rel], eng.max_headers) catch {
            off += response.renderError(eng.cork[off..], .bad_request, null, false);
            keep_alive = false;
            eng.resetConn(conn);
            cursor = 0;
            break;
        };

        const total = head_end +| head.content_length; // saturate so a bogus Content-Length can't wrap
        if (head.content_length > eng.max_body) {
            off += response.renderError(eng.cork[off..], .payload_too_large, null, false);
            keep_alive = false;
            eng.resetConn(conn);
            cursor = 0;
            break;
        }
        const request_len = total - cursor; // this request's own size
        // a single request larger than the inline buffer spills to a heap buffer; drop the
        // already-parsed prefix first so the heap buffer holds only this request
        if (request_len > active.len) {
            if (cursor > 0) {
                eng.finishRequest(conn, cursor);
                cursor = 0;
            }
            if (!eng.growForBody(conn, request_len)) {
                off += response.renderError(eng.cork[off..], .payload_too_large, null, false);
                keep_alive = false;
                eng.resetConn(conn);
            }
            break; // rest of body arrives on the next read
        }
        if (conn.filled < total) {
            // body still arriving but it fits; consume the parsed prefix so the next read
            // appends in place instead of re-parsing earlier requests
            if (cursor > 0) {
                eng.finishRequest(conn, cursor);
                cursor = 0;
            }
            break;
        }

        if (eng.cork.len - off < MAX_RESPONSE) {
            writeAll(stream, eng.cork[0..off]);
            off = 0;
        }
        if (!head.keep_alive) keep_alive = false;

        const body: ?[]const u8 = if (head.content_length > 0) active[head_end..total] else null;
        const ip = std.mem.sliceTo(&conn.peer_ip, 0);
        // native 429 before the request ever reaches JS
        if (ratelimit.http.enabled() and ratelimit.http.exceeded(ip, conn.last_read)) {
            const retry = ratelimit.http.retryAfterSeconds(ip, conn.last_read);
            off += response.renderRateLimited(eng.cork[off..], retry, head.keep_alive);
            cursor = total;
            continue;
        }
        switch (eng.routes.resolve(head.method, head.path, &eng.route_scratch)) {
            .found => |f| {
                // a websocket upgrade on a ws route hands the connection to the WS path
                if (head.ws_key.len > 0 and f.index < eng.ws_flags.len and eng.ws_flags[f.index]) {
                    if (off > 0) {
                        writeAll(stream, eng.cork[0..off]);
                        off = 0;
                    }
                    websocket.upgrade(conn, &head, f);
                    eng.finishRequest(conn, total);
                    if (conn.filled > 0) websocket.onData(conn);
                    return;
                }
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

        cursor = total; // request handled; move to the next without sliding the buffer
    }

    // slide the whole processed prefix out in one memmove (error/reset paths set cursor=0)
    if (cursor > 0) eng.finishRequest(conn, cursor);
    if (off > 0) writeAll(stream, eng.cork[0..off]);
    if (!keep_alive) closeConn(stream);
}

/// Dispatch to JS: frame the sync response into the cork, or suspend for an async
/// handler. Returns true when suspended — caller must then return from drain,
/// leaving the request buffered for submitResponse.
fn dispatchAndEmit(stream: *anyopaque, conn: *Conn, off: *usize, env: napi.Env, undef: napi.Value, dispatch_fn: napi.Value, ip: []const u8, head: *const parser.ParsedHead, body: ?[]const u8, match: router.Found, total: usize) bool {
    const id = eng.nextId();
    switch (dispatchFound(env, undef, dispatch_fn, ip, conn.ip_ref, head, body, id, match)) {
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
            // if we can't register the awaited conn, submitResponse could never find it
            // to answer or free it — the conn would hang with reads stopped. Close instead.
            eng.pending.put(alloc, id, conn) catch {
                closeConn(eng.opaqueOf(&conn.tcp));
                return true;
            };
            stopRead(conn);
            return true;
        },
    }
}

// returns a sync response, or .awaiting when the handler went async (it'll call submitResponse)
fn dispatchFound(env: napi.Env, undef: napi.Value, dispatch_fn: napi.Value, ip: []const u8, ip_ref: napi.Ref, head: *const parser.ParsedHead, body: ?[]const u8, id: u32, match: router.Found) Outcome {
    const req = request.build(env, head, body, match.index, id, ip, ip_ref, match.params);
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
// would-be Content-Length but no body bytes (RFC 9110 §9.3.2). sending them would
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
    return head.is_head;
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
    const rendered = static.render(&head_buf, entry, head.accept_encoding, head.if_none_match, head.is_head, head.keep_alive);
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
        // a pipelined remainder is plaintext on a plain conn, but still-encrypted in
        // st.in on a TLS conn — drive TLS so those records get decrypted + handled.
        if (conn.tls) |st| tlsDrive(eng.opaqueOf(&conn.tcp), conn, st) else drain(eng.opaqueOf(&conn.tcp), conn);
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

// force a connection down with a TCP reset (RST): discards the send buffer and tears
// the socket down immediately, for a peer that is wedged (over the write-queue cap) and
// would otherwise hold the connection open by refusing to read. Falls back to a plain
// close if the reset can't be issued (e.g. an unconnected handle).
fn forceClose(stream: *anyopaque) void {
    const conn: *Conn = @ptrCast(@alignCast(stream));
    if (conn.closing) return;
    conn.closing = true;
    if (uv.uv_tcp_close_reset(stream, &onClose) != 0) uv.uv_close(stream, &onClose);
}

pub fn closeConn(stream: *anyopaque) void {
    const conn: *Conn = @ptrCast(@alignCast(stream));
    if (conn.closing) return;
    // graceful TLS shutdown: best-effort close_notify before the socket goes away
    if (conn.tls) |st| {
        if (st.established and !st.sent_close) {
            st.sent_close = true;
            const alert = tlsmod.closeNotify(st, eng.tls_out[0..]);
            if (alert.len > 0) rawWriteAll(stream, alert);
        }
    }
    conn.closing = true;
    uv.uv_close(stream, &onClose);
}

// Every byte the engine sends funnels through here. For a TLS connection the
// plaintext is encrypted into records first (each ciphertext record then takes the
// raw path); plaintext connections write straight to the socket.
pub fn writeAll(stream: *anyopaque, bytes: []const u8) void {
    const conn: *Conn = @ptrCast(@alignCast(stream));
    if (conn.tls) |st| {
        if (st.established) {
            var rest = bytes;
            // feed one record's worth of plaintext per round → exactly one TLS record
            // out, which fits in the single-record output buffer.
            while (rest.len > 0) {
                const take = @min(rest.len, tlsmod.max_cleartext);
                const w = tlsmod.encrypt(st, rest[0..take], eng.tls_out[0..tlsmod.out_record]);
                if (w.failed) {
                    closeConn(stream);
                    return;
                }
                rawWriteAll(stream, w.ciphertext);
                rest = rest[take..];
            }
            return;
        }
    }
    rawWriteAll(stream, bytes);
}

// fast path: one synchronous uv_try_write, zero heap. only a short write falls
// back to a queued uv_write of the unsent tail. Once anything is queued (socket
// backpressure), every later write must queue too. uv_try_write bypasses libuv's
// FIFO write queue, so letting it run ahead of already-queued bytes would reorder
// the stream, corrupting TLS records (bad MAC) and HTTP framing alike.
fn rawWriteAll(stream: *anyopaque, bytes: []const u8) void {
    const conn: *Conn = @ptrCast(@alignCast(stream));
    if (conn.queued_bytes != 0) {
        queueTail(stream, bytes);
        return;
    }
    var b = uv.Buf{ .base = @ptrCast(@constCast(bytes.ptr)), .len = @intCast(bytes.len) };
    const rc = uv.uv_try_write(stream, @ptrCast(&b), 1);
    const written: usize = if (rc > 0) @intCast(rc) else 0;
    if (written == bytes.len) return;
    queueTail(stream, bytes[written..]);
}

// cold path: socket buffer full. dup the unsent tail and queue it, charging the
// bytes to the conn's backpressure counter until onWrite fires.
fn queueTail(stream: *anyopaque, tail: []const u8) void {
    const conn: *Conn = @ptrCast(@alignCast(stream));
    // a non-reading peer can't be allowed to make the server buffer without bound: once
    // the unflushed backlog would blow the ceiling, drop the connection — with a reset, so
    // a peer that has stopped reading is gone now rather than lingering in FIN_WAIT while a
    // graceful close waits for it to drain the socket buffer it is no longer reading.
    if (conn.queued_bytes +| tail.len > eng.max_write_queue) {
        forceClose(stream);
        return;
    }
    const wire = alloc.dupe(u8, tail) catch return;
    const wr = alloc.create(eng.WriteReq) catch {
        alloc.free(wire);
        return;
    };
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
    if (wr.conn) |conn| {
        conn.queued_bytes -|= wr.body.len;
        // a websocket producer paused on a full socket resumes when the queue clears
        if (conn.is_ws and !conn.closing and conn.queued_bytes == 0) websocket.onDrain(conn);
    }
    alloc.free(wr.body);
    alloc.destroy(wr);
}

fn onClose(handle: *anyopaque) callconv(.c) void {
    const conn: *Conn = @ptrCast(@alignCast(handle));
    // ws teardown: drop from the id map, free any partial message, fire the close event
    websocket.onClosed(conn);
    // drop any pending entry so a late submitResponse can't touch freed memory
    if (conn.awaiting) _ = eng.pending.remove(conn.dispatch_id);
    if (conn.overflow) |buffer| alloc.free(buffer);
    if (conn.ip_ref) |ref| _ = napi.napi_delete_reference(eng.env, ref);
    if (conn.tls) |st| tlsmod.freeState(st);
    eng.removeConn(conn);
    eng.conn_pool.destroy(conn);
}
