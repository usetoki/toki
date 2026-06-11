const std = @import("std");
const frame = @import("frame.zig");

test "parseHeader decodes length, type, flags and masks the reserved bit" {
    // length 0x010203, type HEADERS, flags END_HEADERS|END_STREAM, stream id 1 with the
    // reserved high bit set — which must be ignored.
    const buf = [_]u8{ 0x01, 0x02, 0x03, 0x01, 0x05, 0x80, 0x00, 0x00, 0x01 };
    const h = frame.parseHeader(&buf);
    try std.testing.expectEqual(@as(u32, 0x010203), h.length);
    try std.testing.expectEqual(@as(u8, frame.FrameType.headers), h.type);
    try std.testing.expect(h.has(frame.Flags.end_headers));
    try std.testing.expect(h.has(frame.Flags.end_stream));
    try std.testing.expect(!h.has(frame.Flags.padded));
    try std.testing.expectEqual(@as(u31, 1), h.stream_id);
}

test "writeHeader round-trips through parseHeader" {
    var dest: [frame.header_len]u8 = undefined;
    try std.testing.expectEqual(@as(usize, 9), frame.writeHeader(&dest, 1234, frame.FrameType.data, frame.Flags.end_stream, 7));
    const h = frame.parseHeader(&dest);
    try std.testing.expectEqual(@as(u32, 1234), h.length);
    try std.testing.expectEqual(@as(u8, frame.FrameType.data), h.type);
    try std.testing.expect(h.has(frame.Flags.end_stream));
    try std.testing.expectEqual(@as(u31, 7), h.stream_id);
}

test "writeRstStream emits a 13-octet frame with the code" {
    var dest: [13]u8 = undefined;
    const n = frame.writeRstStream(&dest, 3, frame.Error.cancel);
    try std.testing.expectEqual(@as(usize, 13), n);
    const h = frame.parseHeader(dest[0..9]);
    try std.testing.expectEqual(@as(u32, 4), h.length);
    try std.testing.expectEqual(@as(u8, frame.FrameType.rst_stream), h.type);
    try std.testing.expectEqual(@as(u31, 3), h.stream_id);
    try std.testing.expectEqual(@as(u32, frame.Error.cancel), frame.read32(dest[9..13]));
}

test "writeGoAway carries last stream id and error code on stream 0" {
    var dest: [17]u8 = undefined;
    const n = frame.writeGoAway(&dest, 5, frame.Error.protocol_error);
    try std.testing.expectEqual(@as(usize, 17), n);
    const h = frame.parseHeader(dest[0..9]);
    try std.testing.expectEqual(@as(u32, 8), h.length);
    try std.testing.expectEqual(@as(u31, 0), h.stream_id);
    try std.testing.expectEqual(@as(u32, 5), frame.read32(dest[9..13]));
    try std.testing.expectEqual(@as(u32, frame.Error.protocol_error), frame.read32(dest[13..17]));
}

test "writeWindowUpdate targets a stream with an increment" {
    var dest: [13]u8 = undefined;
    _ = frame.writeWindowUpdate(&dest, 9, 65535);
    const h = frame.parseHeader(dest[0..9]);
    try std.testing.expectEqual(@as(u8, frame.FrameType.window_update), h.type);
    try std.testing.expectEqual(@as(u31, 9), h.stream_id);
    try std.testing.expectEqual(@as(u32, 65535), frame.read32(dest[9..13]));
}

test "writeSettingsAck is an empty SETTINGS frame with ACK set" {
    var dest: [frame.header_len]u8 = undefined;
    try std.testing.expectEqual(@as(usize, 9), frame.writeSettingsAck(&dest));
    const h = frame.parseHeader(&dest);
    try std.testing.expectEqual(@as(u32, 0), h.length);
    try std.testing.expectEqual(@as(u8, frame.FrameType.settings), h.type);
    try std.testing.expect(h.has(frame.Flags.ack));
}

test "writePingAck echoes the opaque payload" {
    var dest: [17]u8 = undefined;
    const data = [8]u8{ 1, 2, 3, 4, 5, 6, 7, 8 };
    _ = frame.writePingAck(&dest, &data);
    const h = frame.parseHeader(dest[0..9]);
    try std.testing.expectEqual(@as(u8, frame.FrameType.ping), h.type);
    try std.testing.expect(h.has(frame.Flags.ack));
    try std.testing.expectEqualSlices(u8, &data, dest[9..17]);
}

test "settings entry round-trips" {
    var dest: [6]u8 = undefined;
    _ = frame.writeSettingEntry(&dest, frame.Setting.initial_window_size, 131072);
    const e = frame.readSettingEntry(&dest);
    try std.testing.expectEqual(@as(u16, frame.Setting.initial_window_size), e.id);
    try std.testing.expectEqual(@as(u32, 131072), e.value);
}

test "preface is the canonical 24 octets" {
    try std.testing.expectEqual(@as(usize, 24), frame.preface.len);
    try std.testing.expectEqualStrings("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", frame.preface);
}
