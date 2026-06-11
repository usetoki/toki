//! Linux io_uring backend for the raw TCP server — an alternative to the libuv path in
//! tcp.zig, selected by `createTcpServer(..., { engine: "io_uring" })`. Same JS dispatch
//! contract (the ev_* tags, the Socket in ts/net/tcp.ts), so nothing above the native
//! boundary changes.
//!
//! The ring is driven on Node's own libuv loop: its fd is watched with uv_poll, and every
//! completion is processed inside that poll callback — on the loop thread — so handlers are
//! still called synchronously with no thread hop. Reads use a shared provided-buffer ring
//! (the kernel picks a buffer from one bounded pool), so memory tracks the pool, not the
//! connection count. Plaintext only for now; TLS stays on the libuv engine.

const std = @import("std");
const builtin = @import("builtin");
const napi = @import("../ffi/napi.zig");
const uv = @import("../ffi/uv.zig");
const addr = @import("addr.zig");

const is_linux = builtin.os.tag == .linux;

// public exports — the real backend on Linux, throwing stubs everywhere else, chosen at
// comptime so the io_uring code is never analyzed on a non-Linux build.
const Backend = if (is_linux) Linux else Stub;
pub const listen = Backend.listen;
pub const send = Backend.send;
pub const end = Backend.end;
pub const closeSocket = Backend.closeSocket;
pub const closeServer = Backend.closeServer;
pub const peer = Backend.peer;
pub const available = Backend.available;

const Stub = struct {
    // io_uringAvailable() -> bool. False off Linux; on Linux, true only if the kernel and the
    // sandbox actually permit io_uring (a container's seccomp profile often blocks it), so the
    // TS layer can fall back to libuv with a clear message instead of failing the server.
    pub fn available(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
        _ = info;
        var out: napi.Value = undefined;
        _ = napi.napi_get_boolean(e, false, &out);
        return out;
    }
    fn unsupported(e: napi.Env) napi.Value {
        _ = napi.napi_throw_error(e, null, "toki: the io_uring transport requires Linux");
        var u: napi.Value = undefined;
        _ = napi.napi_get_undefined(e, &u);
        return u;
    }
    pub fn listen(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
        _ = info;
        return unsupported(e);
    }
    pub fn send(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
        _ = info;
        return unsupported(e);
    }
    pub fn end(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
        _ = info;
        return unsupported(e);
    }
    pub fn closeSocket(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
        _ = info;
        return unsupported(e);
    }
    pub fn closeServer(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
        _ = info;
        return unsupported(e);
    }
    pub fn peer(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
        _ = info;
        return unsupported(e);
    }
};

const Linux = struct {
    const linux = std.os.linux;
    const IoUring = linux.IoUring;
    const fd_t = linux.fd_t;
    const alloc = std.heap.c_allocator;

    // event tags handed to the JS dispatcher, matched in ts/net/tcp.ts (same as tcp.zig)
    const ev_connection: u32 = 0;
    const ev_data: u32 = 1;
    const ev_drain: u32 = 2;
    const ev_close: u32 = 3;
    const ev_end: u32 = 4;

    // ring + buffer-pool sizing. The pool is shared by every connection's reads, so total
    // read memory is buf_count*buf_size no matter how many sockets are live.
    const ring_entries: u16 = 4096;
    const buf_count: u16 = 256;
    const buf_size: u32 = 16 * 1024;
    const buf_group_id: u16 = 1;

    const default_max_write_queue: usize = 16 * 1024 * 1024;

    // user_data: (conn id << 2 | tag) for every per-connection op. ids start at 1, so the
    // all-zero-id value 3 is free to mean ACCEPT (which has no connection yet).
    const tag_send: u64 = 0;
    const tag_recv: u64 = 1;
    const tag_accept: u64 = 3;

    fn udSend(id: u32) u64 {
        return @as(u64, id) << 2; // tag 0
    }
    fn udRecv(id: u32) u64 {
        return (@as(u64, id) << 2) | tag_recv;
    }

    const Conn = struct {
        fd: fd_t,
        id: u32,
        closing: bool,
        recv_active: bool, // a multishot recv is in flight for this conn
        read_ended: bool,
        queued_bytes: usize,
        in_flight: u32, // recv (0/1) + an in-flight send (0/1) + a close op (0/1)
        // FIFO of pending writes. TCP is a byte stream and io_uring does NOT order
        // independent SEND SQEs, so only the head is ever in flight; the next is submitted
        // when it completes. This is the same one-write-at-a-time discipline as the libuv path.
        send_head: ?*SendOp,
        send_tail: ?*SendOp,
        sending: bool,
        end_pending: bool, // end() was called with writes still queued; FIN after they flush
        write_shutdown: bool, // our FIN has been sent (SHUT_WR)
        finalized: bool, // torn down already — guards against a re-entrant double free
        peer_recorded: bool,
        remote_ip: [46]u8,
        remote_port: u16,
        next: ?*Conn,
        prev: ?*Conn,
    };

    // one queued write: the kernel reads from body until the send completes, so body is
    // owned here and freed when the send finishes. off resumes a partial send.
    const SendOp = struct {
        body: []u8,
        off: usize,
        next: ?*SendOp,
    };

    var env: napi.Env = null;
    var loop: ?*anyopaque = null;
    var dispatch_ref: napi.Ref = null;

    const page_align = std.heap.page_size_min;
    var ring: IoUring = undefined;
    var ring_up = false;
    // Shared provided-buffer ring, non-incremental: the kernel fills one whole buffer per
    // recv completion and we recycle it immediately, so a connection closing mid-read can't
    // strand a half-used buffer (the incremental mode does, which drains the pool).
    var buf_pool: []u8 = &.{};
    var buf_ring: *align(page_align) linux.io_uring_buf_ring = undefined;
    var buf_mask: u16 = 0;
    var poll_handle: [uv.poll_size]u8 align(16) = undefined;
    var poll_active = false;
    // closeServer hands the poll handle to libuv, which only finishes closing it on a later
    // loop turn; re-initializing it before then would corrupt libuv's handle state, so a
    // re-listen is blocked until onPollClose clears this.
    var poll_closing = false;

    var listen_fd: fd_t = -1;
    var listening = false;
    var no_delay = true;
    var max_write_queue: usize = default_max_write_queue;

    var pool: std.heap.MemoryPool(Conn) = .empty;
    var conns: std.AutoHashMapUnmanaged(u32, *Conn) = .empty;
    var conn_list: ?*Conn = null;
    // conns whose teardown finished mid-callback; their memory is freed once the callback
    // unwinds (drainDead), so a re-entrant dispatch can't reuse a slot still on the stack.
    var dead_list: ?*Conn = null;
    // re-entrancy depth across the poll callback and the napi entry points; dead conns are
    // freed only when it returns to zero, i.e. once the outermost call has fully unwound.
    var cb_depth: u32 = 0;
    var next_id: u32 = 1;

    var cqes: [256]linux.io_uring_cqe = undefined;

    fn opaqueOf(p: anytype) *anyopaque {
        return @ptrCast(p);
    }

    fn nextId() u32 {
        const id = next_id;
        next_id +%= 1;
        if (next_id == 0) next_id = 1;
        return id;
    }

    // raw syscall return: negative-as-unsigned is -errno.
    fn sysOk(rc: usize) bool {
        return @as(isize, @bitCast(rc)) >= 0;
    }

    // io_uringAvailable() -> bool. Probe by actually setting up (and tearing down) a tiny
    // ring; a blocked syscall (seccomp) or an old kernel returns an error, so this is true
    // only when io_uring will really work for listen().
    pub fn available(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
        _ = info;
        var ok = false;
        if (IoUring.init(8, 0)) |*probe| {
            @constCast(probe).deinit();
            ok = true;
        } else |_| {}
        var out: napi.Value = undefined;
        _ = napi.napi_get_boolean(e, ok, &out);
        return out;
    }

    // tcpUringListen(port, host, options, dispatch) -> bound port (0 on failure, after throwing)
    pub fn listen(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
        var argc: usize = 4;
        var argv: [4]napi.Value = undefined;
        _ = napi.napi_get_cb_info(e, info, &argc, &argv, null, null);

        env = e;
        _ = napi.napi_get_uv_event_loop(e, &loop);

        if (listening) {
            _ = napi.napi_throw_error(e, null, "toki: a TCP server is already listening in this process");
            return uintValue(e, 0);
        }
        if (poll_closing) {
            _ = napi.napi_throw_error(e, null, "toki: the previous TCP server is still closing");
            return uintValue(e, 0);
        }

        var port: i32 = 0;
        _ = napi.napi_get_value_int32(e, argv[0], &port);
        var host: [256]u8 = .{ '0', '.', '0', '.', '0', '.', '0' } ++ .{0} ** 249;
        var hlen: usize = 0;
        _ = napi.napi_get_value_string_utf8(e, argv[1], &host, host.len, &hlen);

        no_delay = optBoolDefault(e, argv[2], "noDelay", true);
        const backlog: u32 = @intCast(optInt(e, argv[2], "backlog") orelse 512);
        max_write_queue = default_max_write_queue;
        if (optInt(e, argv[2], "maxWriteQueue")) |v| {
            if (v > 0) max_write_queue = @intCast(v);
        }
        if (readBufferProp(e, argv[2], "tlsCert") != null) {
            _ = napi.napi_throw_error(e, null, "toki: TLS is not supported on the io_uring engine yet — use the default engine");
            return uintValue(e, 0);
        }

        _ = napi.napi_create_reference(e, argv[3], 1, &dispatch_ref);

        var sa: [128]u8 align(8) = undefined;
        if (!addr.parse(&host, hlen, port, &sa)) {
            _ = napi.napi_throw_error(e, null, "tcp: invalid bind address");
            return uintValue(e, 0);
        }
        const family: u32 = @as(*align(8) const linux.sockaddr, @ptrCast(&sa)).family;

        const sfd = linux.socket(family, linux.SOCK.STREAM | linux.SOCK.CLOEXEC, 0);
        if (!sysOk(sfd)) {
            _ = napi.napi_throw_error(e, null, "tcp: socket() failed");
            return uintValue(e, 0);
        }
        const fd: fd_t = @intCast(sfd);
        _ = linux.setsockopt(fd, linux.SOL.SOCKET, linux.SO.REUSEADDR, std.mem.asBytes(&@as(c_int, 1)), 4);
        if (optBool(e, argv[2], "reusePort")) {
            _ = linux.setsockopt(fd, linux.SOL.SOCKET, linux.SO.REUSEPORT, std.mem.asBytes(&@as(c_int, 1)), 4);
        }
        if (!sysOk(linux.bind(fd, @ptrCast(&sa), sockLen(family)))) {
            _ = linux.close(fd);
            _ = napi.napi_throw_error(e, null, "tcp: bind failed (address in use?)");
            return uintValue(e, 0);
        }
        if (!sysOk(linux.listen(fd, backlog))) {
            _ = linux.close(fd);
            _ = napi.napi_throw_error(e, null, "tcp: listen failed");
            return uintValue(e, 0);
        }
        listen_fd = fd;

        ring = IoUring.init(ring_entries, 0) catch {
            _ = linux.close(fd);
            _ = napi.napi_throw_error(e, null, "tcp: io_uring_setup failed (kernel too old, or blocked by seccomp)");
            return uintValue(e, 0);
        };
        ring_up = true;
        if (!setupBuffers()) {
            teardownRing();
            _ = linux.close(fd);
            _ = napi.napi_throw_error(e, null, "tcp: provided-buffer ring setup failed");
            return uintValue(e, 0);
        }

        armAccept();
        _ = ring.submit() catch {};

        if (uv.uv_poll_init(loop.?, opaqueOf(&poll_handle), @intCast(ring.fd)) != 0) {
            _ = napi.napi_throw_error(e, null, "tcp: uv_poll_init on the ring fd failed");
            return uintValue(e, 0);
        }
        _ = uv.uv_poll_start(opaqueOf(&poll_handle), uv.UV_READABLE, &onRingReadable);
        poll_active = true;
        listening = true;

        return uintValue(e, boundPort(fd));
    }

    fn sockLen(family: u32) linux.socklen_t {
        return if (family == linux.AF.INET6) @sizeOf(linux.sockaddr.in6) else @sizeOf(linux.sockaddr.in);
    }

    fn boundPort(fd: fd_t) u32 {
        var ss: [128]u8 align(8) = undefined;
        var len: linux.socklen_t = ss.len;
        if (!sysOk(linux.getsockname(fd, @ptrCast(&ss), &len))) return 0;
        return addr.portOf(&ss);
    }

    fn armAccept() void {
        _ = ring.accept_multishot(tag_accept, listen_fd, null, null, linux.SOCK.CLOEXEC) catch {
            _ = ring.submit() catch {};
            _ = ring.accept_multishot(tag_accept, listen_fd, null, null, linux.SOCK.CLOEXEC) catch {};
        };
    }

    // libuv tells us the ring fd is readable: drain every completion, then flush any SQEs
    // the handlers queued. Runs on the loop thread, so JS dispatch here is synchronous.
    fn onRingReadable(handle: *anyopaque, status: c_int, events: c_int) callconv(.c) void {
        _ = handle;
        _ = status;
        _ = events;
        enter();
        defer leave();
        while (true) {
            const n = ring.copy_cqes(&cqes, 0) catch break;
            if (n == 0) break;
            for (cqes[0..n]) |cqe| processCqe(cqe);
            // flush the SQEs this batch queued before draining more — otherwise a busy batch
            // can overrun the submission queue and get_sqe starts failing (dropped ops).
            _ = ring.submit() catch {};
            if (n < cqes.len) break; // drained this pass
        }
    }

    fn processCqe(cqe: linux.io_uring_cqe) void {
        switch (cqe.user_data & 3) {
            tag_accept => onAccept(cqe),
            tag_recv => onRecv(cqe, @intCast(cqe.user_data >> 2)),
            tag_send => onSend(cqe, @intCast(cqe.user_data >> 2)),
            else => {}, // tag_close is no longer submitted; ignore any stray value defensively
        }
    }

    fn onAccept(cqe: linux.io_uring_cqe) void {
        // multishot: a clear F_MORE means the accept SQE is spent — re-arm it.
        if (cqe.flags & linux.IORING_CQE_F_MORE == 0) {
            if (listening) armAccept();
        }
        if (cqe.res < 0) return;
        const fd: fd_t = @intCast(cqe.res);
        if (no_delay) setNoDelay(fd);

        const conn = pool.create(alloc) catch {
            _ = linux.close(fd);
            return;
        };
        conn.* = .{
            .fd = fd,
            .id = nextId(),
            .closing = false,
            .recv_active = false,
            .read_ended = false,
            .queued_bytes = 0,
            .in_flight = 0,
            .send_head = null,
            .send_tail = null,
            .sending = false,
            .end_pending = false,
            .write_shutdown = false,
            .finalized = false,
            .peer_recorded = false,
            .remote_ip = [_]u8{0} ** 46,
            .remote_port = 0,
            .next = null,
            .prev = null,
        };
        conns.put(alloc, conn.id, conn) catch {
            _ = linux.close(fd);
            pool.destroy(conn);
            return;
        };
        addConn(conn);

        armRecv(conn);

        var scope: napi.HandleScope = undefined;
        _ = napi.napi_open_handle_scope(env, &scope);
        defer _ = napi.napi_close_handle_scope(env, scope);
        dispatch(conn.id, ev_connection, undefinedValue());
    }

    // build the provided-buffer ring and hand every buffer to the kernel.
    fn setupBuffers() bool {
        buf_pool = alloc.alloc(u8, @as(usize, buf_size) * buf_count) catch return false;
        buf_ring = IoUring.setup_buf_ring(ring.fd, buf_count, buf_group_id, .{ .inc = false }) catch {
            alloc.free(buf_pool);
            buf_pool = &.{};
            return false;
        };
        IoUring.buf_ring_init(buf_ring);
        buf_mask = IoUring.buf_ring_mask(buf_count);
        var i: u16 = 0;
        while (i < buf_count) : (i += 1) {
            IoUring.buf_ring_add(buf_ring, bufSlot(i), i, buf_mask, i);
        }
        IoUring.buf_ring_advance(buf_ring, buf_count);
        return true;
    }

    fn bufSlot(id: u16) []u8 {
        const pos = @as(usize, buf_size) * id;
        return buf_pool[pos .. pos + buf_size];
    }

    // hand a consumed buffer back to the kernel so it can be filled again.
    fn recycleBuf(id: u16) void {
        IoUring.buf_ring_add(buf_ring, bufSlot(id), id, buf_mask, 0);
        IoUring.buf_ring_advance(buf_ring, 1);
    }

    fn armRecv(conn: *Conn) void {
        if (conn.closing or conn.recv_active) return;
        if (!submitRecv(conn)) {
            // SQ full: flush it and retry once. If it still won't take, drop the connection
            // rather than leave it accepted-but-never-reading (a silent hang).
            _ = ring.submit() catch {};
            if (!submitRecv(conn)) {
                startClose(conn);
                return;
            }
        }
        conn.recv_active = true;
        conn.in_flight += 1;
    }

    // a multishot recv that selects a buffer from the shared ring for every completion.
    fn submitRecv(conn: *Conn) bool {
        const sqe = ring.get_sqe() catch return false;
        sqe.prep_rw(.RECV, conn.fd, 0, 0, 0);
        sqe.rw_flags = 0;
        sqe.flags |= linux.IOSQE_BUFFER_SELECT;
        sqe.buf_index = buf_group_id;
        sqe.ioprio |= linux.IORING_RECV_MULTISHOT;
        sqe.user_data = udRecv(conn.id);
        return true;
    }

    fn onRecv(cqe: linux.io_uring_cqe, id: u32) void {
        const conn = conns.get(id) orelse return;
        // a multishot recv keeps the same SQE live across completions; F_MORE clear means it
        // is spent, so the in-flight hold it represented is released here.
        const more = cqe.flags & linux.IORING_CQE_F_MORE != 0;
        if (!more) {
            conn.recv_active = false;
            conn.in_flight -= 1;
        }

        if (cqe.res > 0) {
            if (cqe.buffer_id()) |bid| {
                const slice = bufSlot(bid)[0..@as(usize, @intCast(cqe.res))];
                if (!conn.closing) {
                    var scope: napi.HandleScope = undefined;
                    _ = napi.napi_open_handle_scope(env, &scope);
                    defer _ = napi.napi_close_handle_scope(env, scope);
                    var data_val: napi.Value = undefined;
                    // copy into a V8-owned Buffer so the kernel buffer can be recycled now
                    _ = napi.napi_create_buffer_copy(env, slice.len, slice.ptr, null, &data_val);
                    dispatch(conn.id, ev_data, data_val);
                }
                recycleBuf(bid);
            } else |_| {}
            if (!more and !conn.closing and !conn.read_ended) armRecv(conn);
        } else if (cqe.res == 0) {
            // EOF: peer half-closed. Tell JS once; the TS layer ends the write side. If we
            // already ended ours, both directions are done — tear the connection down.
            if (!conn.read_ended) {
                conn.read_ended = true;
                if (!conn.closing) {
                    var scope: napi.HandleScope = undefined;
                    _ = napi.napi_open_handle_scope(env, &scope);
                    defer _ = napi.napi_close_handle_scope(env, scope);
                    dispatch(conn.id, ev_end, undefinedValue());
                }
                closeIfDone(conn);
            }
        } else if (cqe.res == -@as(i32, @intFromEnum(linux.E.NOBUFS))) {
            // pool momentarily drained and the multishot ended — re-arm to keep reading.
            if (!conn.closing and !conn.read_ended) armRecv(conn);
        } else {
            startClose(conn); // a real error (reset, etc.): tear the connection down
        }

        // free the Conn if this was the last op on a closing connection. A no-op otherwise
        // (re-armed recv, a half-open EOF, or an error that just queued a close op).
        if (!more) finalize(conn);
    }

    // tcpUringSend(id, buffer) -> queued backlog bytes (0 when nothing is in flight)
    pub fn send(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
        enter();
        defer leave();
        var argc: usize = 2;
        var argv: [2]napi.Value = undefined;
        _ = napi.napi_get_cb_info(e, info, &argc, &argv, null, null);
        var id: u32 = 0;
        _ = napi.napi_get_value_uint32(e, argv[0], &id);
        var data: ?*anyopaque = null;
        var len: usize = 0;
        _ = napi.napi_get_buffer_info(e, argv[1], &data, &len);

        // 0xFFFFFFFF (send_gone in src/net/tcp.zig) means the connection is gone, so the TS
        // write() reports false instead of a bogus "flushed". A live backlog caps one below it.
        const conn = conns.get(id) orelse return uintValue(e, 0xFFFFFFFF);
        if (conn.closing) return uintValue(e, 0xFFFFFFFF);
        if (data) |d| if (len != 0) {
            enqueueSend(conn, @as([*]const u8, @ptrCast(d))[0..len]);
            kickSend(conn);
            _ = ring.submit() catch {};
        };
        return uintValue(e, @intCast(@min(conn.queued_bytes, 0xFFFFFFFE)));
    }

    // append a copy of bytes to the connection's write FIFO. Over the backlog cap, drop the
    // connection — a peer that has stopped reading can't be allowed to grow the heap forever.
    fn enqueueSend(conn: *Conn, bytes: []const u8) void {
        if (conn.queued_bytes +| bytes.len > max_write_queue) {
            startClose(conn);
            return;
        }
        const body = alloc.dupe(u8, bytes) catch return;
        const op = alloc.create(SendOp) catch {
            alloc.free(body);
            return;
        };
        op.* = .{ .body = body, .off = 0, .next = null };
        if (conn.send_tail) |tail| tail.next = op else conn.send_head = op;
        conn.send_tail = op;
        conn.queued_bytes += body.len;
    }

    // submit the head of the FIFO if nothing is in flight. Only one send rides the ring at a
    // time, which is what keeps the byte stream in order (io_uring won't order them for us).
    fn kickSend(conn: *Conn) void {
        if (conn.sending or conn.closing) return;
        const op = conn.send_head orelse return;
        _ = ring.send(udSend(conn.id), conn.fd, op.body[op.off..], linux.MSG.NOSIGNAL) catch {
            _ = ring.submit() catch {};
            _ = ring.send(udSend(conn.id), conn.fd, op.body[op.off..], linux.MSG.NOSIGNAL) catch return;
        };
        conn.sending = true;
        conn.in_flight += 1;
    }

    fn onSend(cqe: linux.io_uring_cqe, id: u32) void {
        const conn = conns.get(id) orelse return;
        conn.sending = false;
        conn.in_flight -= 1;
        const op = conn.send_head orelse return;

        if (cqe.res > 0) {
            const sent: usize = @intCast(cqe.res);
            conn.queued_bytes -|= sent;
            op.off += sent;
            if (op.off < op.body.len) {
                // partial write: leave the op at the head and send the rest next.
                kickSend(conn);
                _ = ring.submit() catch {};
                if (conn.closing) finalize(conn);
                return;
            }
        } else {
            // the send errored: those bytes will never go, so stop counting them.
            conn.queued_bytes -|= (op.body.len - op.off);
        }

        // this write is done: pop it, free it, and start the next.
        conn.send_head = op.next;
        if (conn.send_head == null) conn.send_tail = null;
        alloc.free(op.body);
        alloc.destroy(op);

        kickSend(conn);
        _ = ring.submit() catch {};

        if (conn.send_head == null and !conn.sending) {
            // the FIFO is empty: a deferred half-close can now send its FIN safely, and a
            // producer waiting on backpressure can resume.
            if (conn.end_pending and !conn.closing) {
                conn.end_pending = false;
                shutdownWrite(conn);
            }
            if (!conn.closing) {
                var scope: napi.HandleScope = undefined;
                _ = napi.napi_open_handle_scope(env, &scope);
                defer _ = napi.napi_close_handle_scope(env, scope);
                dispatch(conn.id, ev_drain, undefinedValue());
            }
        }
        if (conn.closing) finalize(conn);
    }

    // send our FIN and, if the peer already sent theirs, tear the connection down.
    fn shutdownWrite(conn: *Conn) void {
        if (conn.write_shutdown or conn.closing) return;
        conn.write_shutdown = true;
        _ = linux.shutdown(conn.fd, linux.SHUT.WR);
        closeIfDone(conn);
    }

    // both directions are finished (peer FIN received and ours sent): start teardown.
    fn closeIfDone(conn: *Conn) void {
        if (!conn.closing and conn.read_ended and conn.write_shutdown) startClose(conn);
    }

    // free any writes still queued on a connection (called from finalize, after its ring
    // ops are done, and from closeServer once the ring is gone).
    fn freeSendQueue(conn: *Conn) void {
        var op = conn.send_head;
        while (op) |o| {
            const nxt = o.next;
            alloc.free(o.body);
            alloc.destroy(o);
            op = nxt;
        }
        conn.send_head = null;
        conn.send_tail = null;
    }

    // tcpUringEnd(id) — half-close: stop our writes with a FIN, keep reading.
    pub fn end(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
        enter();
        defer leave();
        var argc: usize = 1;
        var argv: [1]napi.Value = undefined;
        _ = napi.napi_get_cb_info(e, info, &argc, &argv, null, null);
        var id: u32 = 0;
        _ = napi.napi_get_value_uint32(e, argv[0], &id);
        if (conns.get(id)) |conn| {
            if (!conn.closing and !conn.write_shutdown and !conn.end_pending) {
                // FIN must follow the queued writes, not race ahead of them: defer the
                // shutdown until the FIFO drains if anything is still pending.
                if (conn.send_head == null and !conn.sending) {
                    shutdownWrite(conn);
                } else {
                    conn.end_pending = true;
                }
            }
        }
        return undefinedValue();
    }

    // tcpUringClose(id) — drop a connection now.
    pub fn closeSocket(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
        enter();
        defer leave();
        var argc: usize = 1;
        var argv: [1]napi.Value = undefined;
        _ = napi.napi_get_cb_info(e, info, &argc, &argv, null, null);
        var id: u32 = 0;
        _ = napi.napi_get_value_uint32(e, argv[0], &id);
        if (conns.get(id)) |conn| {
            startClose(conn);
            finalize(conn);
            _ = ring.submit() catch {};
        }
        return undefinedValue();
    }

    // begin teardown. A multishot recv pins the socket inside io_uring, so close(fd) alone
    // won't bring the connection down — shutdown(SHUT_RDWR) does: the peer sees the teardown
    // at once and the pending recv (and any send) complete with EOF/error, releasing their
    // io_uring holds. finalize then closes the fd and frees the Conn once nothing is in
    // flight. If nothing is in flight there's no completion coming, so finalize runs now.
    fn startClose(conn: *Conn) void {
        if (conn.closing) return;
        conn.closing = true;
        if (conn.recv_active or conn.sending) {
            _ = linux.shutdown(conn.fd, linux.SHUT.RDWR);
        } else {
            finalize(conn);
        }
    }

    // free the Conn once it is closing and nothing the kernel still references remains. The
    // recv/send are done (so io_uring no longer holds the socket), so the fd is closed now.
    // The actual slot free is deferred to drainDead: dispatching ev_close re-enters JS, which
    // may call back in, and the trailing logic in onRecv/onSend still reads this conn — so its
    // memory must outlive the callback. The finalized flag makes a second call a no-op.
    fn finalize(conn: *Conn) void {
        if (conn.finalized or !conn.closing or conn.in_flight != 0) return;
        conn.finalized = true;
        _ = linux.close(conn.fd);
        freeSendQueue(conn);
        _ = conns.remove(conn.id);
        removeConn(conn);
        var scope: napi.HandleScope = undefined;
        _ = napi.napi_open_handle_scope(env, &scope);
        defer _ = napi.napi_close_handle_scope(env, scope);
        dispatch(conn.id, ev_close, undefinedValue());
        conn.next = dead_list;
        dead_list = conn;
    }

    // free the slots of connections finalized during a callback, now that it has unwound.
    fn drainDead() void {
        while (dead_list) |conn| {
            dead_list = conn.next;
            pool.destroy(conn);
        }
    }

    // mark entry into an outermost-trackable callback; free dead conns on the way out only
    // when this was the outermost (so a re-entrant napi call can't free a conn its caller
    // still holds on the stack).
    fn enter() void {
        cb_depth += 1;
    }
    fn leave() void {
        cb_depth -= 1;
        if (cb_depth == 0) drainDead();
    }

    // tcpUringPeer(id) -> { address, port } | undefined
    pub fn peer(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
        var argc: usize = 1;
        var argv: [1]napi.Value = undefined;
        _ = napi.napi_get_cb_info(e, info, &argc, &argv, null, null);
        var id: u32 = 0;
        _ = napi.napi_get_value_uint32(e, argv[0], &id);
        const conn = conns.get(id) orelse return undefinedValue();
        if (!conn.peer_recorded) recordPeer(conn);
        return remoteInfo(conn);
    }

    fn recordPeer(conn: *Conn) void {
        conn.peer_recorded = true;
        var ss: [128]u8 align(8) = undefined;
        var len: linux.socklen_t = ss.len;
        if (!sysOk(linux.getpeername(conn.fd, @ptrCast(&ss), &len))) return;
        addr.name(&ss, &conn.remote_ip);
        conn.remote_port = addr.portOf(&ss);
    }

    fn remoteInfo(conn: *Conn) napi.Value {
        var obj: napi.Value = undefined;
        _ = napi.napi_create_object(env, &obj);
        const ip = std.mem.sliceTo(&conn.remote_ip, 0);
        var addr_val: napi.Value = undefined;
        _ = napi.napi_create_string_utf8(env, ip.ptr, ip.len, &addr_val);
        _ = napi.napi_set_named_property(env, obj, "address", addr_val);
        var port_val: napi.Value = undefined;
        _ = napi.napi_create_uint32(env, conn.remote_port, &port_val);
        _ = napi.napi_set_named_property(env, obj, "port", port_val);
        return obj;
    }

    // tcpUringCloseServer() — stop accepting, close every live connection, tear the ring down.
    pub fn closeServer(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
        _ = e;
        _ = info;
        if (!listening) return undefinedValue();
        listening = false;
        if (poll_active) {
            _ = uv.uv_poll_stop(opaqueOf(&poll_handle));
            poll_closing = true;
            uv.uv_close(opaqueOf(&poll_handle), &onPollClose);
            poll_active = false;
        }
        if (listen_fd >= 0) {
            _ = linux.close(listen_fd);
            listen_fd = -1;
        }
        // Tear the ring down FIRST: io_uring_queue_exit cancels every in-flight op and
        // releases the kernel's hold on our recv buffers and send bodies. Only then is it
        // safe to free those bodies (a send still in flight would otherwise be a read of
        // freed memory) and the connections.
        teardownRing();

        var node = conn_list;
        while (node) |conn| {
            const nxt = conn.next;
            _ = linux.close(conn.fd);
            freeSendQueue(conn);
            _ = conns.remove(conn.id);
            removeConn(conn);
            var scope: napi.HandleScope = undefined;
            _ = napi.napi_open_handle_scope(env, &scope);
            dispatch(conn.id, ev_close, undefinedValue());
            _ = napi.napi_close_handle_scope(env, scope);
            pool.destroy(conn);
            node = nxt;
        }
        conns.clearAndFree(alloc);
        conn_list = null;
        drainDead(); // free any conns torn down just before close
        return undefinedValue();
    }

    // the poll handle block is free to be re-initialized by a later listen() only once
    // libuv has finished closing it.
    fn onPollClose(_: *anyopaque) callconv(.c) void {
        poll_closing = false;
    }

    fn teardownRing() void {
        if (!ring_up) return;
        if (buf_pool.len > 0) {
            IoUring.free_buf_ring(ring.fd, buf_ring, buf_count, buf_group_id);
            alloc.free(buf_pool);
            buf_pool = &.{};
        }
        ring.deinit();
        ring_up = false;
    }

    fn dispatch(id: u32, event: u32, arg: napi.Value) void {
        if (dispatch_ref == null) return;
        var fn_val: napi.Value = undefined;
        if (napi.napi_get_reference_value(env, dispatch_ref, &fn_val) != napi.ok) return;
        var undef: napi.Value = undefined;
        _ = napi.napi_get_undefined(env, &undef);
        var id_val: napi.Value = undefined;
        _ = napi.napi_create_uint32(env, id, &id_val);
        var ev_val: napi.Value = undefined;
        _ = napi.napi_create_uint32(env, event, &ev_val);
        const args = [_]napi.Value{ id_val, ev_val, arg };
        var result: napi.Value = undefined;
        if (napi.napi_call_function(env, undef, fn_val, 3, &args, &result) != napi.ok) {
            var ex: napi.Value = undefined;
            _ = napi.napi_get_and_clear_last_exception(env, &ex);
        }
    }

    fn setNoDelay(fd: fd_t) void {
        _ = linux.setsockopt(fd, linux.IPPROTO.TCP, linux.TCP.NODELAY, std.mem.asBytes(&@as(c_int, 1)), 4);
    }

    fn addConn(conn: *Conn) void {
        conn.prev = null;
        conn.next = conn_list;
        if (conn_list) |head| head.prev = conn;
        conn_list = conn;
    }

    fn removeConn(conn: *Conn) void {
        if (conn.prev) |p| p.next = conn.next else conn_list = conn.next;
        if (conn.next) |n| n.prev = conn.prev;
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

    fn readBufferProp(e: napi.Env, obj: napi.Value, name: [*c]const u8) ?[]const u8 {
        var value: napi.Value = undefined;
        _ = napi.napi_get_named_property(e, obj, name, &value);
        var data: ?*anyopaque = null;
        var body_len: usize = 0;
        if (napi.napi_get_buffer_info(e, value, &data, &body_len) != napi.ok) return null;
        const ptr = data orelse return null;
        if (body_len == 0) return null;
        return @as([*]const u8, @ptrCast(ptr))[0..body_len];
    }

    fn optBool(e: napi.Env, options: napi.Value, name: [*c]const u8) bool {
        return optBoolDefault(e, options, name, false);
    }

    fn optBoolDefault(e: napi.Env, options: napi.Value, name: [*c]const u8, default: bool) bool {
        var value: napi.Value = undefined;
        _ = napi.napi_get_named_property(e, options, name, &value);
        var kind: c_int = 0;
        _ = napi.napi_typeof(e, value, &kind);
        if (kind != napi.valuetype.boolean) return default;
        var out: bool = false;
        _ = napi.napi_get_value_bool(e, value, &out);
        return out;
    }

    fn optInt(e: napi.Env, options: napi.Value, name: [*c]const u8) ?c_int {
        var value: napi.Value = undefined;
        _ = napi.napi_get_named_property(e, options, name, &value);
        var kind: c_int = 0;
        _ = napi.napi_typeof(e, value, &kind);
        if (kind != napi.valuetype.number) return null;
        var out: i32 = 0;
        _ = napi.napi_get_value_int32(e, value, &out);
        return @intCast(out);
    }
};
