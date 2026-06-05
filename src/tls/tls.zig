//! Native TLS termination over the vendored pure-Zig tls.zig (deps/tls).
//!
//! Pure transform: owns the per-connection cipher state plus a one-record ciphertext
//! buffer, and exposes handshake/decrypt/encrypt/close as buffer-in, buffer-out calls.
//! No import of engine.zig or loop.zig — the loop drives it and does the libuv I/O.
//! AEAD suites only (TLS 1.3 + TLS 1.2 GCM/ChaCha).

const std = @import("std");
const lib = @import("tls");

/// one TLS record's ciphertext; also the size of the per-conn receive buffer
pub const in_size = lib.input_buffer_len; // 16645
/// scratch for a whole handshake flight (several records with a cert chain)
pub const out_size = 2 * lib.input_buffer_len;
/// one encrypted application-data record
pub const out_record = lib.output_buffer_len;
/// max plaintext per TLS record (2^14); we feed at most this to `encrypt` per call
pub const max_cleartext = 16384;

// --- server config, built once at listen ------------------------------------

var g_enabled = false;
var g_auth: lib.config.CertKeyPair = undefined;
// seeded from the OS once at boot, reused for every handshake (no per-handshake syscall)
var g_csprng: std.Random.DefaultCsprng = undefined;
const g_alpn: []const []const u8 = &.{"http/1.1"};

pub fn enabled() bool {
    return g_enabled;
}

/// parse the PEM cert chain + key and build the server config. once, at listen.
pub fn init(gpa: std.mem.Allocator, cert_pem: []const u8, key_pem: []const u8) !void {
    // a transient blocking Io just for PEM parsing + the rng seed (works single-threaded)
    var threaded = std.Io.Threaded.init(gpa, .{});
    const io = threaded.io();

    g_auth = try lib.config.CertKeyPair.fromSlice(gpa, io, cert_pem, key_pem);
    errdefer g_auth.deinit(gpa);

    var seed: [std.Random.DefaultCsprng.secret_seed_length]u8 = undefined;
    try io.randomSecure(&seed);
    g_csprng = std.Random.DefaultCsprng.init(seed);

    g_enabled = true;
}

fn serverOptions() lib.config.Server {
    return .{
        .rng = g_csprng.random(),
        .auth = &g_auth,
        .cipher_suites = lib.config.cipher_suites.secure,
        .alpn_protocols = g_alpn,
        .now = .zero,
    };
}

// --- per-connection state ---------------------------------------------------

pub const State = struct {
    handshake: lib.nonblock.Server, // drives the handshake, until established
    record: lib.nonblock.Connection = undefined, // encrypt/decrypt, after established
    established: bool = false,
    sent_close: bool = false,
    in: [in_size]u8 = undefined, // ciphertext from the socket, not yet consumed
    in_len: usize = 0,
};

var pool: std.heap.MemoryPool(State) = .empty;

pub fn newState(gpa: std.mem.Allocator) ?*State {
    const st = pool.create(gpa) catch return null;
    st.* = .{ .handshake = lib.nonblock.Server.init(serverOptions()) };
    return st;
}

pub fn freeState(st: *State) void {
    pool.destroy(st);
}

// --- handshake / record ops -------------------------------------------------

pub const Handshake = struct {
    send: []const u8, // ciphertext to put on the wire (slice of the caller's `out`)
    failed: bool,
};

/// feed buffered ciphertext to the handshake, write any reply into `out`. sets up the
/// record layer once the handshake completes (check st.established after).
pub fn handshake(st: *State, out: []u8) Handshake {
    const r = st.handshake.run(st.in[0..st.in_len], out) catch
        return .{ .send = &.{}, .failed = true };
    consume(st, r.recv_pos);
    if (st.handshake.done()) {
        const c = st.handshake.cipher() orelse return .{ .send = out[0..r.send_pos], .failed = true };
        st.record = lib.nonblock.Connection.init(c);
        st.established = true;
    }
    return .{ .send = out[0..r.send_pos], .failed = false };
}

/// true once the next whole TLS record (header + payload) is buffered in st.in
pub fn recordReady(st: *const State) bool {
    if (st.in_len < 5) return false;
    const payload = (@as(usize, st.in[3]) << 8) | @as(usize, st.in[4]);
    return st.in_len >= 5 + payload;
}

pub const Read = struct {
    plain_len: usize,
    closed: bool,
    failed: bool,
};

/// decrypt the next record into `plain` (the caller guarantees it's big enough)
pub fn readRecord(st: *State, plain: []u8) Read {
    const d = st.record.decrypt(st.in[0..st.in_len], plain) catch
        return .{ .plain_len = 0, .closed = false, .failed = true };
    consume(st, d.ciphertext_pos);
    return .{ .plain_len = d.cleartext.len, .closed = d.closed, .failed = false };
}

pub const Write = struct {
    ciphertext: []const u8, // slice of the caller's `out`
    rest: []const u8, // plaintext that didn't fit this round
    failed: bool,
};

/// encrypt as much of `plaintext` as fits in `out`; loop on `rest` for the remainder
pub fn encrypt(st: *State, plaintext: []const u8, out: []u8) Write {
    const e = st.record.encrypt(plaintext, out) catch
        return .{ .ciphertext = &.{}, .rest = &.{}, .failed = true };
    return .{ .ciphertext = e.ciphertext, .rest = e.unused_cleartext, .failed = false };
}

/// write a close_notify alert into `out`
pub fn closeNotify(st: *State, out: []u8) []const u8 {
    return st.record.close(out) catch &.{};
}

// drop the first `n` consumed ciphertext bytes from the receive buffer
fn consume(st: *State, n: usize) void {
    if (n == 0) return;
    const remaining = st.in_len - n;
    if (remaining != 0) std.mem.copyForwards(u8, st.in[0..remaining], st.in[n..st.in_len]);
    st.in_len = remaining;
}
