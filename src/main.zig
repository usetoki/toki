//! N-API addon entry point — just registers the functions exposed to JS.
//! HTTP/1.1 server runs single-threaded on Node's own libuv loop (no thread hop).
//! engine.zig: process state + connection type + buffers
//! loop.zig:   libuv callbacks + per-request pipeline (hot path)
//! server.zig: listen/close, options, static table, slowloris sweep

const napi = @import("napi.zig");
const server = @import("server.zig");
const loop = @import("loop.zig");
const stream = @import("stream.zig");

export fn napi_register_module_v1(env: napi.Env, exports: napi.Value) callconv(.c) napi.Value {
    defineFn(env, exports, "listen", &server.listen);
    defineFn(env, exports, "submitResponse", &loop.submitResponse);
    defineFn(env, exports, "startStream", &stream.startStream);
    defineFn(env, exports, "writeStreamChunk", &stream.writeStreamChunk);
    defineFn(env, exports, "endStream", &stream.endStream);
    defineFn(env, exports, "close", &server.closeServer);
    return exports;
}

fn defineFn(env: napi.Env, exports: napi.Value, name: [*c]const u8, cb: napi.Callback) void {
    var fnv: napi.Value = undefined;
    _ = napi.napi_create_function(env, name, napi.auto_length, cb, null, &fnv);
    _ = napi.napi_set_named_property(env, exports, name, fnv);
}
