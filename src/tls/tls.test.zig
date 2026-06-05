const std = @import("std");
const tls = @import("tls");

// Proves the vendored pure-Zig TLS (deps/tls) is correct on our Zig 0.16: a full
// non-blocking AEAD handshake (client <-> server, entirely in memory, no sockets),
// then an encrypted record round-trip and a clean close_notify. This is the same
// buffer-in/buffer-out shape the engine will drive over libuv.
test "nonblock AEAD handshake + record roundtrip + close" {
    // Deterministic seed: this is a functional handshake test, not an entropy test.
    var prng = std.Random.DefaultCsprng.init(@splat(0x9e));
    const rng = prng.random();

    var sc: [tls.max_ciphertext_record_len]u8 = undefined; // server -> client wire
    var cs: [tls.max_ciphertext_record_len]u8 = undefined; // client -> server wire

    var cli = tls.nonblock.Client.init(.{
        .rng = rng,
        .root_ca = .empty,
        .host = &.{},
        .insecure_skip_verify = true, // smoke uses an anonymous server (auth = null)
        .now = .zero,
    });
    var srv = tls.nonblock.Server.init(.{
        .rng = rng,
        .auth = null,
        .now = .zero,
    });

    // TLS 1.3 is 1-RTT: clientHello -> serverFlight -> clientFinished.
    var cr = try cli.run(sc[0..0], &cs); // client hello
    try std.testing.expect(cr.send_pos > 0);

    var sr = try srv.run(cs[0..cr.send_pos], &sc); // server flight
    try std.testing.expect(sr.send_pos > 0);

    cr = try cli.run(sc[0..sr.send_pos], &cs); // client finished
    try std.testing.expect(cli.done());
    try std.testing.expect(cli.cipher() != null);

    sr = try srv.run(cs[0..cr.send_pos], &sc); // server consumes finished
    try std.testing.expect(srv.done());
    try std.testing.expect(srv.cipher() != null);

    // Encrypted application data, both directions.
    var cc = tls.nonblock.Connection.init(cli.cipher().?);
    var ss = tls.nonblock.Connection.init(srv.cipher().?);

    const msg = "hello over tls on zig 0.16";
    {
        const e = try cc.encrypt(msg, &cs);
        try std.testing.expect(e.ciphertext.len > msg.len);
        const d = try ss.decrypt(e.ciphertext, &sc);
        try std.testing.expectEqualSlices(u8, msg, d.cleartext);
    }
    {
        const e = try ss.encrypt("pong", &sc);
        const d = try cc.decrypt(e.ciphertext, &cs);
        try std.testing.expectEqualSlices(u8, "pong", d.cleartext);
    }

    // Clean close: server sends close_notify, client observes it.
    const close = try ss.close(&sc);
    const d = try cc.decrypt(close, &cs);
    try std.testing.expect(d.closed);
}
