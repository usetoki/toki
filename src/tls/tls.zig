//! Native TLS termination over the vendored pure-Zig tls.zig (deps/tls).
//!
//! Pure transform: owns the per-connection cipher state plus a one-record ciphertext
//! buffer, and exposes handshake/decrypt/encrypt/close as buffer-in, buffer-out calls.
//! No import of engine.zig or loop.zig — the loop drives it and does the libuv I/O.
//! TLS 1.3 only (AEAD suites; ECDHE).

const std = @import("std");
const lib = @import("tls");

/// one TLS record's ciphertext; also the size of the per-conn receive buffer
pub const in_size = lib.input_buffer_len; // 16645
/// scratch for a whole handshake flight (several records with a cert chain)
pub const out_size = 2 * lib.input_buffer_len;
/// one encrypted application-data record
pub const out_record = lib.output_buffer_len;
/// max plaintext per TLS record (2^14); at most this much is fed to `encrypt` per call
pub const max_cleartext = 16384;

// --- server config, built once at listen ------------------------------------

var g_enabled = false;
var g_auth: lib.config.CertKeyPair = undefined;
// seeded from the OS once at boot, reused for every handshake (no per-handshake syscall)
var g_csprng: std.Random.DefaultCsprng = undefined;
// ALPN offer order is server preference: with HTTP/2 enabled, h2 wins over http/1.1 for any
// client that supports it; otherwise only http/1.1 is offered so a plain server never upgrades.
const alpn_h2: []const []const u8 = &.{ "h2", "http/1.1" };
const alpn_h1: []const []const u8 = &.{"http/1.1"};
var g_offer_h2 = false;

/// Offer "h2" in the ALPN list (set from the listen options before any handshake).
pub fn setOfferH2(on: bool) void {
    g_offer_h2 = on;
}

// ALPN list, wire format shared with the TS layer: each protocol is a 1-byte length followed by
// its bytes, concatenated. Parse `wire` into `slices` (pointing into `store`, a copy of the wire).
const alpn_store_max = 128;
const alpn_max = 4;
fn parseAlpn(wire: []const u8, store: []u8, slices: [][]const u8) []const []const u8 {
    const n = @min(wire.len, store.len);
    @memcpy(store[0..n], wire[0..n]);
    var i: usize = 0;
    var count: usize = 0;
    while (i < n and count < slices.len) {
        const len = store[i];
        i += 1;
        if (i + len > n) break;
        slices[count] = store[i .. i + len];
        count += 1;
        i += len;
    }
    return slices[0..count];
}

// custom server ALPN list, set per listen on the raw TCP server. Empty falls back to the HTTP
// path's h2/http1.1 logic, so the HTTPS server is unaffected.
var g_alpn_store: [alpn_store_max]u8 = undefined;
var g_alpn_slices: [alpn_max][]const u8 = undefined;
var g_alpn: []const []const u8 = &.{};

/// Set the server's offered ALPN protocols (wire format) for the next handshakes. Empty clears it.
pub fn setServerAlpn(wire: []const u8) void {
    g_alpn = parseAlpn(wire, &g_alpn_store, &g_alpn_slices);
}

// Optional mutual-TLS: when a client-CA bundle is supplied, the server sends a
// CertificateRequest and verifies the client cert against this bundle. Parsed once at
// init and reused for every handshake. null = no client auth (today's behavior).
// Type is the lib's `Options.client_auth` field (?ClientAuth), referenced via @FieldType
// to avoid depending on the lib re-exporting ClientAuth through `config`.
const ClientAuth = @typeInfo(@FieldType(lib.config.Server, "client_auth")).optional.child;
var g_client_auth: ?ClientAuth = null;

pub fn enabled() bool {
    return g_enabled;
}

/// release the server config (cert chain + optional client-CA bundle). Safe to call
/// when never configured. Run at the start of init so a re-listen frees the prior
/// config, and so a config left half-built by a failed init never lingers.
pub fn deinit(gpa: std.mem.Allocator) void {
    if (!g_enabled) return;
    g_auth.deinit(gpa);
    if (g_client_auth) |*c| c.root_ca.deinit(gpa);
    g_client_auth = null;
    g_enabled = false;
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
    // tear down any prior config first: a re-listen replaces it, and clearing g_enabled
    // up front means a failure below can never leave it true over freed/half-built state
    // (a later plain-HTTP listen would otherwise serve handshakes off a dangling g_auth).
    deinit(gpa);

    // a transient blocking Io just for PEM parsing + the rng seed (works single-threaded)
    var threaded = std.Io.Threaded.init(gpa, .{});
    const io = threaded.io();

    g_auth = try lib.config.CertKeyPair.fromSlice(gpa, io, cert_pem, key_pem);
    errdefer g_auth.deinit(gpa);

    if (client_auth) |ca| {
        const bundle = try lib.config.cert.fromSlice(gpa, io, ca.ca_pem);
        g_client_auth = .{
            .root_ca = bundle,
            .auth_type = if (ca.require) .require else .request,
        };
    }
    errdefer if (g_client_auth) |*c| {
        c.root_ca.deinit(gpa);
        g_client_auth = null;
    };

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
        .alpn_protocols = if (g_alpn.len > 0) g_alpn else if (g_offer_h2) alpn_h2 else alpn_h1,
        // real wall-clock time: client_auth verifies the client cert's validity window
        // against this, so .zero (1970) would reject every in-date cert. The caller passes
        // the current time at accept. Harmless without client_auth (the server signs, not verifies).
        .now = .fromNanoseconds(@as(i96, now_sec) * std.time.ns_per_s),
    };
}

// --- per-connection state ---------------------------------------------------

// a connection's handshake driver: an inbound server handshake, or an outbound client one.
// Both expose the same run/done/cipher/alpnProtocol surface; only a server reports a verified
// *client* cert (clientCertVerified), so `authorized` is filled per-role at completion.
pub const Side = union(enum) {
    server: lib.nonblock.Server,
    client: lib.nonblock.Client,
};

pub const State = struct {
    handshake: Side, // drives the handshake, until established
    record: lib.nonblock.Connection = undefined, // encrypt/decrypt, after established
    established: bool = false,
    sent_close: bool = false,
    // true once established if the peer presented a client cert that verified against the
    // configured CA. Meaningful only when client_auth is on; always false otherwise. With
    // .require an unauthorized peer never reaches `established`, so this is true there.
    // On a client conn it mirrors `client_verified`: a completed verified handshake.
    authorized: bool = false,
    // true once established if ALPN negotiated "h2"; the loop then drives the connection
    // through the HTTP/2 engine instead of the HTTP/1.1 pipeline
    alpn_h2: bool = false,
    // client only: a trust bundle we allocated and must free (a custom CA passed to connect).
    // null on a server conn, a client using the cached system roots, or insecure verify.
    ca: ?lib.config.cert.Bundle = null,
    // client only: our own cert chain + key for mutual TLS (the server asked for a client cert).
    // Owned, freed in freeState; the handshake holds a pointer to it, so it lives in the State.
    auth_kp: ?lib.config.CertKeyPair = null,
    // client only: verification was on, so a completed handshake means the server cert + host
    // name checked out. Copied into `authorized` at completion so JS reads it uniformly.
    client_verified: bool = false,
    // client only: stable storage for the SNI / verify host — the vendored client keeps a slice
    // of it through the whole handshake (ClientHello SNI and the later cert host-name check), so
    // it must outlive the JS string it came from. Lives here, freed with the State.
    host_buf: [256]u8 = undefined,
    host_len: usize = 0,
    // client only: stable storage for the offered ALPN list (the client keeps a slice of it for
    // the ClientHello). The negotiated result lives in the handshake object, not here.
    alpn_store: [alpn_store_max]u8 = undefined,
    alpn_slices: [alpn_max][]const u8 = undefined,
    in: [in_size]u8 = undefined, // ciphertext from the socket, not yet consumed
    in_len: usize = 0,
};

// both handshake variants share the run/done/cipher/alpnProtocol surface; dispatch on the tag.
const RunResult = struct { recv_pos: usize, send_pos: usize };
fn hsRun(st: *State, recv: []const u8, send: []u8) !RunResult {
    switch (st.handshake) {
        inline else => |*h| {
            const r = try h.run(recv, send);
            return .{ .recv_pos = r.recv_pos, .send_pos = r.send_pos };
        },
    }
}
fn hsDone(st: *State) bool {
    switch (st.handshake) {
        inline else => |*h| return h.done(),
    }
}
fn hsCipher(st: *State) ?lib.Cipher {
    switch (st.handshake) {
        inline else => |*h| return h.cipher(),
    }
}
fn hsAlpn(st: *State) ?[]const u8 {
    switch (st.handshake) {
        inline else => |*h| return h.alpnProtocol(),
    }
}
// server reports the verified *client* cert; a client mirrors its own verification result.
fn hsAuthorized(st: *State) bool {
    return switch (st.handshake) {
        .server => |*s| s.clientCertVerified(),
        .client => st.client_verified,
    };
}

/// Whether this connection negotiated HTTP/2 over ALPN. Meaningful only once established.
pub fn negotiatedH2(st: *const State) bool {
    return st.alpn_h2;
}

/// RFC 8446 §7.5 keying-material exporter (RFC 9266 `tls-exporter` channel binding). Fills `out`
/// with material bound to this session, derived from `label` + `context`. Returns false before the
/// handshake is established. Both peers derive identical bytes — the channel-binding guarantee.
pub fn exportKeyingMaterial(st: *State, label: []const u8, context: []const u8, out: []u8) bool {
    if (!st.established) return false;
    switch (st.handshake) {
        inline else => |*h| h.exportKeyingMaterial(label, context, out),
    }
    return true;
}

/// The peer's leaf certificate in DER, or null. On a client conn it's the server's certificate;
/// on a server conn it's the client's (mutual TLS). The slice lives as long as the State.
pub fn peerCertificate(st: *State) ?[]const u8 {
    if (!st.established) return null;
    return switch (st.handshake) {
        inline else => |*h| h.peerCertificate(),
    };
}

/// The ALPN protocol negotiated for this connection, or null if none was. Meaningful once
/// established; the returned slice lives as long as the State.
pub fn alpnProtocol(st: *State) ?[]const u8 {
    if (!st.established) return null;
    return hsAlpn(st);
}

var pool: std.heap.MemoryPool(State) = .empty;

/// `now_sec` is the current wall-clock time in Unix seconds — used to verify a client
/// cert's validity window when client_auth is on (ignored otherwise).
pub fn newState(gpa: std.mem.Allocator, now_sec: i64) ?*State {
    const st = pool.create(gpa) catch return null;
    st.* = .{ .handshake = .{ .server = lib.nonblock.Server.init(serverOptions(now_sec)) } };
    return st;
}

pub fn freeState(st: *State) void {
    // a client conn may own a parsed CA bundle (custom `ca`) and a client cert/key pair (mTLS);
    // the system roots are cached and never freed here. Allocated with the c_allocator.
    if (st.ca) |*b| b.deinit(std.heap.c_allocator);
    if (st.auth_kp) |*kp| kp.deinit(std.heap.c_allocator);
    pool.destroy(st);
}

// --- client config, built per outbound connect ------------------------------

// the client CSPRNG is seeded once, lazily — a process that only dials out never calls the
// server-side init() that seeds g_csprng, so the client keeps its own.
var g_client_csprng: std.Random.DefaultCsprng = undefined;
var g_client_seeded = false;
fn clientRng() ?std.Random {
    if (!g_client_seeded) {
        var threaded = std.Io.Threaded.init(std.heap.c_allocator, .{});
        const io = threaded.io();
        var seed: [std.Random.DefaultCsprng.secret_seed_length]u8 = undefined;
        io.randomSecure(&seed) catch return null;
        g_client_csprng = std.Random.DefaultCsprng.init(seed);
        g_client_seeded = true;
    }
    return g_client_csprng.random();
}

// OS trust store, loaded once and shared by every connect that doesn't pass its own CA. The
// rescan reads disk, so do it a single time; a failure caches null and those connects fail closed.
var g_system_roots: ?lib.config.cert.Bundle = null;
var g_system_tried = false;
fn systemRoots() ?lib.config.cert.Bundle {
    if (!g_system_tried) {
        g_system_tried = true;
        var threaded = std.Io.Threaded.init(std.heap.c_allocator, .{});
        const io = threaded.io();
        g_system_roots = lib.config.cert.fromSystem(std.heap.c_allocator, io) catch null;
    }
    return g_system_roots;
}

fn parseBundle(gpa: std.mem.Allocator, pem: []const u8) ?lib.config.cert.Bundle {
    var threaded = std.Io.Threaded.init(gpa, .{});
    const io = threaded.io();
    return lib.config.cert.fromSlice(gpa, io, pem) catch null;
}

fn parseCertKey(gpa: std.mem.Allocator, cert_pem: []const u8, key_pem: []const u8) ?lib.config.CertKeyPair {
    var threaded = std.Io.Threaded.init(gpa, .{});
    const io = threaded.io();
    return lib.config.CertKeyPair.fromSlice(gpa, io, cert_pem, key_pem) catch null;
}

/// What an outbound connect needs to drive a client handshake: the host (SNI + the name the
/// server cert is verified against), an optional custom CA bundle (PEM; else the system roots),
/// whether to skip verification, an optional client cert/key for mutual TLS, and ALPN.
pub const ClientConfig = struct {
    host: []const u8,
    ca_pem: ?[]const u8,
    insecure: bool,
    cert_pem: ?[]const u8 = null,
    key_pem: ?[]const u8 = null,
    alpn_wire: []const u8 = &.{}, // ALPN list in the shared wire format (1-byte length + bytes)
};

/// Build the per-connection client TLS state. `now_sec` dates the server cert's validity check.
/// Returns null on allocation / RNG / trust-store failure (the caller fails the connect closed).
pub fn newClientState(gpa: std.mem.Allocator, now_sec: i64, cfg: ClientConfig) ?*State {
    const st = pool.create(gpa) catch return null;
    // NB: the return type is ?*State, so `return null` is a normal return — an errdefer would
    // never fire on it. Every failure path below frees st (and any bundle) explicitly.

    var owned_ca: ?lib.config.cert.Bundle = null;
    const root_ca: lib.config.cert.Bundle = blk: {
        if (cfg.insecure) break :blk .empty; // unused when verification is off
        if (cfg.ca_pem) |pem| {
            const b = parseBundle(gpa, pem) orelse {
                pool.destroy(st);
                return null;
            };
            owned_ca = b;
            break :blk b;
        }
        break :blk systemRoots() orelse {
            pool.destroy(st);
            return null;
        };
    };
    const rng = clientRng() orelse {
        if (owned_ca) |*b| b.deinit(gpa);
        pool.destroy(st);
        return null;
    };
    // defaults for everything; host + handshake are filled below so the client can hold a slice
    // of st.host_buf (stable for the State's life) rather than the caller's transient string.
    st.* = .{ .handshake = undefined, .ca = owned_ca, .client_verified = !cfg.insecure };
    const n = @min(cfg.host.len, st.host_buf.len);
    @memcpy(st.host_buf[0..n], cfg.host[0..n]);
    st.host_len = n;

    // optional client cert/key for mutual TLS. The handshake keeps a pointer, so it lives in the
    // State (stable) and is freed in freeState. A cert without a key (or a parse failure) fails
    // the connect closed rather than silently connecting without the credential the peer wants.
    var auth_ptr: ?*lib.config.CertKeyPair = null;
    if (cfg.cert_pem) |cp| {
        const kp = cfg.key_pem orelse {
            if (owned_ca) |*b| b.deinit(gpa);
            pool.destroy(st);
            return null;
        };
        st.auth_kp = parseCertKey(gpa, cp, kp) orelse {
            if (owned_ca) |*b| b.deinit(gpa);
            pool.destroy(st);
            return null;
        };
        auth_ptr = &st.auth_kp.?;
    }

    const client_alpn = parseAlpn(cfg.alpn_wire, &st.alpn_store, &st.alpn_slices);
    st.handshake = .{ .client = lib.nonblock.Client.init(.{
        .rng = rng,
        .now = .fromNanoseconds(@as(i96, now_sec) * std.time.ns_per_s),
        .host = st.host_buf[0..n],
        .root_ca = root_ca,
        .insecure_skip_verify = cfg.insecure,
        .auth = auth_ptr,
        .alpn_protocols = client_alpn,
    }) };
    return st;
}

// --- handshake / record ops -------------------------------------------------

pub const Handshake = struct {
    send: []const u8, // ciphertext to put on the wire (slice of the caller's `out`)
    failed: bool,
};

/// feed buffered ciphertext to the handshake, write any reply into `out`. sets up the
/// record layer once the handshake completes (check st.established after).
pub fn handshake(st: *State, out: []u8) Handshake {
    const r = hsRun(st, st.in[0..st.in_len], out) catch
        return .{ .send = &.{}, .failed = true };
    consume(st, r.recv_pos);
    if (hsDone(st)) {
        const c = hsCipher(st) orelse return .{ .send = out[0..r.send_pos], .failed = true };
        st.record = lib.nonblock.Connection.init(c);
        st.authorized = hsAuthorized(st);
        st.alpn_h2 = if (hsAlpn(st)) |p| std.mem.eql(u8, p, "h2") else false;
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
    const r = hsRun(st, cipher, out) catch
        return .{ .send = &.{}, .consumed = 0, .failed = true };
    if (hsDone(st)) {
        const c = hsCipher(st) orelse return .{ .send = out[0..r.send_pos], .consumed = r.recv_pos, .failed = true };
        st.record = lib.nonblock.Connection.init(c);
        st.authorized = hsAuthorized(st);
        st.alpn_h2 = if (hsAlpn(st)) |p| std.mem.eql(u8, p, "h2") else false;
        st.established = true;
    }
    return .{ .send = out[0..r.send_pos], .consumed = r.recv_pos, .failed = false };
}

/// Largest legal TLS record on the wire. A record header claiming more than this is a
/// protocol violation that could never complete — used to drop a TLS-level slowloris.
pub const max_record = in_size;

/// Stash a partial trailing record into st.in to prepend to the next read. Returns false
/// when bytes > in_size (no legal record is that big — the caller closes the connection).
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
/// it consume a trailing record whose plaintext overflows `plain` (one record's worth). The
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

/// Unlike readRecord, this never touches st.in — the caller owns the ciphertext buffer and
/// the partial carry. Decrypts every complete record in `cipher` into `plain` in one pass;
/// `plain` must be >= cipher.len (AEAD shrinks each record, so every one fits). A partial
/// trailing record is left as cipher[consumed..] for the caller to carry. `closed` flags a
/// close_notify in this batch — records before it are still decrypted.
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
