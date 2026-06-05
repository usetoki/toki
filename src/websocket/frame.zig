//! WebSocket wire format (RFC 6455 §5): frame header parsing, masking, the
//! header writer, and frame-level protocol validation. Pure byte logic with no
//! I/O or N-API, so it builds and unit-tests on its own.

const std = @import("std");

// opcodes
pub const op_cont = 0x0;
pub const op_text = 0x1;
pub const op_binary = 0x2;
pub const op_close = 0x8;
pub const op_ping = 0x9;
pub const op_pong = 0xA;

// close codes (RFC 6455 §7.4)
pub const close_normal = 1000;
pub const close_protocol = 1002;
pub const close_bad_data = 1007; // payload inconsistent with the message type (bad UTF-8)
pub const close_too_big = 1009;
pub const close_internal = 1011;

pub const Header = struct {
    header_len: usize,
    // u64 so a 64-bit length can't overflow usize on a 32-bit target before validate
    // rejects it; the narrowing to usize happens only once it is within the cap
    payload_len: u64,
    fin: bool,
    rsv: u8,
    opcode: u8,
    masked: bool,
    mask_key: [4]u8,
};

/// Parse a frame header, or null when fewer than its full length is buffered.
pub fn parseHeader(buf: []const u8) ?Header {
    if (buf.len < 2) return null;
    const fin = (buf[0] & 0x80) != 0;
    const rsv = (buf[0] >> 4) & 0x07;
    const opcode = buf[0] & 0x0F;
    const masked = (buf[1] & 0x80) != 0;
    var len: u64 = buf[1] & 0x7F;
    var p: usize = 2;
    if (len == 126) {
        if (buf.len < 4) return null;
        len = (@as(u64, buf[2]) << 8) | buf[3];
        p = 4;
    } else if (len == 127) {
        if (buf.len < 10) return null;
        len = 0;
        for (buf[2..10]) |b| len = (len << 8) | b;
        p = 10;
    }
    var key = [4]u8{ 0, 0, 0, 0 };
    if (masked) {
        if (buf.len < p + 4) return null;
        key = .{ buf[p], buf[p + 1], buf[p + 2], buf[p + 3] };
        p += 4;
    }
    return .{ .header_len = p, .payload_len = len, .fin = fin, .rsv = rsv, .opcode = opcode, .masked = masked, .mask_key = key };
}

/// The close code to send if the frame breaks the protocol, else null.
/// `deflate` allows RSV1 on data frames; `max_message` caps a single frame.
pub fn validate(h: Header, frag_active: bool, deflate: bool, max_message: usize) ?u16 {
    if (h.rsv & 0x3 != 0) return close_protocol; // RSV2/RSV3 are never valid here
    const rsv1 = h.rsv & 0x4 != 0; // permessage-deflate marks a compressed message
    if (!h.masked) return close_protocol; // client-to-server frames must be masked
    if (h.opcode & 0x8 != 0) {
        // control frame: never compressed, must be known, never fragmented, payload <= 125
        if (rsv1) return close_protocol;
        if (h.opcode != op_close and h.opcode != op_ping and h.opcode != op_pong) return close_protocol;
        if (!h.fin) return close_protocol;
        if (h.payload_len > 125) return close_protocol;
        return null;
    }
    switch (h.opcode) {
        op_text, op_binary => {
            if (frag_active) return close_protocol; // a new message before the last finished
            if (rsv1 and !deflate) return close_protocol; // RSV1 without the negotiated extension
        },
        op_cont => {
            if (!frag_active) return close_protocol; // continuation with nothing to continue
            if (rsv1) return close_protocol; // only a message's first frame carries RSV1
        },
        else => return close_protocol, // reserved data opcode (3-7)
    }
    if (h.payload_len > max_message) return close_too_big;
    return null;
}

pub fn validCloseCode(code: u16) bool {
    return switch (code) {
        1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011 => true,
        else => code >= 3000 and code <= 4999, // 3000-3999 registered, 4000-4999 private
    };
}

pub fn unmask(payload: []u8, key: [4]u8) void {
    // XOR eight bytes per step with the 4-byte key tiled into a u64 (little-endian,
    // so it matches the readInt below on any host); the tail goes byte-wise. Steps
    // of 8 keep i a multiple of 4, so key alignment holds.
    const k64: u64 = @as(u64, key[0]) | (@as(u64, key[1]) << 8) | (@as(u64, key[2]) << 16) |
        (@as(u64, key[3]) << 24) | (@as(u64, key[0]) << 32) | (@as(u64, key[1]) << 40) |
        (@as(u64, key[2]) << 48) | (@as(u64, key[3]) << 56);
    var i: usize = 0;
    while (i + 8 <= payload.len) : (i += 8) {
        const chunk = std.mem.readInt(u64, payload[i..][0..8], .little);
        std.mem.writeInt(u64, payload[i..][0..8], chunk ^ k64, .little);
    }
    while (i < payload.len) : (i += 1) payload[i] ^= key[i & 3];
}

/// Write a server frame header into `dest`, returning its length. Server frames
/// are never masked; FIN is always set, and RSV1 marks a compressed payload.
pub fn writeHeader(dest: *[10]u8, opcode: u8, len: usize, rsv1: bool) usize {
    dest[0] = 0x80 | (if (rsv1) @as(u8, 0x40) else 0) | opcode;
    if (len < 126) {
        dest[1] = @intCast(len);
        return 2;
    }
    if (len <= 0xFFFF) {
        dest[1] = 126;
        dest[2] = @intCast((len >> 8) & 0xFF);
        dest[3] = @intCast(len & 0xFF);
        return 4;
    }
    dest[1] = 127;
    const n: u64 = len; // shift a u64 so the wide shifts hold on 32-bit targets too
    var i: usize = 0;
    while (i < 8) : (i += 1) {
        const shift: u6 = @intCast((7 - i) * 8);
        dest[2 + i] = @intCast((n >> shift) & 0xFF);
    }
    return 10;
}
