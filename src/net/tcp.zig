//! Raw TCP server on Node's libuv loop. No HTTP, no parsing: accept a connection,
//! hand each read straight to JS as a zero-copy buffer, and write back with the same
//! try-write-then-queue backpressure the HTTP path uses. One server per process.
//!
//! Memory: a connection is just its uv handle plus a few fields. There's no per-conn
//! read buffer — reads land in a shared scratch and are forwarded synchronously — so a
//! million idle sockets cost about what the kernel charges, not megabytes of ours.

const std = @import("std");
const napi = @import("../ffi/napi.zig");
const uv = @import("../ffi/uv.zig");
const addr = @import("addr.zig");
const tlsmod = @import("../tls/tls.zig");

const alloc = std.heap.c_allocator;

// event tags handed to the JS dispatcher, matched in ts/net/tcp.ts
const ev_connection: u32 = 0;
const ev_data: u32 = 1;
const ev_drain: u32 = 2;
const ev_close: u32 = 3;
const ev_end: u32 = 4; // peer half-closed (FIN): our read side ended, write side still open

// a single non-reading peer plus a producer that ignores backpressure would grow the
// heap without bound (one alloc.dupe per ignored write). Cap the per-connection send
// backlog; a connection that blows past it is wedged or abusive, and gets dropped.
const default_max_write_queue = 16 * 1024 * 1024;
var max_write_queue: usize = default_max_write_queue;

// macOS kqueue can leave a socket's pending FIN/RST (an EVFILT_READ with no bytes) sitting
// undelivered while the loop sleeps on a far-off timer, so a server-side close stalls for
// seconds. A low-rate repeating tick forces the loop to re-poll, so a peer's EOF is seen
// within the interval. 0 disables it. Tunable via ServerOptions.eofPollMs.
const default_eof_poll_ms = 50;

// uv handle leads so a *handle is the same address as the *Conn (libuv keeps `data`
// at offset 0; recover the Conn by plain cast, never by touching a field).
const Conn = struct {
    handle: [uv.tcp_size]u8 align(16),
    id: u32,
    queued_bytes: usize,
    closing: bool,
    reading: bool,
    // a graceful uv_shutdown (tcpEnd) is in flight: close gracefully, never reset.
    // libuv forbids mixing uv_shutdown with uv_tcp_close_reset.
    shutting: bool,
    // peer half-closed (we got EOF): stop reading, but keep flushing our queued writes,
    // then close — a uv_close now would cancel them and truncate the response.
    read_ended: bool,
    remote_port: u16,
    remote_ip: [46]u8, // null-terminated; "" for an address that couldn't be read
    // peer address is read lazily: getpeername + the JS object are built only when the
    // handler first touches socket.remoteAddress/port/authorized (most accepts never do).
    peer_recorded: bool,
    // per-conn cipher state, null on a plaintext conn. The socket sees ciphertext;
    // app data is encrypted on write and decrypted on read through this.
    tls: ?*tlsmod.State,
    // on a TLS conn, ev_connection is held back until the handshake completes, so the JS
    // handler's first write is already over an established session (Node's 'secureConnection').
    tls_announced: bool,
    next: ?*Conn,
    prev: ?*Conn,
};

const WriteReq = struct {
    req: [uv.write_size]u8 align(16),
    body: []u8,
    conn: ?*Conn,
};

const ShutdownReq = struct {
    req: [uv.shutdown_size]u8 align(16),
    conn: *Conn,
};

const read_scratch_size = 64 * 1024;

var env: napi.Env = null;
var loop: ?*anyopaque = null;
var dispatch_ref: napi.Ref = null;
var server: [uv.tcp_size]u8 align(16) = undefined;
var listening = false;
var closing = false;
var no_delay = true;
var eof_poll_ms: u64 = default_eof_poll_ms;
// set at listen() when a cert/key pair is supplied; the TLS config is process-global
// (one server per process), same as the HTTPS path.
var tls_enabled = false;

var pool: std.heap.MemoryPool(Conn) = .empty;
var write_pool: std.heap.MemoryPool(WriteReq) = .empty;
var conns: std.AutoHashMapUnmanaged(u32, *Conn) = .empty;
var conn_list: ?*Conn = null;
var next_id: u32 = 1;

// shared by every connection's reads; a read is forwarded to JS before the next one runs.
var read_scratch: [read_scratch_size]u8 = undefined;

// TLS scratch, shared across connections. Single thread, sequential dispatch, so each is
// used and consumed within one synchronous call before the next connection touches it.
// out: handshake flights + encrypted records + close_notify.
var tls_out_scratch: [tlsmod.out_size]u8 = undefined;
// in: one libuv read of ciphertext (the partial carry copied to its front), so a read pulls
// many records at once. plain: the whole batch decrypts here before one dispatch. plain >= in
// (AEAD shrinks each record, so it always fits). 256 KiB ≈ 15 max records per read.
const tls_batch_size = 256 * 1024;
var tls_in_scratch: [tls_batch_size]u8 = undefined;
var tls_plain_scratch: [tls_batch_size]u8 = undefined;

// see default_eof_poll_ms. Unref'd, so it never holds the process open by itself; an empty
// body — its only job is to wake the loop so libuv re-polls and delivers any pending EOF.
var eof_timer: [uv.timer_size]u8 align(16) = undefined;
var eof_timer_active = false;
fn eofPoll(_: *anyopaque) callconv(.c) void {}

fn opaqueOf(p: anytype) *anyopaque {
    return @ptrCast(p);
}

// Unix seconds for client-cert validity. 0 on failure, which makes the handshake reject
// the cert — failing closed beats trusting a cert against a stale clock.
fn wallClockSeconds() i64 {
    var tv: uv.TimeVal64 = undefined;
    if (uv.uv_gettimeofday(&tv) != 0) return 0;
    return tv.tv_sec;
}

fn nextId() u32 {
    const id = next_id;
    next_id +%= 1;
    if (next_id == 0) next_id = 1;
    return id;
}

// tcpListen(port, host, options, dispatch) -> bound port (0 on bind failure, after throwing)
pub fn listen(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
    var argc: usize = 4;
    var argv: [4]napi.Value = undefined;
    _ = napi.napi_get_cb_info(e, info, &argc, &argv, null, null);

    env = e;
    _ = napi.napi_get_uv_event_loop(e, &loop);

    // a close from a previous server is still draining on the loop — the handle block
    // can't be re-initialized until its close callback fires.
    if (closing) {
        _ = napi.napi_throw_error(e, null, "toki: the previous TCP server is still closing");
        return uintValue(e, 0);
    }

    var port: i32 = 0;
    _ = napi.napi_get_value_int32(e, argv[0], &port);

    var host: [256]u8 = .{ '0', '.', '0', '.', '0', '.', '0' } ++ .{0} ** 249;
    var copied: usize = 0;
    _ = napi.napi_get_value_string_utf8(e, argv[1], &host, host.len, &copied);

    var bind_flags: c_uint = 0;
    if (optBool(e, argv[2], "reusePort")) bind_flags = 2; // UV_TCP_REUSEPORT
    no_delay = optBoolDefault(e, argv[2], "noDelay", true); // TCP_NODELAY on unless told otherwise
    const backlog: c_int = optInt(e, argv[2], "backlog") orelse 512;
    max_write_queue = default_max_write_queue;
    if (optInt(e, argv[2], "maxWriteQueue")) |v| {
        if (v > 0) max_write_queue = @intCast(v);
    }
    eof_poll_ms = default_eof_poll_ms;
    if (optInt(e, argv[2], "eofPollMs")) |v| {
        eof_poll_ms = if (v >= 0) @intCast(v) else 0;
    }

    _ = napi.napi_create_reference(e, argv[3], 1, &dispatch_ref);

    tls_enabled = false;
    if (!setupTls(e, argv[2])) return uintValue(e, 0); // bad cert/key → threw

    _ = uv.uv_tcp_init(loop.?, opaqueOf(&server));
    // sockaddr_storage-sized: an IPv6 sockaddr is larger than SockaddrIn.
    var sa: [128]u8 align(8) = undefined;
    if (!addr.parse(&host, copied, port, &sa)) {
        _ = napi.napi_throw_error(e, null, "tcp: invalid bind address");
        return uintValue(e, 0);
    }
    const bind_rc = uv.uv_tcp_bind(opaqueOf(&server), opaqueOf(&sa), bind_flags);
    if (bind_rc != 0) {
        _ = napi.napi_throw_error(e, null, uv.uv_strerror(bind_rc));
        return uintValue(e, 0);
    }
    const rc = uv.uv_listen(opaqueOf(&server), backlog, &onConnection);
    if (rc != 0) {
        _ = napi.napi_throw_error(e, null, uv.uv_strerror(rc));
        return uintValue(e, 0);
    }
    listening = true;
    if (eof_poll_ms > 0 and !eof_timer_active) {
        _ = uv.uv_timer_init(loop.?, opaqueOf(&eof_timer));
        _ = uv.uv_timer_start(opaqueOf(&eof_timer), &eofPoll, eof_poll_ms, eof_poll_ms);
        uv.uv_unref(opaqueOf(&eof_timer)); // never keep the loop alive on its own
        eof_timer_active = true;
    }

    var bound: [128]u8 align(8) = undefined;
    var blen: c_int = bound.len;
    var bound_port: u16 = 0;
    if (uv.uv_tcp_getsockname(opaqueOf(&server), opaqueOf(&bound), &blen) == 0) {
        bound_port = addr.portOf(&bound);
    }
    return uintValue(e, bound_port);
}

// cert+key → tlsmod.init (with optional client-cert CA); no cert means plaintext. Throws and
// returns false on a missing key or bad PEM. init copies what it keeps, so the JS buffers
// don't need to outlive this call.
fn setupTls(e: napi.Env, options: napi.Value) bool {
    const cert = readBufferProp(e, options, "tlsCert") orelse return true; // no cert → plaintext
    const key = readBufferProp(e, options, "tlsKey") orelse {
        _ = napi.napi_throw_error(e, null, "tls: `key` is required alongside `cert`");
        return false;
    };

    // optional mutual TLS: a client-CA bundle turns on a CertificateRequest. `require`
    // makes a missing or untrusted client cert fail the handshake. Without it the conn is
    // allowed and `authorized` on the connection event reflects whether one was presented.
    var client_auth: ?tlsmod.ClientAuthConfig = null;
    if (readBufferProp(e, options, "tlsClientCa")) |ca| {
        client_auth = .{ .ca_pem = ca, .require = optBool(e, options, "tlsRequireClient") };
    }

    tlsmod.init(alloc, cert, key, client_auth) catch |err| {
        var msg: [128]u8 = undefined;
        const text = std.fmt.bufPrintZ(&msg, "tls: {s}", .{@errorName(err)}) catch "tls: setup failed";
        _ = napi.napi_throw_error(e, null, text.ptr);
        return false;
    };
    tls_enabled = true;
    return true;
}

// null when absent or empty — an empty buffer is treated as not-present.
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

fn onConnection(srv: *anyopaque, status: c_int) callconv(.c) void {
    if (status != 0 or closing) return;
    const conn = pool.create(alloc) catch return;
    conn.* = .{
        .handle = undefined,
        .id = nextId(),
        .queued_bytes = 0,
        .closing = false,
        .reading = false,
        .shutting = false,
        .read_ended = false,
        .remote_port = 0,
        .remote_ip = [_]u8{0} ** 46,
        .peer_recorded = false,
        .tls = null,
        .tls_announced = false,
        .next = null,
        .prev = null,
    };
    _ = uv.uv_tcp_init(loop.?, opaqueOf(&conn.handle));
    addConn(conn);
    if (uv.uv_accept(srv, opaqueOf(&conn.handle)) != 0) {
        closeConn(conn);
        return;
    }
    if (no_delay) _ = uv.uv_tcp_nodelay(opaqueOf(&conn.handle), 1);
    conns.put(alloc, conn.id, conn) catch {
        closeConn(conn);
        return;
    };
    if (tls_enabled) {
        conn.tls = tlsmod.newState(alloc, wallClockSeconds()) orelse {
            closeConn(conn);
            return;
        };
    }

    // a TLS conn announces ev_connection only once the handshake completes (in tlsDrive), so
    // the JS handler's first write lands on an established session. A plaintext conn announces now.
    if (conn.tls == null) {
        var scope: napi.HandleScope = undefined;
        _ = napi.napi_open_handle_scope(env, &scope);
        defer _ = napi.napi_close_handle_scope(env, scope);
        // no peer object here; the JS Socket pulls it on demand via tcpPeer (most never do).
        dispatch(conn.id, ev_connection, undefinedValue());
    }

    armRead(conn);
}

fn recordPeer(conn: *Conn) void {
    conn.peer_recorded = true; // mark attempted; a failed read leaves "" / 0, don't retry
    var storage: [128]u8 align(8) = undefined;
    var namelen: c_int = storage.len;
    if (uv.uv_tcp_getpeername(opaqueOf(&conn.handle), &storage, &namelen) != 0) return;
    addr.name(&storage, &conn.remote_ip);
    conn.remote_port = addr.portOf(&storage);
}

// tcpPeer(id) -> { address, port, authorized? }. The JS Socket calls this the first time the
// handler reads a peer field, so a connection nobody inspects never pays getpeername or the
// N-API object build. Undefined if the id is gone (the socket already closed).
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
    // on a TLS conn, report whether the peer presented a valid client cert. The conn event
    // for a TLS conn is dispatched post-handshake (tlsDrive), so st.authorized is settled.
    if (conn.tls) |st| {
        var auth_val: napi.Value = undefined;
        _ = napi.napi_get_boolean(env, st.authorized, &auth_val);
        _ = napi.napi_set_named_property(env, obj, "authorized", auth_val);
    }
    return obj;
}

fn armRead(conn: *Conn) void {
    if (conn.reading or conn.closing) return;
    _ = uv.uv_read_start(opaqueOf(&conn.handle), &allocBuf, &onRead);
    conn.reading = true;
}

fn allocBuf(handle: *anyopaque, suggested: usize, buf: *uv.Buf) callconv(.c) void {
    _ = suggested;
    const conn: *Conn = @ptrCast(@alignCast(handle));
    // TLS reads ciphertext into the shared batch scratch so one read pulls many records.
    // The per-conn partial carry (a record that arrived split across reads) goes to the
    // front first; libuv fills the tail. st.in_len is the carry length, read back in onRead.
    if (conn.tls) |st| {
        if (st.in_len > 0) @memcpy(tls_in_scratch[0..st.in_len], st.in[0..st.in_len]);
        const tail = tls_in_scratch[st.in_len..];
        buf.* = .{ .base = @ptrCast(tail.ptr), .len = @intCast(tail.len) };
        return;
    }
    buf.* = .{ .base = @ptrCast(&read_scratch), .len = @intCast(read_scratch.len) };
}

fn onRead(stream: *anyopaque, nread: isize, buf: *const uv.Buf) callconv(.c) void {
    _ = buf;
    const conn: *Conn = @ptrCast(@alignCast(stream));
    // nread == 0 is EAGAIN, not EOF. Closing here would cancel an in-flight queued
    // write (uv_close aborts pending uv_write). Only nread < 0 means the read side ended.
    if (nread == 0) return;
    if (nread < 0) {
        // On a TLS conn a clean shutdown is a close_notify alert (surfaced as ev_end inside
        // tlsDrive). A bare TCP FIN/RST without it is a truncation, possibly an injected
        // reset, so close abnormally rather than report a graceful half-close.
        if (conn.tls != null) {
            closeConn(conn);
            return;
        }
        // peer half-closed (FIN/RST): the read side is done, but the write side stays open
        // so any in-flight or about-to-be-written response still flushes. Tell JS the read
        // ended; the TS layer ends the write side (default) or the app does it explicitly.
        if (conn.read_ended) return;
        conn.read_ended = true;
        if (conn.reading) {
            _ = uv.uv_read_stop(opaqueOf(&conn.handle));
            conn.reading = false;
        }
        var scope: napi.HandleScope = undefined;
        _ = napi.napi_open_handle_scope(env, &scope);
        defer _ = napi.napi_close_handle_scope(env, scope);
        dispatch(conn.id, ev_end, undefinedValue());
        return;
    }
    // TLS: libuv filled tls_in_scratch (carry + new bytes) with ciphertext. Drive the
    // handshake/record machine, which dispatches ev_data with decrypted plaintext.
    if (conn.tls) |st| {
        const total = st.in_len + @as(usize, @intCast(nread));
        tlsDrive(conn, st, tls_in_scratch[0..total]);
        return;
    }

    var scope: napi.HandleScope = undefined;
    _ = napi.napi_open_handle_scope(env, &scope);
    defer _ = napi.napi_close_handle_scope(env, scope);

    // copy into a V8-owned Buffer so a handler may keep it past this synchronous dispatch.
    // the shared scratch gets reused by the next read.
    var data_val: napi.Value = undefined;
    _ = napi.napi_create_buffer_copy(env, @intCast(nread), &read_scratch, null, &data_val);
    dispatch(conn.id, ev_data, data_val);
}

// Drive a TLS connection over `cipher` (the shared ciphertext scratch: a partial carry from
// st.in followed by this read's bytes). Finish the handshake — its output is already ciphertext,
// so it goes straight to a raw write — then decrypt every complete record in one pass and hand
// the coalesced plaintext to JS in a single ev_data. The partial trailing record is carried back
// into st.in for the next read. Handshake completion releases the held-back ev_connection; a peer
// close_notify surfaces as ev_end after the plaintext that rode in ahead of it is dispatched.
fn tlsDrive(conn: *Conn, st: *tlsmod.State, cipher_in: []const u8) void {
    var scope: napi.HandleScope = undefined;
    _ = napi.napi_open_handle_scope(env, &scope);
    defer _ = napi.napi_close_handle_scope(env, scope);

    var cipher = cipher_in;

    if (!st.established) {
        const h = tlsmod.handshakeBuf(st, cipher, &tls_out_scratch);
        if (h.send.len > 0) rawWriteAll(conn, h.send); // already ciphertext — never re-encrypt
        if (h.failed) {
            closeConn(conn);
            return;
        }
        cipher = cipher[h.consumed..];
        if (!st.established) {
            // need more of the client's handshake — carry the partial record
            if (!tlsmod.carry(st, cipher)) closeConn(conn);
            return;
        }
        if (!conn.tls_announced) {
            conn.tls_announced = true;
            dispatch(conn.id, ev_connection, undefinedValue());
            if (conn.closing) return; // handler may have destroyed it on connect
        }
        // fall through to drain any app records that rode in with the final handshake flight
    }

    // One pass decrypts every complete record (plain scratch >= cipher scratch, so nothing is
    // dropped); the trailing partial, if any, comes back as the unconsumed tail.
    const b = tlsmod.decryptBatch(st, cipher, &tls_plain_scratch);
    if (b.failed) {
        closeConn(conn);
        return;
    }
    if (b.plain_len > 0) {
        var data_val: napi.Value = undefined;
        _ = napi.napi_create_buffer_copy(env, b.plain_len, &tls_plain_scratch, null, &data_val);
        dispatch(conn.id, ev_data, data_val);
        if (conn.closing) return; // a data handler may have torn the conn down
    }
    if (b.closed) {
        // peer's close_notify: treat as a half-close (EOF), same as a TCP FIN. Any plaintext
        // ahead of it was just dispatched above.
        if (conn.read_ended) return;
        conn.read_ended = true;
        if (conn.reading) {
            _ = uv.uv_read_stop(opaqueOf(&conn.handle));
            conn.reading = false;
        }
        dispatch(conn.id, ev_end, undefinedValue());
        return;
    }

    const tail = cipher[b.consumed..];
    if (!tlsmod.carry(st, tail)) {
        closeConn(conn); // carry overflow: an oversized record that can't be a legal TLS frame
        return;
    }
    // A header claiming a payload past the TLS 1.3 cap (2^14 + 256) can never complete; left
    // alone it sits in the carry and stalls the connection — a TLS-level slowloris. Close it.
    if (st.in_len >= 5) {
        const claimed = (@as(usize, st.in[3]) << 8) | @as(usize, st.in[4]);
        if (claimed > tlsmod.max_cleartext + 256) closeConn(conn);
    }
}

// --- write path (shared invariant: once anything is queued, everything queues so a
//     fast uv_try_write can never reorder ahead of the FIFO write queue) ------------

// Every byte the app sends funnels through here. On a TLS conn the plaintext is encrypted
// into one-record chunks first (each ciphertext record then takes the raw path); a plaintext
// conn writes straight to the socket. A write before the handshake finishes shouldn't happen
// (ev_connection is delayed until established), but guard anyway: drop it rather than send
// plaintext over a half-open session.
fn writeAll(conn: *Conn, plaintext: []const u8) void {
    if (conn.closing) return;
    if (conn.tls) |st| {
        if (!st.established) return;
        var rest = plaintext;
        while (rest.len > 0) {
            // one record's worth of plaintext per round yields exactly one ciphertext record,
            // which fits tls_out_scratch's single-record window (mirrors the HTTPS path).
            const take = @min(rest.len, tlsmod.max_cleartext);
            const w = tlsmod.encrypt(st, rest[0..take], tls_out_scratch[0..tlsmod.out_record]);
            if (w.failed) {
                closeConn(conn);
                return;
            }
            rawWriteAll(conn, w.ciphertext);
            rest = rest[take..];
        }
        return;
    }
    rawWriteAll(conn, plaintext);
}

// raw byte path: handshake output, close_notify, and per-record ciphertext go straight here;
// plaintext conns reach it from writeAll. Carries the try-write→queue backpressure + FIFO
// invariant + the maxWriteQueue cap.
fn rawWriteAll(conn: *Conn, bytes: []const u8) void {
    if (conn.closing) return;
    if (conn.queued_bytes != 0) {
        queueTail(conn, bytes);
        return;
    }
    var b = uv.Buf{ .base = @ptrCast(@constCast(bytes.ptr)), .len = @intCast(bytes.len) };
    const rc = uv.uv_try_write(opaqueOf(&conn.handle), @ptrCast(&b), 1);
    const written: usize = if (rc > 0) @intCast(rc) else 0;
    if (written == bytes.len) return;
    queueTail(conn, bytes[written..]);
}

// drop a connection whose unflushed backlog blew the ceiling. a non-reading peer that an
// app keeps writing to can't be allowed to exhaust process memory.
fn overCapacity(conn: *Conn, extra: usize) bool {
    if (conn.queued_bytes + extra <= max_write_queue) return false;
    closeConn(conn);
    return true;
}

fn queueTail(conn: *Conn, tail: []const u8) void {
    if (overCapacity(conn, tail.len)) return;
    const wire = alloc.dupe(u8, tail) catch return;
    const wr = write_pool.create(alloc) catch {
        alloc.free(wire);
        return;
    };
    wr.body = wire;
    wr.conn = conn;
    conn.queued_bytes +|= wire.len;
    var b = uv.Buf{ .base = @ptrCast(wire.ptr), .len = @intCast(wire.len) };
    if (uv.uv_write(opaqueOf(&wr.req), opaqueOf(&conn.handle), @ptrCast(&b), 1, &onWrite) != 0) {
        conn.queued_bytes -|= wire.len;
        alloc.free(wr.body);
        write_pool.destroy(wr);
    }
}

fn onWrite(req: *anyopaque, status: c_int) callconv(.c) void {
    _ = status;
    const wr: *WriteReq = @ptrCast(@alignCast(req));
    if (wr.conn) |conn| {
        conn.queued_bytes -|= wr.body.len;
        // backlog cleared, let the producer resume. The write side stays open after a peer
        // half-close (the TS layer ends it once its own backlog has flushed), so a drain
        // here never closes the connection itself.
        if (!conn.closing and conn.queued_bytes == 0) {
            var scope: napi.HandleScope = undefined;
            _ = napi.napi_open_handle_scope(env, &scope);
            defer _ = napi.napi_close_handle_scope(env, scope);
            dispatch(conn.id, ev_drain, undefinedValue());
        }
    }
    alloc.free(wr.body);
    write_pool.destroy(wr);
}

// tcpSend(id, buffer) -> queued backlog bytes (0 when flushed); 0 for an unknown id.
pub fn send(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
    var argc: usize = 2;
    var argv: [2]napi.Value = undefined;
    _ = napi.napi_get_cb_info(e, info, &argc, &argv, null, null);

    var id: u32 = 0;
    _ = napi.napi_get_value_uint32(e, argv[0], &id);
    var data: ?*anyopaque = null;
    var len: usize = 0;
    _ = napi.napi_get_buffer_info(e, argv[1], &data, &len);

    const conn = conns.get(id) orelse return uintValue(e, 0);
    if (data) |d| if (len != 0) writeAll(conn, @as([*]const u8, @ptrCast(d))[0..len]);
    return uintValue(e, @intCast(@min(conn.queued_bytes, std.math.maxInt(u32))));
}

// tcpEnd(id) — half-close: flush queued writes, then send FIN. The peer reads the rest,
// then sees EOF; onClose still fires when the socket finally goes away.
pub fn end(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
    var argc: usize = 1;
    var argv: [1]napi.Value = undefined;
    _ = napi.napi_get_cb_info(e, info, &argc, &argv, null, null);
    var id: u32 = 0;
    _ = napi.napi_get_value_uint32(e, argv[0], &id);

    const conn = conns.get(id) orelse return undefinedValue();
    if (conn.closing) return undefinedValue();
    // a TLS half-close must send close_notify, then tear down. a bare uv_shutdown FIN reads as
    // a truncation attack to the peer. closeConn sends the alert and resets, which the client
    // sees as a clean TLS close. Plaintext keeps the graceful uv_shutdown FIN.
    if (conn.tls != null) {
        closeConn(conn);
        return undefinedValue();
    }
    const sr = alloc.create(ShutdownReq) catch {
        closeConn(conn);
        return undefinedValue();
    };
    sr.conn = conn;
    conn.shutting = true; // graceful close from here; never reset (libuv forbids the mix)
    if (uv.uv_shutdown(opaqueOf(&sr.req), opaqueOf(&conn.handle), &onShutdown) != 0) {
        conn.shutting = false;
        alloc.destroy(sr);
        closeConn(conn);
    }
    return undefinedValue();
}

fn onShutdown(req: *anyopaque, status: c_int) callconv(.c) void {
    _ = status;
    const sr: *ShutdownReq = @ptrCast(@alignCast(req));
    const conn = sr.conn;
    alloc.destroy(sr);
    closeConn(conn);
}

// tcpClose(id) — drop a connection now (RST/FIN, no flush guarantee).
pub fn closeSocket(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
    var argc: usize = 1;
    var argv: [1]napi.Value = undefined;
    _ = napi.napi_get_cb_info(e, info, &argc, &argv, null, null);
    var id: u32 = 0;
    _ = napi.napi_get_value_uint32(e, argv[0], &id);
    if (conns.get(id)) |conn| closeConn(conn);
    return undefinedValue();
}

fn closeConn(conn: *Conn) void {
    if (conn.closing) return;
    // graceful TLS shutdown: best-effort close_notify before the socket goes away. Must run
    // before closing flips on (rawWriteAll is a no-op once closing) and before the FIN/RST.
    if (conn.tls) |st| {
        if (st.established and !st.sent_close) {
            st.sent_close = true;
            rawWriteAll(conn, tlsmod.closeNotify(st, &tls_out_scratch));
        }
    }
    conn.closing = true;
    if (conn.reading) {
        _ = uv.uv_read_stop(opaqueOf(&conn.handle));
        conn.reading = false;
    }
    // A forced close (server.close, app .destroy, over-capacity) must drop the peer now,
    // even with a wedged write queue. Plain uv_close does a graceful FIN that the OS holds
    // until the (possibly non-reading) peer drains the send buffer, so it never tears down.
    // Reset instead: RST + discarded buffer + immediate onClose. After a graceful uv_shutdown,
    // fall back to uv_close (mixing shutdown with close_reset is undefined); a non-zero rc
    // (e.g. an unconnected handle) also falls back to uv_close so onClose still fires.
    if (!conn.shutting and uv.uv_tcp_close_reset(opaqueOf(&conn.handle), &onClose) == 0) return;
    uv.uv_close(opaqueOf(&conn.handle), &onClose);
}

fn onClose(handle: *anyopaque) callconv(.c) void {
    const conn: *Conn = @ptrCast(@alignCast(handle));
    _ = conns.remove(conn.id);
    removeConn(conn);

    var scope: napi.HandleScope = undefined;
    _ = napi.napi_open_handle_scope(env, &scope);
    defer _ = napi.napi_close_handle_scope(env, scope);
    dispatch(conn.id, ev_close, undefinedValue());

    if (conn.tls) |st| {
        tlsmod.freeState(st);
        conn.tls = null;
    }
    pool.destroy(conn);
}

// tcpCloseServer() — stop accepting, then close every live connection.
pub fn closeServer(e: napi.Env, info: napi.CallbackInfo) callconv(.c) napi.Value {
    _ = e;
    _ = info;
    if (listening and !closing) {
        closing = true; // stays set until onServerClose fires, blocking a racing re-listen
        listening = false;
        uv.uv_close(opaqueOf(&server), &onServerClose);
        if (eof_timer_active) {
            uv.uv_close(opaqueOf(&eof_timer), &onEofTimerClose);
            eof_timer_active = false;
        }
    }
    var node = conn_list;
    while (node) |conn| {
        const nxt = conn.next; // grab before closeConn unlinks conn
        closeConn(conn);
        node = nxt;
    }
    return undefinedValue();
}

// the server handle block is free to be re-initialized by a later listen() only once
// libuv has finished closing it.
fn onServerClose(handle: *anyopaque) callconv(.c) void {
    _ = handle;
    closing = false;
}

// the eof_timer block is freed for a later listen() once libuv finishes closing it.
fn onEofTimerClose(_: *anyopaque) callconv(.c) void {}

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
        _ = napi.napi_get_and_clear_last_exception(env, &ex); // one bad handler can't kill the loop
    }
}

// --- intrusive list, for closeServer's sweep --------------------------------------

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

// --- small napi helpers ------------------------------------------------------------

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
    return optBoolDefault(e, options, name, false);
}

// reads a bool option, returning `default` when it's absent or not a boolean
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
