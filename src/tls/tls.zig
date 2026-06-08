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

// Optional mutual-TLS: when a client-CA bundle is supplied, the server sends a
// CertificateRequest and verifies the client cert against this bundle. Parsed once at
// init and reused for every handshake. null = no client auth (today's behavior).
// Type is the lib's `Options.client_auth` field (?ClientAuth) — referenced via @FieldType
// so we don't depend on the lib re-exporting ClientAuth through `config`.
const ClientAuth = @typeInfo(@FieldType(lib.config.Server, "client_auth")).optional.child;
var g_client_auth: ?ClientAuth = null;

pub fn enabled() bool {
    return g_enabled;
}

/// Optional client-certificate authentication, supplied to `init`.
/// `ca_pem` is the trusted CA bundle the client cert is verified against; `require`
/// makes a missing/invalid client cert fail the handshake (.require vs .request).
pub const ClientAuthConfig = struct {
    ca_pem: []const u8,
    require: bool,
};

/// parse the PEM cert chain + key and build the server config. once, at listen.
/// `client_auth` enables mutual TLS when present; null keeps the plain server behavior.
pub fn init(
    gpa: std.mem.Allocator,
    cert_pem: []const u8,
    key_pem: []const u8,
    client_auth: ?ClientAuthConfig,
) !void {
    // a transient blocking Io just for PEM parsing + the rng seed (works single-threaded)
    var threaded = std.Io.Threaded.init(gpa, .{});
    const io = threaded.io();

    g_auth = try lib.config.CertKeyPair.fromSlice(gpa, io, cert_pem, key_pem);
    errdefer g_auth.deinit(gpa);

    // free a CA bundle from a prior listen before replacing it (re-listen in one process)
    if (g_client_auth) |*prev| prev.root_ca.deinit(gpa);
    g_client_auth = null;
    if (client_auth) |ca| {
        const bundle = try lib.config.cert.fromSlice(gpa, io, ca.ca_pem);
        g_client_auth = .{
            .root_ca = bundle,
            .auth_type = if (ca.require) .require else .request,
        };
    }

    var seed: [std.Random.DefaultCsprng.secret_seed_length]u8 = undefined;
    try io.randomSecure(&seed);
    g_csprng = std.Random.DefaultCsprng.init(seed);

    g_enabled = true;
}

fn serverOptions(now_sec: i64) lib.config.Server {
    return .{
        .rng = g_csprng.random(),
        .auth = &g_auth,
        .client_auth = g_client_auth,
        .cipher_suites = lib.config.cipher_suites.secure,
        .alpn_protocols = g_alpn,
        // real wall-clock time: client_auth verifies the client cert's validity window
        // against this, so .zero (1970) would reject every in-date cert. The caller passes
        // the current time at accept. Harmless without client_auth (we sign, not verify).
        .now = .fromNanoseconds(@as(i96, now_sec) * std.time.ns_per_s),
    };
}

// --- per-connection state ---------------------------------------------------

pub const State = struct {
    handshake: lib.nonblock.Server, // drives the handshake, until established
    record: lib.nonblock.Connection = undefined, // encrypt/decrypt, after established
    established: bool = false,
    sent_close: bool = false,
    // true once established if the peer presented a client cert that verified against the
    // configured CA. Meaningful only when client_auth is on; always false otherwise. With
    // .require an unauthorized peer never reaches `established`, so this is true there.
    authorized: bool = false,
    in: [in_size]u8 = undefined, // ciphertext from the socket, not yet consumed
    in_len: usize = 0,
};

var pool: std.heap.MemoryPool(State) = .empty;

/// `now_sec` is the current wall-clock time in Unix seconds — used to verify a client
/// cert's validity window when client_auth is on (ignored otherwise).
pub fn newState(gpa: std.mem.Allocator, now_sec: i64) ?*State {
    const st = pool.create(gpa) catch return null;
    st.* = .{ .handshake = lib.nonblock.Server.init(serverOptions(now_sec)) };
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
        st.authorized = st.handshake.clientCertVerified();
        st.established = true;
    }
    return .{ .send = out[0..r.send_pos], .failed = false };
}

pub const HandshakeBuf = struct {
    send: []const u8, // ciphertext to put on the wire (slice of `out`)
    consumed: usize, // handshake ciphertext consumed from `cipher`
    failed: bool,
};

/// Like `handshake`, but reads from the caller's `cipher` buffer instead of st.in and reports
/// how much it consumed — the caller owns the buffer and the carry. Sets up the record layer
/// and st.established when the handshake completes; `cipher[consumed..]` is then application
/// data the caller can hand to decryptBatch.
pub fn handshakeBuf(st: *State, cipher: []const u8, out: []u8) HandshakeBuf {
    const r = st.handshake.run(cipher, out) catch
        return .{ .send = &.{}, .consumed = 0, .failed = true };
    if (st.handshake.done()) {
        const c = st.handshake.cipher() orelse return .{ .send = out[0..r.send_pos], .consumed = r.recv_pos, .failed = true };
        st.record = lib.nonblock.Connection.init(c);
        st.authorized = st.handshake.clientCertVerified();
        st.established = true;
    }
    return .{ .send = out[0..r.send_pos], .consumed = r.recv_pos, .failed = false };
}

/// Largest legal TLS record on the wire. A record header claiming more than this is a
/// protocol violation that could never complete — used to drop a TLS-level slowloris.
pub const max_record = in_size;

/// Carry `bytes` (a partial trailing record, ≤ one record) into st.in for the next read.
/// Returns false if it somehow exceeds the carry buffer — a malformed oversized record the
/// caller should treat as a protocol violation and close.
pub fn carry(st: *State, bytes: []const u8) bool {
    if (bytes.len > st.in.len) return false;
    if (bytes.len > 0) std.mem.copyForwards(u8, st.in[0..bytes.len], bytes);
    st.in_len = bytes.len;
    return true;
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

/// decrypt the next record into `plain` (the caller guarantees it's big enough).
/// Only the next single record is handed to decrypt: feeding it the whole buffer would let
/// it consume a trailing record whose plaintext overflows `plain` (one record's worth) — the
/// excess cleartext is dropped by decrypt's reset while its ciphertext stays consumed, so a
/// buffer holding >1 record (combined plaintext > max_cleartext) silently loses bytes. One
/// record in, ≤ max_cleartext out, always fits.
pub fn readRecord(st: *State, plain: []u8) Read {
    const record_len = 5 + ((@as(usize, st.in[3]) << 8) | @as(usize, st.in[4]));
    const d = st.record.decrypt(st.in[0..record_len], plain) catch
        return .{ .plain_len = 0, .closed = false, .failed = true };
    consume(st, d.ciphertext_pos);
    return .{ .plain_len = d.cleartext.len, .closed = d.closed, .failed = false };
}

pub const Batch = struct {
    plain_len: usize, // decrypted bytes written to `plain`
    consumed: usize, // ciphertext bytes of complete records consumed from `cipher`
    closed: bool, // a close_notify alert was seen mid-batch
    failed: bool,
};

/// Decrypt every complete record in `cipher` into `plain` in one pass. `plain` must be at
/// least `cipher.len` (plaintext is always shorter than its ciphertext, so that guarantees
/// every complete record fits and nothing is dropped). A partial trailing record stays in
/// `cipher` as the unconsumed tail — the caller carries those `cipher.len - consumed` bytes
/// to the next read. `closed` is set when the peer's close_notify rode in this batch; the
/// records before it are still decrypted into `plain`. Does NOT touch st.in — the caller owns
/// the ciphertext buffer and the partial carry.
pub fn decryptBatch(st: *State, cipher: []const u8, plain: []u8) Batch {
    const d = st.record.decrypt(cipher, plain) catch
        return .{ .plain_len = 0, .consumed = 0, .closed = false, .failed = true };
    return .{
        .plain_len = d.cleartext.len,
        .consumed = cipher.len - d.unused_ciphertext.len,
        .closed = d.closed,
        .failed = false,
    };
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
