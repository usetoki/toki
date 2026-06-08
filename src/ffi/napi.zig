//! Hand-declared N-API extern surface — avoids translate-c on the C headers.
//! Symbols resolve against the host Node process at dlopen (`-fallow-shlib-undefined`).
//! All N-API handles are opaque pointers, modeled as `?*anyopaque`.

const std = @import("std");

pub const Env = ?*anyopaque;
pub const Value = ?*anyopaque;
pub const Ref = ?*anyopaque;
pub const CallbackInfo = ?*anyopaque;
pub const HandleScope = ?*anyopaque;

pub const Callback = *const fn (Env, CallbackInfo) callconv(.c) Value;

pub const ok: c_int = 0;
pub const auto_length: usize = std.math.maxInt(usize);

// napi_valuetype discriminants
pub const valuetype = struct {
    pub const undef: c_int = 0;
    pub const nul: c_int = 1;
    pub const boolean: c_int = 2;
    pub const number: c_int = 3;
    pub const string: c_int = 4;
    pub const object: c_int = 6;
    pub const function: c_int = 7;
};

// external-buffer finalizer; always null since we own the backing memory — see request.zig
pub const Finalize = ?*const fn (Env, ?*anyopaque, ?*anyopaque) callconv(.c) void;

pub extern fn napi_create_function(env: Env, utf8name: [*c]const u8, length: usize, cb: Callback, data: ?*anyopaque, result: *Value) c_int;
pub extern fn napi_set_named_property(env: Env, object: Value, utf8name: [*c]const u8, value: Value) c_int;
pub extern fn napi_get_cb_info(env: Env, cbinfo: CallbackInfo, argc: *usize, argv: [*]Value, this_arg: ?*Value, data: ?*?*anyopaque) c_int;
pub extern fn napi_get_value_int32(env: Env, value: Value, result: *i32) c_int;
pub extern fn napi_create_reference(env: Env, value: Value, initial_refcount: u32, result: *Ref) c_int;
pub extern fn napi_get_reference_value(env: Env, ref: Ref, result: *Value) c_int;
pub extern fn napi_delete_reference(env: Env, ref: Ref) c_int;
pub extern fn napi_get_uv_event_loop(env: Env, loop: *?*anyopaque) c_int;
pub extern fn napi_get_undefined(env: Env, result: *Value) c_int;
pub extern fn napi_throw_error(env: Env, code: [*c]const u8, msg: [*c]const u8) c_int;
pub extern fn napi_call_function(env: Env, recv: Value, func: Value, argc: usize, argv: ?[*]const Value, result: *Value) c_int;
pub extern fn napi_get_value_string_utf8(env: Env, value: Value, buf: [*c]u8, bufsize: usize, result: *usize) c_int;
pub extern fn napi_open_handle_scope(env: Env, result: *HandleScope) c_int;
pub extern fn napi_close_handle_scope(env: Env, scope: HandleScope) c_int;
pub extern fn napi_get_and_clear_last_exception(env: Env, result: *Value) c_int;

// value construction + inspection for request/response marshaling
pub extern fn napi_create_object(env: Env, result: *Value) c_int;
pub extern fn napi_create_string_utf8(env: Env, str: [*c]const u8, length: usize, result: *Value) c_int;
pub extern fn napi_create_uint32(env: Env, value: u32, result: *Value) c_int;
pub extern fn napi_create_int32(env: Env, value: i32, result: *Value) c_int;
pub extern fn napi_get_named_property(env: Env, object: Value, utf8name: [*c]const u8, result: *Value) c_int;
pub extern fn napi_get_value_uint32(env: Env, value: Value, result: *u32) c_int;
pub extern fn napi_get_value_bool(env: Env, value: Value, result: *bool) c_int;
pub extern fn napi_get_value_double(env: Env, value: Value, result: *f64) c_int;
pub extern fn napi_typeof(env: Env, value: Value, result: *c_int) c_int;
pub extern fn napi_get_null(env: Env, result: *Value) c_int;
pub extern fn napi_get_array_length(env: Env, value: Value, result: *u32) c_int;
pub extern fn napi_get_element(env: Env, object: Value, index: u32, result: *Value) c_int;
pub extern fn napi_create_external_buffer(env: Env, length: usize, data: ?*anyopaque, finalize_cb: Finalize, finalize_hint: ?*anyopaque, result: *Value) c_int;
// copies `length` bytes into a fresh V8-owned Buffer — safe for the JS side to retain.
pub extern fn napi_create_buffer_copy(env: Env, length: usize, data: ?*const anyopaque, result_data: ?*?*anyopaque, result: *Value) c_int;
pub extern fn napi_get_buffer_info(env: Env, value: Value, data: *?*anyopaque, length: *usize) c_int;
