//! Hand-declared libuv extern surface. Targets Node 24's bundled libuv (1.52.1);
//! symbols resolve against the host at load.
//!
//! Handles/reqs are opaque: allocated as raw byte blocks sized above the real C
//! structs (probed: uv_tcp_t=264, uv_write_t=192). `data` is the first field of
//! every uv handle/req, so a handle pointer == the address of our wrapper — we
//! recover the wrapper by plain cast, never by touching a field.

const builtin = @import("builtin");

// 16-byte-aligned storage for opaque uv handles/reqs, sized above the real structs
// on every platform (Windows handles are largest — they carry OVERLAPPED fields).
// libuv only touches sizeof(real) bytes, so the slack is harmless.
pub const tcp_size = 1024;
pub const write_size = 512;
// uv_udp_t and uv_udp_send_t, same generous over-sizing as the tcp/write blocks above.
pub const udp_size = 1024;
pub const udp_send_size = 512;

// uv_udp_bind / uv_udp_recv_start flags we use.
pub const UDP_REUSEADDR: c_uint = 4;
pub const UDP_RECVMMSG: c_uint = 256;

// uv_buf_t differs by platform: Windows is WSABUF order { ULONG len; char* base },
// unix is { char* base; size_t len }. Swapping them makes libuv read a garbage
// length and reset the connection. Named-field init below works for either order.
pub const Buf = if (builtin.os.tag == .windows)
    extern struct { len: c_ulong, base: [*c]u8 }
else
    extern struct { base: [*c]u8, len: usize };

// sockaddr_in, macOS/BSD layout: sin_len leads (no len field on Linux).
pub const SockaddrIn = extern struct {
    len: u8,
    family: u8,
    port: u16, // network byte order
    addr: u32, // network byte order
    zero: [8]u8,
};

pub const ConnectionCb = *const fn (server: *anyopaque, status: c_int) callconv(.c) void;
pub const AllocCb = *const fn (handle: *anyopaque, suggested: usize, buf: *Buf) callconv(.c) void;
pub const ReadCb = *const fn (stream: *anyopaque, nread: isize, buf: *const Buf) callconv(.c) void;
pub const WriteCb = *const fn (req: *anyopaque, status: c_int) callconv(.c) void;
pub const CloseCb = *const fn (handle: *anyopaque) callconv(.c) void;
pub const ShutdownCb = *const fn (req: *anyopaque, status: c_int) callconv(.c) void;
// uv_shutdown_t is small; generous over-size like the other req blocks.
pub const shutdown_size = 128;

pub const TimerCb = *const fn (handle: *anyopaque) callconv(.c) void;
// recv_cb: addr is null on the "no more datagrams this pass" callback; flags carries UV_UDP_PARTIAL etc.
pub const UdpRecvCb = *const fn (handle: *anyopaque, nread: isize, buf: *const Buf, addr: ?*const anyopaque, flags: c_uint) callconv(.c) void;
pub const UdpSendCb = *const fn (req: *anyopaque, status: c_int) callconv(.c) void;

pub const timer_size = 256; // generous over the real uv_timer_t (unix ~152, Windows larger).

pub extern fn uv_tcp_init(loop: *anyopaque, handle: *anyopaque) c_int;
pub extern fn uv_tcp_bind(handle: *anyopaque, addr: *const anyopaque, flags: c_uint) c_int;
pub extern fn uv_ip4_addr(ip: [*c]const u8, port: c_int, addr: *anyopaque) c_int;
// unix-domain socket (named pipe on Windows): same uv_stream API for read/write.
pub extern fn uv_pipe_init(loop: *anyopaque, handle: *anyopaque, ipc: c_int) c_int;
pub extern fn uv_pipe_bind(handle: *anyopaque, name: [*c]const u8) c_int;
pub extern fn uv_tcp_getpeername(handle: *anyopaque, name: *anyopaque, namelen: *c_int) c_int;
pub extern fn uv_tcp_getsockname(handle: *anyopaque, name: *anyopaque, namelen: *c_int) c_int;
pub extern fn uv_ip_name(addr: *const anyopaque, dst: [*c]u8, size: usize) c_int;
pub extern fn uv_now(loop: *anyopaque) u64;
pub extern fn uv_timer_init(loop: *anyopaque, handle: *anyopaque) c_int;
pub extern fn uv_timer_start(handle: *anyopaque, cb: TimerCb, timeout: u64, repeat: u64) c_int;
pub extern fn uv_listen(stream: *anyopaque, backlog: c_int, cb: ConnectionCb) c_int;
pub extern fn uv_accept(server: *anyopaque, client: *anyopaque) c_int;
pub extern fn uv_read_start(stream: *anyopaque, alloc_cb: AllocCb, read_cb: ReadCb) c_int;
pub extern fn uv_read_stop(stream: *anyopaque) c_int;
pub extern fn uv_write(req: *anyopaque, stream: *anyopaque, bufs: [*]const Buf, nbufs: c_uint, cb: WriteCb) c_int;
// non-blocking, no req/alloc/cb: returns bytes written or negative err (UV_EAGAIN).
pub extern fn uv_try_write(stream: *anyopaque, bufs: [*]const Buf, nbufs: c_uint) c_int;
pub extern fn uv_tcp_nodelay(handle: *anyopaque, enable: c_int) c_int;
// half-close: flush queued writes, then shutdown(SHUT_WR) so the peer sees EOF.
pub extern fn uv_shutdown(req: *anyopaque, handle: *anyopaque, cb: ShutdownCb) c_int;
pub extern fn uv_close(handle: *anyopaque, cb: ?CloseCb) void;
// force-close: SO_LINGER(0) then close, so a wedged send buffer is discarded and the peer
// gets an RST immediately instead of a FIN that waits for a non-reading peer to drain.
pub extern fn uv_tcp_close_reset(handle: *anyopaque, cb: ?CloseCb) c_int;
// unref a handle so it never keeps Node's loop (and the process) alive on its own.
pub extern fn uv_unref(handle: *anyopaque) void;
pub extern fn uv_strerror(err: c_int) [*c]const u8;

// UDP. recv_start hands every datagram to recv_cb with the sender's sockaddr; send is
// async (req + cb), try_send is the non-blocking fast path (returns bytes or UV_EAGAIN).
pub extern fn uv_udp_init(loop: *anyopaque, handle: *anyopaque) c_int;
pub extern fn uv_udp_init_ex(loop: *anyopaque, handle: *anyopaque, flags: c_uint) c_int;
pub extern fn uv_udp_bind(handle: *anyopaque, addr: *const anyopaque, flags: c_uint) c_int;
pub extern fn uv_udp_recv_start(handle: *anyopaque, alloc_cb: AllocCb, recv_cb: UdpRecvCb) c_int;
pub extern fn uv_udp_recv_stop(handle: *anyopaque) c_int;
pub extern fn uv_udp_send(req: *anyopaque, handle: *anyopaque, bufs: [*]const Buf, nbufs: c_uint, addr: *const anyopaque, cb: UdpSendCb) c_int;
pub extern fn uv_udp_try_send(handle: *anyopaque, bufs: [*]const Buf, nbufs: c_uint, addr: *const anyopaque) c_int;
pub extern fn uv_udp_getsockname(handle: *anyopaque, name: *anyopaque, namelen: *c_int) c_int;
pub extern fn uv_ip6_addr(ip: [*c]const u8, port: c_int, addr: *anyopaque) c_int;
