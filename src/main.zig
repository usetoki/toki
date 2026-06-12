//! N-API addon entry point — just registers the functions exposed to JS.
//! HTTP/1.1 server runs single-threaded on Node's own libuv loop (no thread hop).
//! engine.zig: process state + connection type + buffers
//! loop.zig:   libuv callbacks + per-request pipeline (hot path)
//! server.zig: listen/close, options, static table, slowloris sweep

const napi = @import("ffi/napi.zig");
const server = @import("core/server.zig");
const loop = @import("core/loop.zig");
const stream = @import("http/stream.zig");
const websocket = @import("websocket/session.zig");
const tcp = @import("net/tcp.zig");
const tcp_uring = @import("net/tcp_uring.zig");
const udp = @import("net/udp.zig");

export fn napi_register_module_v1(env: napi.Env, exports: napi.Value) callconv(.c) napi.Value {
    defineFn(env, exports, "listen", &server.listen);
    defineFn(env, exports, "submitResponse", &loop.submitResponse);
    defineFn(env, exports, "startStream", &stream.startStream);
    defineFn(env, exports, "writeStreamChunk", &stream.writeStreamChunk);
    defineFn(env, exports, "endStream", &stream.endStream);
    defineFn(env, exports, "wsSend", &websocket.send);
    defineFn(env, exports, "wsPing", &websocket.ping);
    defineFn(env, exports, "wsPong", &websocket.pong);
    defineFn(env, exports, "wsClose", &websocket.closeSocket);
    defineFn(env, exports, "close", &server.closeServer);
    // raw TCP server
    defineFn(env, exports, "tcpListen", &tcp.listen);
    defineFn(env, exports, "tcpConnect", &tcp.connect);
    defineFn(env, exports, "tcpSend", &tcp.send);
    defineFn(env, exports, "tcpPeer", &tcp.peer);
    defineFn(env, exports, "tcpExportKeyingMaterial", &tcp.exportKeyingMaterial);
    defineFn(env, exports, "tcpPeerCertificate", &tcp.peerCertificate);
    defineFn(env, exports, "tcpAlpnProtocol", &tcp.alpnProtocol);
    defineFn(env, exports, "tcpServerName", &tcp.serverName);
    defineFn(env, exports, "tcpPause", &tcp.pause);
    defineFn(env, exports, "tcpResume", &tcp.resumeRead);
    defineFn(env, exports, "tcpStopAccepting", &tcp.stopAccepting);
    defineFn(env, exports, "tcpSetTls", &tcp.setTls);
    defineFn(env, exports, "tcpUpgradeTls", &tcp.upgradeTls);
    defineFn(env, exports, "tcpEnd", &tcp.end);
    defineFn(env, exports, "tcpClose", &tcp.closeSocket);
    defineFn(env, exports, "tcpCloseServer", &tcp.closeServer);
    // raw TCP server, io_uring backend (Linux; throws elsewhere)
    defineFn(env, exports, "tcpUringListen", &tcp_uring.listen);
    defineFn(env, exports, "tcpUringSend", &tcp_uring.send);
    defineFn(env, exports, "tcpUringPeer", &tcp_uring.peer);
    defineFn(env, exports, "tcpUringEnd", &tcp_uring.end);
    defineFn(env, exports, "tcpUringClose", &tcp_uring.closeSocket);
    defineFn(env, exports, "tcpUringCloseServer", &tcp_uring.closeServer);
    defineFn(env, exports, "tcpUringAvailable", &tcp_uring.available);
    // UDP server
    defineFn(env, exports, "udpBind", &udp.bind);
    defineFn(env, exports, "udpSend", &udp.send);
    defineFn(env, exports, "udpClose", &udp.close);
    return exports;
}

fn defineFn(env: napi.Env, exports: napi.Value, name: [*c]const u8, cb: napi.Callback) void {
    var fnv: napi.Value = undefined;
    _ = napi.napi_create_function(env, name, napi.auto_length, cb, null, &fnv);
    _ = napi.napi_set_named_property(env, exports, name, fnv);
}
