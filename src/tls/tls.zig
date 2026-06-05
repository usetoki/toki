//! Native TLS termination on top of the vendored pure-Zig tls.zig (deps/tls).
//!
//! This is a pure transform: it owns the per-connection cipher state and a small
//! ciphertext receive buffer, and exposes handshake / decrypt / encrypt / close as
//! buffer-in/buffer-out calls. It imports neither engine.zig nor loop.zig — the loop
//! drives it and performs the actual libuv reads/writes.
//!
//! We negotiate AEAD suites only (cipher_suites.secure: TLS 1.3 + TLS 1.2 GCM/ChaCha).

const std = @import("std");
const lib = @import("tls");

/// One TLS record's ciphertext upper bound — the per-conn receive buffer holds one.
pub const in_size = lib.input_buffer_len; // 16645
/// Output scratch: big enough for a full TLS 1.3 server flight (ServerHello + the
/// encrypted Certificate/CertVerify/Finished, cert-chain dependent).
pub const out_size = 2 * lib.input_buffer_len;
/// One encrypted application-data record — application writes are chunked to this.
pub const out_record = lib.output_buffer_len;
/// TLS maximum plaintext per record (2^14). We feed at most this much to `encrypt`
/// per call so it emits exactly one record that fits in `out_record`.
pub const max_cleartext = 16384;

// --- server-wide config, built once at listen -------------------------------

var g_enabled = false;
var g_auth: lib.config.CertKeyPair = undefined;
// One CSPRNG seeded from OS entropy at boot, reused for every handshake. Cheap
// userspace ChaCha — no per-handshake syscall.
var g_csprng: std.Random.DefaultCsprng = undefined;
// toki speaks HTTP/1.1; advertise it so clients that ALPN-probe pick the right protocol.
const g_alpn: []const []const u8 = &.{"http/1.1"};

pub fn enabled() bool {
    return g_enabled;
}

/// Build the server TLS config from PEM cert chain + private key. Called once at
/// listen. A `std.Io.Threaded` is used transiently here for PEM parsing + the entropy
/// seed; it works under the engine's single-threaded build (runs inline).
pub fn init(gpa: std.mem.Allocator, cert_pem: []const u8, key_pem: []const u8) !void {
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
    /// drives the handshake; valid until `established`
    handshake: lib.nonblock.Server,
    /// record layer (encrypt/decrypt); valid once `established`
    record: lib.nonblock.Connection = undefined,
    established: bool = false,
    sent_close: bool = false,
    /// ciphertext received from the socket, not yet consumed (partial records)
    in: [in_size]u8 = undefined,
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

// --- handshake / record operations ------------------------------------------

pub const Handshake = struct {
    /// ciphertext to put on the wire (a slice of the caller's `out`)
    send: []const u8,
    done: bool,
    failed: bool,
};

/// Drive the handshake using whatever ciphertext is buffered in `st.in`, writing any
/// reply flight into `out`. On completion the record layer is initialised.
pub fn handshake(st: *State, out: []u8) Handshake {
    const r = st.handshake.run(st.in[0..st.in_len], out) catch
        return .{ .send = &.{}, .done = false, .failed = true };
    consume(st, r.recv_pos);
    if (st.handshake.done()) {
        const cipher = st.handshake.cipher() orelse
            return .{ .send = out[0..r.send_pos], .done = false, .failed = true };
        st.record = lib.nonblock.Connection.init(cipher);
        st.established = true;
    }
    return .{ .send = out[0..r.send_pos], .done = st.established, .failed = false };
}

/// Total length (header + payload) of the next fully-buffered TLS record, or null if
/// the next record hasn't arrived completely yet.
pub fn nextRecordLen(st: *const State) ?usize {
    if (st.in_len < 5) return null;
    const payload = (@as(usize, st.in[3]) << 8) | @as(usize, st.in[4]);
    const total = 5 + payload;
    if (st.in_len < total) return null;
    return total;
}

pub const Read = struct {
    plain_len: usize,
    closed: bool,
    failed: bool,
};

/// Decrypt the next complete record into `plain` (which must be >= the record length,
/// guaranteed by the caller via `nextRecordLen`). The plaintext is written at the start
/// of `plain`; `plain_len` is its length.
pub fn readRecord(st: *State, plain: []u8) Read {
    const d = st.record.decrypt(st.in[0..st.in_len], plain) catch
        return .{ .plain_len = 0, .closed = false, .failed = true };
    consume(st, d.ciphertext_pos);
    return .{ .plain_len = d.cleartext.len, .closed = d.closed, .failed = false };
}

pub const Write = struct {
    /// ciphertext to put on the wire (a slice of the caller's `out`)
    ciphertext: []const u8,
    /// the part of `plaintext` that didn't fit in `out` this round
    rest: []const u8,
    failed: bool,
};

/// Encrypt as much of `plaintext` as fits in `out`; loop on `rest` for the remainder.
pub fn encrypt(st: *State, plaintext: []const u8, out: []u8) Write {
    const e = st.record.encrypt(plaintext, out) catch
        return .{ .ciphertext = &.{}, .rest = &.{}, .failed = true };
    return .{ .ciphertext = e.ciphertext, .rest = e.unused_cleartext, .failed = false };
}

/// Produce a close_notify alert into `out`.
pub fn closeNotify(st: *State, out: []u8) []const u8 {
    return st.record.close(out) catch &.{};
}

// drop `n` consumed ciphertext bytes from the front of the receive buffer
fn consume(st: *State, n: usize) void {
    if (n == 0) return;
    const remaining = st.in_len - n;
    if (remaining != 0) std.mem.copyForwards(u8, st.in[0..remaining], st.in[n..st.in_len]);
    st.in_len = remaining;
}
