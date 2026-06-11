const std = @import("std");
const huffman = @import("huffman.zig");

fn expectEncode(plain: []const u8, expected: []const u8) !void {
    var buf: [64]u8 = undefined;
    try std.testing.expectEqual(expected.len, huffman.encodedLen(plain));
    const n = huffman.encode(&buf, plain);
    try std.testing.expectEqualSlices(u8, expected, buf[0..n]);

    var back: [64]u8 = undefined;
    const m = try huffman.decode(&back, expected);
    try std.testing.expectEqualSlices(u8, plain, back[0..m]);
}

// RFC 7541 Appendix C.4 worked examples.
test "encode/decode www.example.com (C.4.1)" {
    try expectEncode("www.example.com", &.{ 0xf1, 0xe3, 0xc2, 0xe5, 0xf2, 0x3a, 0x6b, 0xa0, 0xab, 0x90, 0xf4, 0xff });
}

test "encode/decode no-cache (C.4.2)" {
    try expectEncode("no-cache", &.{ 0xa8, 0xeb, 0x10, 0x64, 0x9c, 0xbf });
}

test "encode/decode custom-key and custom-value (C.4.3)" {
    try expectEncode("custom-key", &.{ 0x25, 0xa8, 0x49, 0xe9, 0x5b, 0xa9, 0x7d, 0x7f });
    try expectEncode("custom-value", &.{ 0x25, 0xa8, 0x49, 0xe9, 0x5b, 0xb8, 0xe8, 0xb4, 0xbf });
}

test "round-trips every single byte value" {
    var src: [1]u8 = undefined;
    var enc: [8]u8 = undefined;
    var dec: [8]u8 = undefined;
    var c: usize = 0;
    while (c < 256) : (c += 1) {
        src[0] = @intCast(c);
        const n = huffman.encode(&enc, &src);
        const m = try huffman.decode(&dec, enc[0..n]);
        try std.testing.expectEqual(@as(usize, 1), m);
        try std.testing.expectEqual(src[0], dec[0]);
    }
}

test "round-trips the full byte range in one string" {
    var src: [256]u8 = undefined;
    for (&src, 0..) |*b, i| b.* = @intCast(i);
    var enc: [1024]u8 = undefined;
    var dec: [256]u8 = undefined;
    const n = huffman.encode(&enc, &src);
    const m = try huffman.decode(&dec, enc[0..n]);
    try std.testing.expectEqualSlices(u8, &src, dec[0..m]);
}

test "rejects padding longer than seven bits" {
    var dec: [8]u8 = undefined;
    // 0xff is eight set bits with no symbol terminating on the all-ones path
    try std.testing.expectError(error.BadHuffman, huffman.decode(&dec, &.{0xff}));
}

test "rejects an embedded EOS run" {
    var dec: [8]u8 = undefined;
    // walking past the 30-bit EOS spine has no transition
    try std.testing.expectError(error.BadHuffman, huffman.decode(&dec, &.{ 0xff, 0xff, 0xff, 0xff }));
}

test "rejects output overflow" {
    var enc: [32]u8 = undefined;
    const n = huffman.encode(&enc, "www.example.com");
    var tiny: [4]u8 = undefined;
    try std.testing.expectError(error.Overflow, huffman.decode(&tiny, enc[0..n]));
}

test "empty input encodes and decodes to nothing" {
    var enc: [4]u8 = undefined;
    try std.testing.expectEqual(@as(usize, 0), huffman.encodedLen(""));
    try std.testing.expectEqual(@as(usize, 0), huffman.encode(&enc, ""));
    var dec: [4]u8 = undefined;
    try std.testing.expectEqual(@as(usize, 0), try huffman.decode(&dec, ""));
}
