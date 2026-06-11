//! HTTP/2 frame layer (RFC 9113 §4-6): the 9-octet header, frame/flag/error/setting
//! constants, and fixed-layout readers/writers. No allocation — everything reads from
//! or writes into a caller-owned slice. Payload parsing past the header lives with the
//! frame type that needs it (HEADERS/DATA in connection.zig, HPACK in hpack.zig).

const std = @import("std");

pub const header_len = 9;

/// The 24-octet client connection preface (RFC 9113 §3.4). A server reads this verbatim
/// before any frame; it is followed by the client's SETTINGS frame.
pub const preface = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

pub const FrameType = struct {
    pub const data = 0x0;
    pub const headers = 0x1;
    pub const priority = 0x2;
    pub const rst_stream = 0x3;
    pub const settings = 0x4;
    pub const push_promise = 0x5;
    pub const ping = 0x6;
    pub const goaway = 0x7;
    pub const window_update = 0x8;
    pub const continuation = 0x9;
};

pub const Flags = struct {
    pub const end_stream = 0x1; // DATA, HEADERS
    pub const ack = 0x1; // SETTINGS, PING
    pub const end_headers = 0x4; // HEADERS, CONTINUATION
    pub const padded = 0x8; // DATA, HEADERS
    pub const priority = 0x20; // HEADERS
};

/// RFC 9113 §7. GOAWAY/RST_STREAM carry one of these.
pub const Error = struct {
    pub const no_error = 0x0;
    pub const protocol_error = 0x1;
    pub const internal_error = 0x2;
    pub const flow_control_error = 0x3;
    pub const settings_timeout = 0x4;
    pub const stream_closed = 0x5;
    pub const frame_size_error = 0x6;
    pub const refused_stream = 0x7;
    pub const cancel = 0x8;
    pub const compression_error = 0x9;
    pub const connect_error = 0xa;
    pub const enhance_your_calm = 0xb;
    pub const inadequate_security = 0xc;
    pub const http_1_1_required = 0xd;
};

/// SETTINGS identifiers and their protocol defaults (RFC 9113 §6.5.2).
pub const Setting = struct {
    pub const header_table_size = 0x1;
    pub const enable_push = 0x2;
    pub const max_concurrent_streams = 0x3;
    pub const initial_window_size = 0x4;
    pub const max_frame_size = 0x5;
    pub const max_header_list_size = 0x6;

    pub const default_header_table_size = 4096;
    pub const default_initial_window_size = 65535;
    pub const default_max_frame_size = 16384;
    /// the largest MAX_FRAME_SIZE a peer may set (RFC 9113 §6.5.2), and the ceiling on
    /// any single frame's payload
    pub const max_frame_size_limit = 16777215;
};

/// largest legal flow-control window / WINDOW_UPDATE increment (2^31 - 1)
pub const max_window = 0x7fffffff;

pub const Header = struct {
    length: u32, // payload octets following the header; <= 2^24-1
    type: u8,
    flags: u8,
    stream_id: u31,

    pub fn has(self: Header, flag: u8) bool {
        return self.flags & flag != 0;
    }
};

/// Decode a 9-octet frame header. `buf` must hold at least `header_len` bytes; the
/// reserved high bit of the stream id is masked off per RFC 9113 §4.1.
pub fn parseHeader(buf: *const [header_len]u8) Header {
    return .{
        .length = (@as(u32, buf[0]) << 16) | (@as(u32, buf[1]) << 8) | buf[2],
        .type = buf[3],
        .flags = buf[4],
        .stream_id = @intCast(read31(buf[5..9])),
    };
}

/// Write a 9-octet frame header into the front of `dest` (>= header_len). Returns
/// header_len so call sites can advance a cursor.
pub fn writeHeader(dest: []u8, length: u32, frame_type: u8, flags: u8, stream_id: u31) usize {
    dest[0] = @intCast((length >> 16) & 0xff);
    dest[1] = @intCast((length >> 8) & 0xff);
    dest[2] = @intCast(length & 0xff);
    dest[3] = frame_type;
    dest[4] = flags;
    write32(dest[5..9], stream_id);
    return header_len;
}

/// A full RST_STREAM frame (13 octets) carrying `code` for `stream_id`.
pub fn writeRstStream(dest: []u8, stream_id: u31, code: u32) usize {
    var p = writeHeader(dest, 4, FrameType.rst_stream, 0, stream_id);
    write32(dest[p..][0..4], code);
    p += 4;
    return p;
}

/// A full GOAWAY frame: last processed stream id + error code, no debug data.
pub fn writeGoAway(dest: []u8, last_stream_id: u31, code: u32) usize {
    var p = writeHeader(dest, 8, FrameType.goaway, 0, 0);
    write32(dest[p..][0..4], last_stream_id);
    p += 4;
    write32(dest[p..][0..4], code);
    p += 4;
    return p;
}

/// A WINDOW_UPDATE frame granting `increment` to `stream_id` (0 = connection level).
pub fn writeWindowUpdate(dest: []u8, stream_id: u31, increment: u32) usize {
    var p = writeHeader(dest, 4, FrameType.window_update, 0, stream_id);
    write32(dest[p..][0..4], increment);
    p += 4;
    return p;
}

/// An empty SETTINGS ACK frame.
pub fn writeSettingsAck(dest: []u8) usize {
    return writeHeader(dest, 0, FrameType.settings, Flags.ack, 0);
}

/// A PING frame echoing `opaque_data` (8 octets) with the ACK flag set.
pub fn writePingAck(dest: []u8, opaque_data: *const [8]u8) usize {
    const p = writeHeader(dest, 8, FrameType.ping, Flags.ack, 0);
    @memcpy(dest[p..][0..8], opaque_data);
    return p + 8;
}

/// One SETTINGS entry: a 2-octet id and 4-octet value, packed back to back in the
/// frame payload.
pub const SettingEntry = struct { id: u16, value: u32 };

pub fn readSettingEntry(buf: *const [6]u8) SettingEntry {
    return .{
        .id = (@as(u16, buf[0]) << 8) | buf[1],
        .value = read32(buf[2..6]),
    };
}

pub fn writeSettingEntry(dest: []u8, id: u16, value: u32) usize {
    dest[0] = @intCast((id >> 8) & 0xff);
    dest[1] = @intCast(id & 0xff);
    write32(dest[2..6], value);
    return 6;
}

pub fn read32(buf: *const [4]u8) u32 {
    return (@as(u32, buf[0]) << 24) | (@as(u32, buf[1]) << 16) | (@as(u32, buf[2]) << 8) | buf[3];
}

// stream ids and window increments clear the reserved high bit
fn read31(buf: *const [4]u8) u32 {
    return read32(buf) & 0x7fffffff;
}

fn write32(dest: []u8, v: u32) void {
    dest[0] = @intCast((v >> 24) & 0xff);
    dest[1] = @intCast((v >> 16) & 0xff);
    dest[2] = @intCast((v >> 8) & 0xff);
    dest[3] = @intCast(v & 0xff);
}
