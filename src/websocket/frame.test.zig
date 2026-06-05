const std = @import("std");
const frame = @import("frame.zig");

const big = 1 << 20;

test "parseHeader needs at least two bytes" {
    try std.testing.expect(frame.parseHeader(&[_]u8{0x81}) == null);
}

test "parseHeader reads a short masked text frame" {
    const buf = [_]u8{ 0x81, 0x83, 1, 2, 3, 4, 'a', 'b', 'c' };
    const h = frame.parseHeader(&buf).?;
    try std.testing.expectEqual(@as(usize, 6), h.header_len);
    try std.testing.expectEqual(@as(u64, 3), h.payload_len);
    try std.testing.expect(h.fin and h.masked);
    try std.testing.expectEqual(@as(u8, frame.op_text), h.opcode);
    try std.testing.expectEqual([4]u8{ 1, 2, 3, 4 }, h.mask_key);
}

test "parseHeader decodes the 16-bit extended length" {
    const buf = [_]u8{ 0x82, 0xFE, 0x01, 0x00, 0, 0, 0, 0 }; // binary, masked, len 256
    const h = frame.parseHeader(&buf).?;
    try std.testing.expectEqual(@as(u64, 256), h.payload_len);
    try std.testing.expectEqual(@as(usize, 8), h.header_len);
}

test "parseHeader decodes the 64-bit extended length" {
    const buf = [_]u8{ 0x82, 0xFF, 0, 0, 0, 0, 0, 0x09, 0x60, 0x00, 0, 0, 0, 0 }; // 614400
    const h = frame.parseHeader(&buf).?;
    try std.testing.expectEqual(@as(u64, 614400), h.payload_len);
    try std.testing.expectEqual(@as(usize, 14), h.header_len);
}

test "parseHeader returns null until the mask key is present" {
    try std.testing.expect(frame.parseHeader(&[_]u8{ 0x81, 0x83, 1, 2 }) == null);
}

test "unmask is its own inverse across the word loop and tail" {
    const key = [4]u8{ 9, 8, 7, 6 };
    inline for (.{ 0, 1, 5, 8, 17, 64 }) |n| {
        var data: [n]u8 = undefined;
        for (&data, 0..) |*b, i| b.* = @intCast(i & 0xFF);
        const original = data;
        frame.unmask(&data, key);
        try std.testing.expect(n == 0 or !std.mem.eql(u8, &data, &original)); // actually masked
        frame.unmask(&data, key);
        try std.testing.expectEqualSlices(u8, &original, &data);
    }
}

test "unmask matches a scalar reference" {
    const key = [4]u8{ 0xDE, 0xAD, 0xBE, 0xEF };
    var data: [40]u8 = undefined;
    var ref: [40]u8 = undefined;
    for (&data, &ref, 0..) |*d, *r, i| {
        d.* = @intCast((i * 7) & 0xFF);
        r.* = @as(u8, @intCast((i * 7) & 0xFF)) ^ key[i & 3];
    }
    frame.unmask(&data, key);
    try std.testing.expectEqualSlices(u8, &ref, &data);
}

test "writeHeader frames each length class" {
    var out: [10]u8 = undefined;
    try std.testing.expectEqual(@as(usize, 2), frame.writeHeader(&out, frame.op_text, 5, false));
    try std.testing.expectEqual(@as(u8, 0x81), out[0]);
    try std.testing.expectEqual(@as(u8, 5), out[1]);

    try std.testing.expectEqual(@as(usize, 4), frame.writeHeader(&out, frame.op_binary, 256, false));
    try std.testing.expectEqual(@as(u8, 126), out[1]);
    try std.testing.expectEqual(@as(u8, 0x82), out[0]);

    try std.testing.expectEqual(@as(usize, 10), frame.writeHeader(&out, frame.op_text, 70000, false));
    try std.testing.expectEqual(@as(u8, 127), out[1]);
}

test "writeHeader sets RSV1 for a compressed frame" {
    var out: [10]u8 = undefined;
    _ = frame.writeHeader(&out, frame.op_text, 1, true);
    try std.testing.expectEqual(@as(u8, 0x80 | 0x40 | frame.op_text), out[0]);
}

fn hdr(opcode: u8, rsv: u8, fin: bool, masked: bool, len: u64) frame.Header {
    return .{ .header_len = 6, .payload_len = len, .fin = fin, .rsv = rsv, .opcode = opcode, .masked = masked, .mask_key = .{ 0, 0, 0, 0 } };
}

test "validate accepts a normal masked text frame" {
    try std.testing.expect(frame.validate(hdr(frame.op_text, 0, true, true, 5), false, false, big) == null);
}

test "validate rejects an unmasked client frame" {
    try std.testing.expectEqual(@as(?u16, frame.close_protocol), frame.validate(hdr(frame.op_text, 0, true, false, 5), false, false, big));
}

test "validate rejects RSV2 and RSV3" {
    try std.testing.expectEqual(@as(?u16, frame.close_protocol), frame.validate(hdr(frame.op_text, 0x2, true, true, 5), false, false, big));
    try std.testing.expectEqual(@as(?u16, frame.close_protocol), frame.validate(hdr(frame.op_text, 0x1, true, true, 5), false, false, big));
}

test "validate allows RSV1 only when deflate is negotiated" {
    try std.testing.expectEqual(@as(?u16, frame.close_protocol), frame.validate(hdr(frame.op_text, 0x4, true, true, 5), false, false, big));
    try std.testing.expect(frame.validate(hdr(frame.op_text, 0x4, true, true, 5), false, true, big) == null);
}

test "validate enforces control-frame rules" {
    try std.testing.expectEqual(@as(?u16, frame.close_protocol), frame.validate(hdr(frame.op_ping, 0, false, true, 5), false, false, big)); // fragmented
    try std.testing.expectEqual(@as(?u16, frame.close_protocol), frame.validate(hdr(frame.op_ping, 0, true, true, 126), false, false, big)); // > 125
    try std.testing.expectEqual(@as(?u16, frame.close_protocol), frame.validate(hdr(frame.op_ping, 0x4, true, true, 5), false, false, big)); // RSV1 on control
}

test "validate enforces fragmentation sequencing" {
    try std.testing.expectEqual(@as(?u16, frame.close_protocol), frame.validate(hdr(frame.op_cont, 0, true, true, 5), false, false, big)); // continuation with nothing open
    try std.testing.expectEqual(@as(?u16, frame.close_protocol), frame.validate(hdr(frame.op_text, 0, true, true, 5), true, false, big)); // new message mid-fragment
}

test "validate rejects an oversized frame with 1009" {
    try std.testing.expectEqual(@as(?u16, frame.close_too_big), frame.validate(hdr(frame.op_binary, 0, true, true, 2048), false, false, 1024));
}

test "validCloseCode follows the RFC registry" {
    try std.testing.expect(frame.validCloseCode(1000));
    try std.testing.expect(frame.validCloseCode(3000));
    try std.testing.expect(frame.validCloseCode(4999));
    try std.testing.expect(!frame.validCloseCode(1004));
    try std.testing.expect(!frame.validCloseCode(1006));
    try std.testing.expect(!frame.validCloseCode(1015));
    try std.testing.expect(!frame.validCloseCode(2999));
}
