//! UDP server on Node's libuv loop. Connectionless: one socket, every datagram is
//! handed to JS with the sender's address; `send` goes straight back out. One socket
//! per process. No per-flow state lives here — that belongs in user space, by design.

const std = @import("std");
const napi = @import("../ffi/napi.zig");
const uv = @import("../ffi/uv.zig");
const addr = @import("addr.zig");

const alloc = std.heap.c_allocator;

// 64 KiB holds the largest possible UDP payload; one shared scratch, since a datagram
// is forwarded to JS before the next recv runs (single-threaded loop).
const recv_scratch_size = 64 * 1024;

const SendReq = struct {
    req: [uv.udp_send_size]u8 align(16),
    body: []u8,
};

var env: napi.Env = null;
var loop: ?*anyopaque = null;
var dispatch_ref: napi.Ref = null;
var socket: [uv.udp_size]u8 align(16) = undefined;
var bound = false;
var send_pool: std.heap.MemoryPool(SendReq) = .empty;
var recv_scratch: [recv_scratch_size]u8 = undefined;

fn opaqueOf(p: anytype) *anyopaque {
    return @ptrCast(p);
}

// udpBind(port, host, options, dispatch) -> bound port (0 on failure, after throwing)
pub fn bind(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
    var argc: usize = 4;
    var argv: [4]napi.Value = undefined;
    _ = napi.napi_get_cb_info(e, info, &argc, &argv, null, null);

    env = e;
    _ = napi.napi_get_uv_event_loop(e, &loop);

    var port: i32 = 0;
    _ = napi.napi_get_value_int32(e, argv[0], &port);

    var host: [256]u8 = .{ '0', '.', '0', '.', '0', '.', '0' } ++ .{0} ** 249;
    var hlen: usize = 0;
    _ = napi.napi_get_value_string_utf8(e, argv[1], &host, host.len, &hlen);

    var bind_flags: c_uint = 0;
    if (optBool(e, argv[2], "reuseAddr")) bind_flags |= uv.UDP_REUSEADDR;
    const recvmmsg = optBool(e, argv[2], "recvmmsg");

    _ = napi.napi_create_reference(e, argv[3], 1, &dispatch_ref);

    if (recvmmsg) {
        _ = uv.uv_udp_init_ex(loop.?, opaqueOf(&socket), uv.UDP_RECVMMSG);
    } else {
        _ = uv.uv_udp_init(loop.?, opaqueOf(&socket));
    }

    // sockaddr_storage-sized: an IPv6 sockaddr is 28 bytes, well past SockaddrIn's 16.
    var sa: [128]u8 align(8) = undefined;
    if (!addr.parse(&host, hlen, port, &sa)) {
        _ = napi.napi_throw_error(e, null, "udp: invalid bind address");
        return uintValue(e, 0);
    }
    const bind_rc = uv.uv_udp_bind(opaqueOf(&socket), opaqueOf(&sa), bind_flags);
    if (bind_rc != 0) {
        _ = napi.napi_throw_error(e, null, uv.uv_strerror(bind_rc));
        return uintValue(e, 0);
    }
    const rc = uv.uv_udp_recv_start(opaqueOf(&socket), &allocBuf, &onRecv);
    if (rc != 0) {
        _ = napi.napi_throw_error(e, null, uv.uv_strerror(rc));
        return uintValue(e, 0);
    }
    bound = true;

    var sn: [128]u8 align(8) = undefined;
    var slen: c_int = sn.len;
    var bound_port: u16 = 0;
    if (uv.uv_udp_getsockname(opaqueOf(&socket), opaqueOf(&sn), &slen) == 0) {
        bound_port = addr.portOf(&sn);
    }
    return uintValue(e, bound_port);
}

fn allocBuf(handle: *anyopaque, suggested: usize, buf: *uv.Buf) callconv(.c) void {
    _ = handle;
    _ = suggested;
    buf.* = .{ .base = @ptrCast(&recv_scratch), .len = @intCast(recv_scratch.len) };
}

fn onRecv(handle: *anyopaque, nread: isize, buf: *const uv.Buf, from: ?*const anyopaque, flags: c_uint) callconv(.c) void {
    _ = handle;
    _ = flags;
    // nread == 0 with a null addr is libuv's "no more datagrams this pass" signal, not data.
    // nread == 0 with an addr is a legitimate empty datagram (delivered). nread < 0 is an error.
    if (nread < 0) return;
    const sender = from orelse return;

    var scope: napi.HandleScope = undefined;
    _ = napi.napi_open_handle_scope(env, &scope);
    defer _ = napi.napi_close_handle_scope(env, scope);

    // copy from buf.base (which, with recvmmsg, may be libuv's own ring buffer — never
    // ours) into a V8-owned Buffer the handler can safely keep.
    var data_val: napi.Value = undefined;
    _ = napi.napi_create_buffer_copy(env, @intCast(nread), buf.base, null, &data_val);
    dispatch(data_val, rinfo(sender));
}

fn rinfo(from: *const anyopaque) napi.Value {
    var obj: napi.Value = undefined;
    _ = napi.napi_create_object(env, &obj);

    var ip: [46]u8 = [_]u8{0} ** 46;
    addr.name(from, &ip);
    const text = std.mem.sliceTo(&ip, 0);
    var addr_val: napi.Value = undefined;
    _ = napi.napi_create_string_utf8(env, text.ptr, text.len, &addr_val);
    _ = napi.napi_set_named_property(env, obj, "address", addr_val);

    var port_val: napi.Value = undefined;
    _ = napi.napi_create_uint32(env, addr.portOf(from), &port_val);
    _ = napi.napi_set_named_property(env, obj, "port", port_val);
    return obj;
}

// udpSend(buffer, port, host) — non-blocking try-send, falling back to a queued send
// when the socket buffer is full. UDP has no flow control; the kernel drops on overflow.
pub fn send(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
    var argc: usize = 3;
    var argv: [3]napi.Value = undefined;
    _ = napi.napi_get_cb_info(e, info, &argc, &argv, null, null);

    var data: ?*anyopaque = null;
    var len: usize = 0;
    _ = napi.napi_get_buffer_info(e, argv[0], &data, &len);
    var port: i32 = 0;
    _ = napi.napi_get_value_int32(e, argv[1], &port);
    var host: [256]u8 = undefined;
    var hlen: usize = 0;
    _ = napi.napi_get_value_string_utf8(e, argv[2], &host, host.len, &hlen);

    if (!bound) return undefinedValue();
    var sa: [128]u8 align(8) = undefined;
    if (!addr.parse(&host, hlen, port, &sa)) return undefinedValue();
    const payload: []const u8 = if (data) |d| @as([*]const u8, @ptrCast(d))[0..len] else "";

    var b = uv.Buf{ .base = @ptrCast(@constCast(payload.ptr)), .len = @intCast(payload.len) };
    if (uv.uv_udp_try_send(opaqueOf(&socket), @ptrCast(&b), 1, opaqueOf(&sa)) >= 0) {
        return undefinedValue();
    }
    // EAGAIN: copy the payload and let libuv drain it asynchronously.
    const wire = alloc.dupe(u8, payload) catch return undefinedValue();
    const sr = send_pool.create(alloc) catch {
        alloc.free(wire);
        return undefinedValue();
    };
    sr.body = wire;
    var qb = uv.Buf{ .base = @ptrCast(wire.ptr), .len = @intCast(wire.len) };
    if (uv.uv_udp_send(opaqueOf(&sr.req), opaqueOf(&socket), @ptrCast(&qb), 1, opaqueOf(&sa), &onSend) != 0) {
        alloc.free(sr.body);
        send_pool.destroy(sr);
    }
    return undefinedValue();
}

fn onSend(req: *anyopaque, status: c_int) callconv(.c) void {
    _ = status;
    const sr: *SendReq = @ptrCast(@alignCast(req));
    alloc.free(sr.body);
    send_pool.destroy(sr);
}

// udpClose() — stop receiving and close the socket.
pub fn close(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
    _ = e;
    _ = info;
    if (bound) {
        _ = uv.uv_udp_recv_stop(opaqueOf(&socket));
        uv.uv_close(opaqueOf(&socket), null);
        bound = false;
    }
    return undefinedValue();
}

fn dispatch(data: napi.Value, info_obj: napi.Value) void {
    if (dispatch_ref == null) return;
    var fn_val: napi.Value = undefined;
    if (napi.napi_get_reference_value(env, dispatch_ref, &fn_val) != napi.ok) return;
    var undef: napi.Value = undefined;
    _ = napi.napi_get_undefined(env, &undef);
    const args = [_]napi.Value{ data, info_obj };
    var result: napi.Value = undefined;
    if (napi.napi_call_function(env, undef, fn_val, 2, &args, &result) != napi.ok) {
        var ex: napi.Value = undefined;
        _ = napi.napi_get_and_clear_last_exception(env, &ex); // one bad handler can't kill the loop
    }
}

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
    var value: napi.Value = undefined;
    _ = napi.napi_get_named_property(e, options, name, &value);
    var kind: c_int = 0;
    _ = napi.napi_typeof(e, value, &kind);
    if (kind != napi.valuetype.boolean) return false;
    var out: bool = false;
    _ = napi.napi_get_value_bool(e, value, &out);
    return out;
}
