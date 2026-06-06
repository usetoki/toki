//! Chunked streaming exports. Reuses the async-suspend path: the JS dispatch
//! returns undefined (drain suspends the conn into `pending`), then JS drives the
//! body via startStream -> writeStreamChunk* -> endStream, keyed by dispatch id.
//! Chunks are framed and written straight out; the conn resumes (keep-alive) or
//! closes on endStream.

const std = @import("std");
const napi = @import("../ffi/napi.zig");
const response = @import("response.zig");
const eng = @import("../core/engine.zig");
const loop = @import("../core/loop.zig");

const Conn = eng.Conn;

/// startStream(id, status, headers) — writes the chunked response head.
pub fn startStream(env: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
    var argc: usize = 3;
    var argv: [3]napi.Value = undefined;
    _ = napi.napi_get_cb_info(env, info, &argc, &argv, null, null);

    var id: u32 = 0;
    _ = napi.napi_get_value_uint32(env, argv[0], &id);
    const conn = eng.pending.get(id) orelse return eng.undefinedValue(env);
    if (conn.closing) return eng.undefinedValue(env);

    var status: u32 = 200;
    _ = napi.napi_get_value_uint32(env, argv[1], &status);
    var hlen: usize = 0;
    _ = napi.napi_get_value_string_utf8(env, argv[2], &eng.headers_scratch, eng.headers_scratch.len, &hlen);

    // honor the inbound Connection: the conn closes after endStream when keep-alive is
    // off, so the head must say close — otherwise the client reuses a dead socket.
    const n = response.serializeChunkedHead(eng.cork[0..], @intCast(status), eng.headers_scratch[0..hlen], conn.pending_keep_alive);
    loop.writeAll(eng.opaqueOf(&conn.tcp), eng.cork[0..n]);
    return eng.undefinedValue(env);
}

/// writeStreamChunk(id, buffer) -> backlog — frames+writes one chunk, returns the
/// conn's queued-byte backlog (for JS backpressure), or -1 if the conn is gone.
pub fn writeStreamChunk(env: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
    var argc: usize = 2;
    var argv: [2]napi.Value = undefined;
    _ = napi.napi_get_cb_info(env, info, &argc, &argv, null, null);

    var id: u32 = 0;
    _ = napi.napi_get_value_uint32(env, argv[0], &id);
    const conn = eng.pending.get(id) orelse return makeInt(env, -1);
    if (conn.closing) return makeInt(env, -1);

    var data: ?*anyopaque = null;
    var len: usize = 0;
    if (napi.napi_get_buffer_info(env, argv[1], &data, &len) != napi.ok or len == 0) {
        return makeInt(env, backlog(conn));
    }
    const tcp = eng.opaqueOf(&conn.tcp);
    var hdr: [18]u8 = undefined;
    loop.writeAll(tcp, hdr[0..response.writeChunkHeader(&hdr, len)]);
    loop.writeAll(tcp, @as([*]const u8, @ptrCast(data.?))[0..len]);
    loop.writeAll(tcp, "\r\n");
    return makeInt(env, backlog(conn));
}

/// endStream(id) — writes the terminating chunk, then resumes or closes the conn.
pub fn endStream(env: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
    var argc: usize = 1;
    var argv: [1]napi.Value = undefined;
    _ = napi.napi_get_cb_info(env, info, &argc, &argv, null, null);

    var id: u32 = 0;
    _ = napi.napi_get_value_uint32(env, argv[0], &id);
    const conn = eng.pending.get(id) orelse return eng.undefinedValue(env);
    _ = eng.pending.remove(id);
    if (conn.closing) return eng.undefinedValue(env);
    conn.awaiting = false;

    loop.writeAll(eng.opaqueOf(&conn.tcp), "0\r\n\r\n");
    eng.finishRequest(conn, conn.pending_consume);
    if (conn.pending_keep_alive) {
        loop.armRead(conn);
        loop.drain(eng.opaqueOf(&conn.tcp), conn);
    } else {
        loop.closeConn(eng.opaqueOf(&conn.tcp));
    }
    return eng.undefinedValue(env);
}

fn backlog(conn: *Conn) i32 {
    return if (conn.queued_bytes > std.math.maxInt(i32)) std.math.maxInt(i32) else @intCast(conn.queued_bytes);
}

fn makeInt(env: napi.Env, v: i32) napi.Value {
    var out: napi.Value = undefined;
    _ = napi.napi_create_int32(env, v, &out);
    return out;
}
