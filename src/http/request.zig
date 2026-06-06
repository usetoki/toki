//! native↔JS marshaling for the dynamic path. strings copy into caller scratch (no alloc here).
//! body is an external buffer over the connection read buffer — valid only for the sync handler
//! turn, then the read buffer is recycled. don't retain it past the call.

const std = @import("std");
const napi = @import("../ffi/napi.zig");
const parser = @import("parser.zig");
const router = @import("router.zig");

/// slices borrow the caller's scratch buffers
pub const Response = struct {
    status: u16,
    headers: []const u8,
    body: []const u8,
};

/// body left unread so caller can size a buffer before reading (bodies can be large)
pub const Meta = struct {
    status: u16,
    headers: []const u8,
    body_value: napi.Value,
};

/// request object passed to the JS dispatcher; dispatch_id lets an async handler resolve later via submitResponse
pub fn build(env: napi.Env, head: *const parser.ParsedHead, body: ?[]const u8, route_index: u32, dispatch_id: u32, ip: []const u8, ip_ref: napi.Ref, params: []const router.Param) napi.Value {
    var obj: napi.Value = undefined;
    _ = napi.napi_create_object(env, &obj);

    setString(env, obj, "method", head.method);
    setString(env, obj, "path", head.path);
    setString(env, obj, "query", head.query);
    setString(env, obj, "rawHeaders", head.raw_headers);
    // reuse the connection's cached IP string; only unix sockets fall back to a fresh one
    if (ip_ref) |ref| {
        var ip_val: napi.Value = undefined;
        _ = napi.napi_get_reference_value(env, ref, &ip_val);
        _ = napi.napi_set_named_property(env, obj, "ip", ip_val);
    } else {
        setString(env, obj, "ip", ip);
    }

    var index: napi.Value = undefined;
    _ = napi.napi_create_uint32(env, route_index, &index);
    _ = napi.napi_set_named_property(env, obj, "routeIndex", index);

    var id: napi.Value = undefined;
    _ = napi.napi_create_uint32(env, dispatch_id, &id);
    _ = napi.napi_set_named_property(env, obj, "dispatchId", id);

    var body_val: napi.Value = undefined;
    if (body) |b| {
        _ = napi.napi_create_external_buffer(env, b.len, @ptrCast(@constCast(b.ptr)), null, null, &body_val);
    } else {
        _ = napi.napi_get_null(env, &body_val);
    }
    _ = napi.napi_set_named_property(env, obj, "body", body_val);

    // skip the object alloc when no captures — exact routes pay nothing
    var params_val: napi.Value = undefined;
    if (params.len > 0) {
        _ = napi.napi_create_object(env, &params_val);
        for (params) |p| setString(env, params_val, sentinel(p.name), p.value);
    } else {
        _ = napi.napi_get_null(env, &params_val);
    }
    _ = napi.napi_set_named_property(env, obj, "params", params_val);

    return obj;
}

// arena-owned param names aren't null-terminated but napi wants a C string;
// names are short so copy into a static buffer (single thread → reuse is safe)
fn sentinel(name: []const u8) [*c]const u8 {
    const S = struct {
        var buf: [256]u8 = undefined;
    };
    const n = @min(name.len, S.buf.len - 1);
    @memcpy(S.buf[0..n], name[0..n]);
    S.buf[n] = 0;
    return &S.buf;
}

/// body returned unread so caller can size a buffer to it; missing fields fall back
pub fn readMeta(env: napi.Env, value: napi.Value, headers_scratch: []u8) Meta {
    return .{
        .status = readStatus(env, value),
        .headers = readStringField(env, value, "headers", headers_scratch),
        .body_value = getProp(env, value, "body") orelse null,
    };
}

/// Buffer/typed-array bodies returned zero-copy (valid only for the sync call); null for string bodies
pub fn bufferBody(env: napi.Env, body_value: napi.Value) ?[]const u8 {
    var data: ?*anyopaque = null;
    var len: usize = 0;
    if (napi.napi_get_buffer_info(env, body_value, &data, &len) != napi.ok) return null;
    const ptr = data orelse return null;
    return @as([*]const u8, @ptrCast(ptr))[0..len];
}

/// UTF-8 byte length of a string body, 0 if not a string
pub fn bodyLen(env: napi.Env, body_value: napi.Value) usize {
    if (typeOf(env, body_value) != napi.valuetype.string) return 0;
    var need: usize = 0;
    _ = napi.napi_get_value_string_utf8(env, body_value, null, 0, &need);
    return need;
}

pub fn readStringBody(env: napi.Env, body_value: napi.Value, dest: []u8) []const u8 {
    if (typeOf(env, body_value) != napi.valuetype.string) return "";
    var copied: usize = 0;
    _ = napi.napi_get_value_string_utf8(env, body_value, dest.ptr, dest.len, &copied);
    return dest[0..copied];
}

fn readStatus(env: napi.Env, obj: napi.Value) u16 {
    const v = getProp(env, obj, "status") orelse return 200;
    if (typeOf(env, v) != napi.valuetype.number) return 200;
    var n: u32 = 200;
    _ = napi.napi_get_value_uint32(env, v, &n);
    // a value that doesn't fit u16 (NaN/negative wrap to a huge u32, or status > 65535)
    // would panic on @intCast in debug and silently truncate in release — clamp to 500
    if (n > 65535) return 500;
    return @intCast(n);
}

fn readStringField(env: napi.Env, obj: napi.Value, name: [*c]const u8, scratch: []u8) []const u8 {
    const v = getProp(env, obj, name) orelse return "";
    if (typeOf(env, v) != napi.valuetype.string) return "";
    var copied: usize = 0;
    _ = napi.napi_get_value_string_utf8(env, v, scratch.ptr, scratch.len, &copied);
    return scratch[0..copied];
}

fn getProp(env: napi.Env, obj: napi.Value, name: [*c]const u8) ?napi.Value {
    var v: napi.Value = undefined;
    if (napi.napi_get_named_property(env, obj, name, &v) != napi.ok) return null;
    return v;
}

fn typeOf(env: napi.Env, v: napi.Value) c_int {
    var t: c_int = 0;
    _ = napi.napi_typeof(env, v, &t);
    return t;
}

fn setString(env: napi.Env, obj: napi.Value, name: [*c]const u8, value: []const u8) void {
    var v: napi.Value = undefined;
    _ = napi.napi_create_string_utf8(env, value.ptr, value.len, &v);
    _ = napi.napi_set_named_property(env, obj, name, v);
}
