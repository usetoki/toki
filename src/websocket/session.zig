//! WebSocket (RFC 6455). The handshake, frame parsing, masking, validation, and
//! reassembly run in native code; only complete messages and events cross into JS.
//! Server frames are written unmasked; client frames must be masked and are
//! unmasked in place. Lives on the same libuv stream as HTTP: once a connection
//! upgrades, reads route here instead of the HTTP drain.
//!
//! Protocol conformance: rejects non-zero RSV (no extensions negotiated), reserved
//! opcodes, fragmented or oversized control frames, bad fragmentation sequencing,
//! invalid UTF-8 in text payloads (1007), and invalid close codes (1002).

const std = @import("std");
const napi = @import("../ffi/napi.zig");
const uv = @import("../ffi/uv.zig");
const parser = @import("../http/parser.zig");
const router = @import("../http/router.zig");
const request = @import("../http/request.zig");
const eng = @import("../core/engine.zig");
const loop = @import("../core/loop.zig");
const frame = @import("frame.zig");

const alloc = eng.alloc;
const Conn = eng.Conn;

// wire format lives in frame.zig; alias the parts used here
const Header = frame.Header;
const parseHeader = frame.parseHeader;
const unmask = frame.unmask;
const validCloseCode = frame.validCloseCode;
const writeFrameHeader = frame.writeHeader;
const op_cont = frame.op_cont;
const op_text = frame.op_text;
const op_binary = frame.op_binary;
const op_close = frame.op_close;
const op_ping = frame.op_ping;
const op_pong = frame.op_pong;
const close_normal = frame.close_normal;
const close_protocol = frame.close_protocol;
const close_bad_data = frame.close_bad_data;
const close_too_big = frame.close_too_big;
const close_internal = frame.close_internal;

// RFC 6455 §4.2.2 handshake GUID. Appended to Sec-WebSocket-Key, then SHA-1 + base64 gives Sec-WebSocket-Accept.
const WS_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// event codes handed to the JS dispatcher
const ev_open = 0; // (req, protocol)
const ev_message = 1; // (isBinary, payload)
const ev_close = 2; // (code, reason)
const ev_ping = 3; // (_, payload)
const ev_pong = 4; // (_, payload)
const ev_drain = 5; // (_, _)

// scratch for outgoing frames; single-threaded, reused between sends because
// writeAll completes (or dups its tail) before returning.
var send_scratch: [64 * 1024]u8 = undefined;

/// 101 handshake (with subprotocol negotiation), then mark the connection as a
/// websocket and fire the open event. Called from the HTTP drain with its handle
/// scope already open.
pub fn upgrade(conn: *Conn, head: *const parser.ParsedHead, match: router.Found) void {
    var accept: [28]u8 = undefined;
    writeAccept(head.ws_key, &accept);
    const protocol = chooseProtocol(head.ws_protocol, routeProtocols(match.index));
    const deflate = eng.ws_compression and offersPermessageDeflate(head.ws_extensions);

    var resp: [384]u8 = undefined;
    const n = writeHandshake(&resp, &accept, protocol, deflate);
    loop.writeAll(eng.opaqueOf(&conn.tcp), resp[0..n]);

    conn.is_ws = true;
    conn.ws_id = eng.nextWsId();
    conn.ws_close_code = 1006; // abnormal until a close frame says otherwise
    conn.ws_close_reason_len = 0;
    conn.ws_frag = null;
    conn.ws_frag_len = 0;
    conn.ws_deflate = deflate;
    eng.ws_conns.put(alloc, conn.ws_id, conn) catch {};

    const env = eng.env;
    const ip = std.mem.sliceTo(&conn.peer_ip, 0);
    const req = request.build(env, head, null, match.index, conn.ws_id, ip, conn.ip_ref, match.params);
    var proto_val: napi.Value = undefined;
    _ = napi.napi_create_string_utf8(env, protocol.ptr, protocol.len, &proto_val);
    var deflate_val: napi.Value = undefined;
    _ = napi.napi_create_uint32(env, if (deflate) 1 else 0, &deflate_val);
    dispatch(env, conn.ws_id, ev_open, req, proto_val, deflate_val);
}

// did the client offer permessage-deflate?
fn offersPermessageDeflate(extensions: []const u8) bool {
    var it = std.mem.splitScalar(u8, extensions, ',');
    while (it.next()) |raw| {
        const ext = std.mem.trim(u8, raw, " \t");
        const name = if (std.mem.indexOfScalar(u8, ext, ';')) |s| ext[0..s] else ext;
        if (std.mem.eql(u8, std.mem.trim(u8, name, " \t"), "permessage-deflate")) return true;
    }
    return false;
}

fn routeProtocols(index: u32) []const u8 {
    return if (index < eng.ws_route_protocols.len) eng.ws_route_protocols[index] else "";
}

// pick the first client-offered subprotocol the route also supports; "" if none match
fn chooseProtocol(offered: []const u8, supported: []const u8) []const u8 {
    if (offered.len == 0 or supported.len == 0) return "";
    var it = std.mem.splitScalar(u8, offered, ',');
    while (it.next()) |raw| {
        const token = std.mem.trim(u8, raw, " \t");
        if (token.len == 0) continue;
        if (listContains(supported, token)) return token;
    }
    return "";
}

fn listContains(list: []const u8, token: []const u8) bool {
    var it = std.mem.splitScalar(u8, list, ',');
    while (it.next()) |raw| {
        if (std.mem.eql(u8, std.mem.trim(u8, raw, " \t"), token)) return true;
    }
    return false;
}

fn writeAccept(key: []const u8, out: *[28]u8) void {
    var sha = std.crypto.hash.Sha1.init(.{});
    sha.update(key);
    sha.update(WS_ACCEPT_GUID);
    var digest: [20]u8 = undefined;
    sha.final(&digest);
    _ = std.base64.standard.Encoder.encode(out, &digest);
}

fn writeHandshake(dest: []u8, accept: *const [28]u8, protocol: []const u8, deflate: bool) usize {
    const head = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ";
    const ph = "\r\nSec-WebSocket-Protocol: ";
    const ext = "\r\nSec-WebSocket-Extensions: permessage-deflate; client_no_context_takeover; server_no_context_takeover";
    const tail = "\r\n\r\n";
    var p: usize = 0;
    @memcpy(dest[p..][0..head.len], head);
    p += head.len;
    @memcpy(dest[p..][0..28], accept);
    p += 28;
    // the extension + tail must always fit; only write the (length-bounded) subprotocol
    // if it does too, never @memcpy past dest
    const reserve = (if (deflate) ext.len else 0) + tail.len;
    if (protocol.len > 0 and p + ph.len + protocol.len + reserve <= dest.len) {
        @memcpy(dest[p..][0..ph.len], ph);
        p += ph.len;
        @memcpy(dest[p..][0..protocol.len], protocol);
        p += protocol.len;
    }
    if (deflate) {
        // no context takeover keeps per-message (de)compression stateless on both ends
        @memcpy(dest[p..][0..ext.len], ext);
        p += ext.len;
    }
    @memcpy(dest[p..][0..tail.len], tail);
    return p + tail.len;
}

/// Pull complete frames out of the connection buffer and act on each. Mirrors the
/// HTTP drain's buffering: a frame larger than the inline buffer spills to a heap
/// buffer sized to it, with the rest arriving on later reads.
pub fn onData(conn: *Conn) void {
    const env = eng.env;
    var scope: napi.HandleScope = undefined;
    _ = napi.napi_open_handle_scope(env, &scope);
    defer _ = napi.napi_close_handle_scope(env, scope);

    while (true) {
        const view = eng.activeBuf(conn)[0..conn.filled];
        const f = parseHeader(view) orelse break; // header not fully here yet
        if (frame.validate(f, conn.ws_frag != null, conn.ws_deflate, eng.max_ws_message)) |code| {
            closeWs(conn, code);
            return;
        }
        // safe: validate() guarantees payload_len <= max_ws_message (a usize) for data
        // frames and <= 125 for control frames
        const total = f.header_len + @as(usize, @intCast(f.payload_len));
        if (total > eng.activeBuf(conn).len) {
            if (!eng.growForBody(conn, total)) {
                closeWs(conn, close_too_big);
                return;
            }
            break; // rest of the frame arrives on the next read
        }
        if (conn.filled < total) break; // payload still arriving

        const payload = eng.activeBuf(conn)[f.header_len..total];
        unmask(payload, f.mask_key);
        handleFrame(conn, env, f, payload);

        if (conn.closing) return; // a close frame / error tore the connection down
        eng.finishRequest(conn, total);
        if (conn.filled == 0) break;
    }
}

fn handleFrame(conn: *Conn, env: napi.Env, h: Header, payload: []u8) void {
    const compressed = h.rsv & 0x4 != 0; // permessage-deflate; JS inflates + validates
    switch (h.opcode) {
        op_text, op_binary => {
            if (h.fin) {
                if (!compressed and h.opcode == op_text and !std.unicode.utf8ValidateSlice(payload)) {
                    closeWs(conn, close_bad_data);
                    return;
                }
                dispatchMessage(conn, env, h.opcode == op_binary, compressed, payload);
            } else {
                conn.ws_msg_compressed = compressed;
                startFragment(conn, h.opcode, payload);
            }
        },
        op_cont => {
            if (!appendFragment(conn, payload)) return;
            if (h.fin) {
                const frag = conn.ws_frag.?[0..conn.ws_frag_len];
                if (!conn.ws_msg_compressed and conn.ws_frag_opcode == op_text and !std.unicode.utf8ValidateSlice(frag)) {
                    freeFragment(conn);
                    closeWs(conn, close_bad_data);
                    return;
                }
                dispatchMessage(conn, env, conn.ws_frag_opcode == op_binary, conn.ws_msg_compressed, frag);
                freeFragment(conn);
            }
        },
        op_ping => {
            sendFrame(conn, op_pong, payload, false); // auto-pong with the same payload
            dispatchBuffer(conn, env, ev_ping, payload);
        },
        op_pong => dispatchBuffer(conn, env, ev_pong, payload),
        op_close => handleClose(conn, payload),
        else => closeWs(conn, close_protocol),
    }
}

fn handleClose(conn: *Conn, payload: []const u8) void {
    if (payload.len == 1) {
        closeWs(conn, close_protocol); // a 1-byte close payload is malformed
        return;
    }
    var code: u16 = close_normal;
    if (payload.len >= 2) {
        code = (@as(u16, payload[0]) << 8) | payload[1];
        if (!validCloseCode(code)) {
            closeWs(conn, close_protocol);
            return;
        }
        const reason = payload[2..];
        if (!std.unicode.utf8ValidateSlice(reason)) {
            closeWs(conn, close_bad_data);
            return;
        }
        const rlen = @min(reason.len, conn.ws_close_reason.len);
        @memcpy(conn.ws_close_reason[0..rlen], reason[0..rlen]);
        conn.ws_close_reason_len = @intCast(rlen);
    }
    conn.ws_close_code = code;
    sendClose(conn, code); // echo, then onClose fires the JS close event with code + reason
    loop.closeConn(eng.opaqueOf(&conn.tcp));
}

fn startFragment(conn: *Conn, opcode: u8, payload: []const u8) void {
    if (payload.len > eng.max_ws_message) {
        closeWs(conn, close_too_big);
        return;
    }
    const buf = alloc.alloc(u8, payload.len) catch {
        closeWs(conn, close_internal);
        return;
    };
    @memcpy(buf, payload);
    conn.ws_frag = buf;
    conn.ws_frag_len = payload.len;
    conn.ws_frag_opcode = opcode;
}

fn appendFragment(conn: *Conn, payload: []const u8) bool {
    const cur = conn.ws_frag orelse {
        closeWs(conn, close_protocol);
        return false;
    };
    const new_len = conn.ws_frag_len + payload.len;
    if (new_len > eng.max_ws_message) {
        closeWs(conn, close_too_big);
        return false;
    }
    const grown = alloc.realloc(cur, new_len) catch {
        closeWs(conn, close_internal);
        return false;
    };
    @memcpy(grown[conn.ws_frag_len..new_len], payload);
    conn.ws_frag = grown;
    conn.ws_frag_len = new_len;
    return true;
}

fn freeFragment(conn: *Conn) void {
    if (conn.ws_frag) |f| alloc.free(f);
    conn.ws_frag = null;
    conn.ws_frag_len = 0;
}

fn dispatchMessage(conn: *Conn, env: napi.Env, is_binary: bool, compressed: bool, payload: []const u8) void {
    var buf_val: napi.Value = undefined;
    _ = napi.napi_create_external_buffer(env, payload.len, @ptrCast(@constCast(payload.ptr)), null, null, &buf_val);
    // flags: bit0 = binary, bit1 = compressed (JS inflates when set)
    const flags: u32 = (if (is_binary) @as(u32, 1) else 0) | (if (compressed) @as(u32, 2) else 0);
    var flag: napi.Value = undefined;
    _ = napi.napi_create_uint32(env, flags, &flag);
    dispatch(env, conn.ws_id, ev_message, flag, buf_val, eng.undefinedValue(env));
}

fn dispatchBuffer(conn: *Conn, env: napi.Env, event: u32, payload: []const u8) void {
    var buf_val: napi.Value = undefined;
    _ = napi.napi_create_external_buffer(env, payload.len, @ptrCast(@constCast(payload.ptr)), null, null, &buf_val);
    dispatch(env, conn.ws_id, event, eng.undefinedValue(env), buf_val, eng.undefinedValue(env));
}

/// fired from onWrite when a backpressured connection's write queue empties, so a
/// producer paused on a full socket knows it can resume.
pub fn onDrain(conn: *Conn) void {
    const env = eng.env;
    var scope: napi.HandleScope = undefined;
    _ = napi.napi_open_handle_scope(env, &scope);
    defer _ = napi.napi_close_handle_scope(env, scope);
    dispatch(env, conn.ws_id, ev_drain, eng.undefinedValue(env), eng.undefinedValue(env), eng.undefinedValue(env));
}

// called from onClose for every teardown path, so the JS close event fires exactly
// once whether the peer sent a close frame, the socket dropped, or we closed it.
pub fn onClosed(conn: *Conn) void {
    if (!conn.is_ws) return;
    const env = eng.env;
    var scope: napi.HandleScope = undefined;
    _ = napi.napi_open_handle_scope(env, &scope);
    defer _ = napi.napi_close_handle_scope(env, scope);

    _ = eng.ws_conns.remove(conn.ws_id);
    freeFragment(conn);

    var code: napi.Value = undefined;
    _ = napi.napi_create_uint32(env, conn.ws_close_code, &code);
    const reason = conn.ws_close_reason[0..conn.ws_close_reason_len];
    var reason_val: napi.Value = undefined;
    _ = napi.napi_create_string_utf8(env, reason.ptr, reason.len, &reason_val);
    dispatch(env, conn.ws_id, ev_close, code, reason_val, eng.undefinedValue(env));
}

fn dispatch(env: napi.Env, ws_id: u32, event: u32, a: napi.Value, b: napi.Value, c: napi.Value) void {
    if (eng.ws_dispatch_ref == null) return;
    var fn_val: napi.Value = undefined;
    if (napi.napi_get_reference_value(env, eng.ws_dispatch_ref, &fn_val) != napi.ok) return;
    var undef: napi.Value = undefined;
    _ = napi.napi_get_undefined(env, &undef);
    var id_val: napi.Value = undefined;
    _ = napi.napi_create_uint32(env, ws_id, &id_val);
    var ev_val: napi.Value = undefined;
    _ = napi.napi_create_uint32(env, event, &ev_val);
    const args = [_]napi.Value{ id_val, ev_val, a, b, c };
    var result: napi.Value = undefined;
    if (napi.napi_call_function(env, undef, fn_val, 5, &args, &result) != napi.ok) {
        var ex: napi.Value = undefined;
        _ = napi.napi_get_and_clear_last_exception(env, &ex); // swallow; one bad handler can't kill the loop
    }
}

// build a single contiguous frame (header + payload) and write it in order.
// server-to-client frames are never masked. rsv1 marks a permessage-deflate payload.
fn sendFrame(conn: *Conn, opcode: u8, payload: []const u8, rsv1: bool) void {
    if (conn.closing) return;
    var hdr: [10]u8 = undefined;
    const hlen = writeFrameHeader(&hdr, opcode, payload.len, rsv1);
    const total = hlen + payload.len;
    if (total <= send_scratch.len) {
        @memcpy(send_scratch[0..hlen], hdr[0..hlen]);
        @memcpy(send_scratch[hlen..total], payload);
        loop.writeAll(eng.opaqueOf(&conn.tcp), send_scratch[0..total]);
        return;
    }
    const buf = alloc.alloc(u8, total) catch return;
    defer alloc.free(buf);
    @memcpy(buf[0..hlen], hdr[0..hlen]);
    @memcpy(buf[hlen..], payload);
    loop.writeAll(eng.opaqueOf(&conn.tcp), buf);
}

fn sendClose(conn: *Conn, code: u16) void {
    const payload = [2]u8{ @intCast(code >> 8), @intCast(code & 0xFF) };
    sendFrame(conn, op_close, &payload, false);
}

fn closeWs(conn: *Conn, code: u16) void {
    if (conn.closing) return;
    conn.ws_close_code = code;
    sendClose(conn, code);
    loop.closeConn(eng.opaqueOf(&conn.tcp));
}

/// wsSend(wsId, isBinary, data, compressed) -> queued backlog bytes (0 when flushed).
/// `compressed` is set by JS after it deflated the payload (sets the RSV1 bit).
pub fn send(env: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
    var argc: usize = 4;
    var argv: [4]napi.Value = undefined;
    _ = napi.napi_get_cb_info(env, info, &argc, &argv, null, null);

    var ws_id: u32 = 0;
    _ = napi.napi_get_value_uint32(env, argv[0], &ws_id);
    var is_binary: u32 = 0;
    _ = napi.napi_get_value_uint32(env, argv[1], &is_binary);
    var data: ?*anyopaque = null;
    var len: usize = 0;
    _ = napi.napi_get_buffer_info(env, argv[2], &data, &len);
    var compressed: u32 = 0;
    if (argc >= 4) _ = napi.napi_get_value_uint32(env, argv[3], &compressed);

    const conn = eng.ws_conns.get(ws_id) orelse return eng.undefinedValue(env);
    const payload: []const u8 = if (data) |d| @as([*]const u8, @ptrCast(d))[0..len] else "";
    sendFrame(conn, if (is_binary != 0) op_binary else op_text, payload, compressed != 0);

    var out: napi.Value = undefined;
    _ = napi.napi_create_uint32(env, @intCast(@min(conn.queued_bytes, std.math.maxInt(u32))), &out);
    return out;
}

/// wsPing(wsId, data?) — send a ping; the peer answers with a pong
pub fn ping(env: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
    return control(env, info, op_ping);
}

/// wsPong(wsId, data?) — send an unsolicited pong (e.g. a heartbeat)
pub fn pong(env: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
    return control(env, info, op_pong);
}

fn control(env: napi.Env, info: napi.CallbackInfo, opcode: u8) napi.Value {
    var argc: usize = 2;
    var argv: [2]napi.Value = undefined;
    _ = napi.napi_get_cb_info(env, info, &argc, &argv, null, null);

    var ws_id: u32 = 0;
    _ = napi.napi_get_value_uint32(env, argv[0], &ws_id);
    const conn = eng.ws_conns.get(ws_id) orelse return eng.undefinedValue(env);

    var data: ?*anyopaque = null;
    var len: usize = 0;
    if (argc >= 2) _ = napi.napi_get_buffer_info(env, argv[1], &data, &len);
    const payload: []const u8 = if (data) |d| @as([*]const u8, @ptrCast(d))[0..@min(len, 125)] else "";
    sendFrame(conn, opcode, payload, false);
    return eng.undefinedValue(env);
}

/// wsClose(wsId, code) — send a close frame and tear the connection down
pub fn closeSocket(env: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
    var argc: usize = 2;
    var argv: [2]napi.Value = undefined;
    _ = napi.napi_get_cb_info(env, info, &argc, &argv, null, null);

    var ws_id: u32 = 0;
    _ = napi.napi_get_value_uint32(env, argv[0], &ws_id);
    var code: u32 = close_normal;
    _ = napi.napi_get_value_uint32(env, argv[1], &code);

    const conn = eng.ws_conns.get(ws_id) orelse return eng.undefinedValue(env);
    closeWs(conn, @intCast(code & 0xFFFF));
    return eng.undefinedValue(env);
}

/// wires the JS dispatcher, marks which route indices were registered with app.ws,
/// and records each route's offered subprotocols for negotiation
pub fn configure(env: napi.Env, dispatch_val: napi.Value, indices_val: napi.Value, protocols_val: napi.Value, route_count: usize) void {
    var kind: c_int = 0;
    _ = napi.napi_typeof(env, dispatch_val, &kind);
    if (kind != napi.valuetype.function) return; // no websocket routes registered

    _ = napi.napi_create_reference(env, dispatch_val, 1, &eng.ws_dispatch_ref);

    const flags = alloc.alloc(bool, route_count) catch return;
    @memset(flags, false);
    const protos = alloc.alloc([]const u8, route_count) catch {
        alloc.free(flags);
        return;
    };
    @memset(protos, "");

    var len: u32 = 0;
    _ = napi.napi_get_array_length(env, indices_val, &len);
    var i: u32 = 0;
    while (i < len) : (i += 1) {
        var el: napi.Value = undefined;
        _ = napi.napi_get_element(env, indices_val, i, &el);
        var idx: u32 = 0;
        _ = napi.napi_get_value_uint32(env, el, &idx);
        if (idx >= route_count) continue;
        flags[idx] = true;
        var pel: napi.Value = undefined;
        if (napi.napi_get_element(env, protocols_val, i, &pel) == napi.ok) {
            protos[idx] = dupString(env, pel);
        }
    }
    eng.ws_flags = flags;
    eng.ws_route_protocols = protos;
}

// copy a JS string into engine-owned memory (route protocol lists live for the run)
fn dupString(env: napi.Env, value: napi.Value) []const u8 {
    var buf: [256]u8 = undefined;
    var copied: usize = 0;
    if (napi.napi_get_value_string_utf8(env, value, &buf, buf.len, &copied) != napi.ok) return "";
    return alloc.dupe(u8, buf[0..copied]) catch "";
}
