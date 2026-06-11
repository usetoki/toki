const std = @import("std");
const hpack = @import("hpack.zig");

const Collector = struct {
    names: [64][128]u8 = undefined,
    name_len: [64]usize = undefined,
    values: [64][256]u8 = undefined,
    value_len: [64]usize = undefined,
    sensitive: [64]bool = undefined,
    n: usize = 0,

    pub fn field(self: *Collector, name: []const u8, value: []const u8, sensitive: bool) void {
        const i = self.n;
        @memcpy(self.names[i][0..name.len], name);
        self.name_len[i] = name.len;
        @memcpy(self.values[i][0..value.len], value);
        self.value_len[i] = value.len;
        self.sensitive[i] = sensitive;
        self.n += 1;
    }

    fn expect(self: *const Collector, i: usize, name: []const u8, value: []const u8) !void {
        try std.testing.expectEqualStrings(name, self.names[i][0..self.name_len[i]]);
        try std.testing.expectEqualStrings(value, self.values[i][0..self.value_len[i]]);
    }
};

fn fromHex(comptime hex: []const u8) [hex.len / 2]u8 {
    var out: [hex.len / 2]u8 = undefined;
    var i: usize = 0;
    while (i < out.len) : (i += 1) {
        out[i] = (nib(hex[i * 2]) << 4) | nib(hex[i * 2 + 1]);
    }
    return out;
}

fn nib(c: u8) u8 {
    return switch (c) {
        '0'...'9' => c - '0',
        'a'...'f' => c - 'a' + 10,
        else => unreachable,
    };
}

// RFC 7541 Appendix C.3: three requests over one connection, exercising the dynamic table.
test "decodes the C.3 request sequence with a shared dynamic table" {
    var dec = hpack.Decoder.init(std.testing.allocator, 4096, 1 << 16);
    defer dec.deinit();
    var scratch: [4096]u8 = undefined;

    const r1 = fromHex("828684410f7777772e6578616d706c652e636f6d");
    var c1 = Collector{};
    try dec.decode(&r1, &scratch, &c1);
    try std.testing.expectEqual(@as(usize, 4), c1.n);
    try c1.expect(0, ":method", "GET");
    try c1.expect(1, ":scheme", "http");
    try c1.expect(2, ":path", "/");
    try c1.expect(3, ":authority", "www.example.com");

    const r2 = fromHex("828684be58086e6f2d6361636865");
    var c2 = Collector{};
    try dec.decode(&r2, &scratch, &c2);
    try std.testing.expectEqual(@as(usize, 5), c2.n);
    try c2.expect(3, ":authority", "www.example.com"); // resolved from the dynamic table
    try c2.expect(4, "cache-control", "no-cache");

    const r3 = fromHex("828785bf400a637573746f6d2d6b65790c637573746f6d2d76616c7565");
    var c3 = Collector{};
    try dec.decode(&r3, &scratch, &c3);
    try std.testing.expectEqual(@as(usize, 5), c3.n);
    try c3.expect(1, ":scheme", "https");
    try c3.expect(2, ":path", "/index.html");
    try c3.expect(3, ":authority", "www.example.com");
    try c3.expect(4, "custom-key", "custom-value");
}

// RFC 7541 Appendix C.2: the four field representations.
test "decodes a never-indexed field and marks it sensitive (C.2.3)" {
    var dec = hpack.Decoder.init(std.testing.allocator, 4096, 1 << 16);
    defer dec.deinit();
    var scratch: [256]u8 = undefined;
    // password: secret, never indexed
    const bytes = fromHex("100870617373776f726406736563726574");
    var c = Collector{};
    try dec.decode(&bytes, &scratch, &c);
    try std.testing.expectEqual(@as(usize, 1), c.n);
    try c.expect(0, "password", "secret");
    try std.testing.expect(c.sensitive[0]);
}

test "rejects index zero in an indexed field" {
    var dec = hpack.Decoder.init(std.testing.allocator, 4096, 1 << 16);
    defer dec.deinit();
    var scratch: [16]u8 = undefined;
    var c = Collector{};
    try std.testing.expectError(error.CompressionError, dec.decode(&[_]u8{0x80}, &scratch, &c));
}

test "rejects a dynamic table size update above the advertised maximum" {
    var dec = hpack.Decoder.init(std.testing.allocator, 4096, 1 << 16);
    defer dec.deinit();
    var scratch: [16]u8 = undefined;
    var c = Collector{};
    // 001 11111 then continuation encoding a large size
    const block = fromHex("3fe1ff03"); // 31 + 0xe1.. = well above 4096
    try std.testing.expectError(error.CompressionError, dec.decode(&block, &scratch, &c));
}

test "enforces the header list size limit" {
    var dec = hpack.Decoder.init(std.testing.allocator, 4096, 80);
    defer dec.deinit();
    var scratch: [256]u8 = undefined;
    var c = Collector{};
    // two indexed fields, each name+value+32 — :method GET (3+7+32=42) twice = 84 > 80
    try std.testing.expectError(error.HeaderListTooLarge, dec.decode(&[_]u8{ 0x82, 0x82 }, &scratch, &c));
}

test "encodeStatus uses a static index for common codes" {
    var dest: [8]u8 = undefined;
    try std.testing.expectEqual(@as(usize, 1), hpack.encodeStatus(&dest, 200));
    try std.testing.expectEqual(@as(u8, 0x88), dest[0]); // indexed, static index 8
    try std.testing.expectEqual(@as(usize, 1), hpack.encodeStatus(&dest, 404));
    try std.testing.expectEqual(@as(u8, 0x8d), dest[0]); // indexed, static index 13
}

test "encoded response headers round-trip through the decoder" {
    var dest: [256]u8 = undefined;
    var lower: [64]u8 = undefined;
    var p: usize = 0;
    p += hpack.encodeStatus(dest[p..], 503);
    p += hpack.encodeHeader(dest[p..], "Content-Type", "text/plain", &lower);
    p += hpack.encodeHeader(dest[p..], "X-Custom", "hello world", &lower);

    var dec = hpack.Decoder.init(std.testing.allocator, 4096, 1 << 16);
    defer dec.deinit();
    var scratch: [256]u8 = undefined;
    var c = Collector{};
    try dec.decode(dest[0..p], &scratch, &c);
    try std.testing.expectEqual(@as(usize, 3), c.n);
    try c.expect(0, ":status", "503");
    try c.expect(1, "content-type", "text/plain");
    try c.expect(2, "x-custom", "hello world");
}

test "dynamic table evicts oldest entries to honor the size cap" {
    var dec = hpack.Decoder.init(std.testing.allocator, 100, 1 << 16);
    defer dec.deinit();
    var scratch: [256]u8 = undefined;

    // each "custom-key: custom-value" indexed entry costs 10+12+32 = 54; two fit (108>100
    // so only the newest survives once both are added — verify the older is evicted)
    const block = fromHex("400a637573746f6d2d6b65790c637573746f6d2d76616c7565");
    var c1 = Collector{};
    try dec.decode(&block, &scratch, &c1);
    const block2 = fromHex("400a637573746f6d2d6b32790c637573746f6d2d76616c7565");
    var c2 = Collector{};
    try dec.decode(&block2, &scratch, &c2);

    // index 62 must now resolve to the newest (custom-k2y), the first having been evicted
    var c3 = Collector{};
    try dec.decode(&[_]u8{0xbe}, &scratch, &c3);
    try c3.expect(0, "custom-k2y", "custom-value");
    // index 63 (the evicted entry) is gone — a compression error
    var c4 = Collector{};
    try std.testing.expectError(error.CompressionError, dec.decode(&[_]u8{0xbf}, &scratch, &c4));
}
