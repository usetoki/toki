//! HPACK (RFC 7541): header compression for HTTP/2. The decoder is stateful — it keeps
//! the connection's dynamic table — and emits each field to a caller `ctx.field(...)`.
//! The encoder is deliberately stateless: it indexes names against the static table and
//! Huffman-codes strings when that is shorter, but never inserts into a dynamic table, so
//! a server connection carries no encoder state and the peer's table stays empty.

const std = @import("std");
const huffman = @import("huffman.zig");
const table = @import("static_table.zig");

pub const Field = table.Field;
pub const static = table.static;

pub const Error = error{ CompressionError, HeaderListTooLarge };

// every dynamic-table entry and the header list count name+value plus this fixed
// per-entry overhead (RFC 7541 §4.1)
const entry_overhead = 32;

// --- integer codec (RFC 7541 §5.1) ------------------------------------------

const IntResult = struct { value: usize, next: usize };

fn decodeInt(buf: []const u8, start: usize, prefix_bits: u3) Error!IntResult {
    if (start >= buf.len) return error.CompressionError;
    const prefix_max: usize = (@as(usize, 1) << prefix_bits) - 1;
    var value: usize = buf[start] & prefix_max;
    var i = start + 1;
    if (value < prefix_max) return .{ .value = value, .next = i };
    var shift: u6 = 0;
    while (true) {
        if (i >= buf.len) return error.CompressionError;
        const b = buf[i];
        i += 1;
        if (shift > 28) return error.CompressionError; // 5 continuation bytes is already absurd
        value += @as(usize, b & 0x7f) << shift;
        shift += 7;
        if (b & 0x80 == 0) break;
    }
    return .{ .value = value, .next = i };
}

fn encodeInt(dest: []u8, value: usize, prefix_bits: u3, prefix_high: u8) usize {
    const prefix_max: usize = (@as(usize, 1) << prefix_bits) - 1;
    if (value < prefix_max) {
        dest[0] = prefix_high | @as(u8, @intCast(value));
        return 1;
    }
    dest[0] = prefix_high | @as(u8, @intCast(prefix_max));
    var v = value - prefix_max;
    var p: usize = 1;
    while (v >= 128) {
        dest[p] = @intCast((v & 0x7f) | 0x80);
        p += 1;
        v >>= 7;
    }
    dest[p] = @intCast(v);
    return p + 1;
}

// --- string codec (RFC 7541 §5.2) -------------------------------------------

const StrResult = struct { s: []const u8, next: usize };

// A raw literal slices `buf` directly (zero-copy); a Huffman literal decodes into `scratch`
// at `*used`, advancing it. Either way the returned slice stays valid for the request.
fn decodeStr(buf: []const u8, start: usize, scratch: []u8, used: *usize) Error!StrResult {
    if (start >= buf.len) return error.CompressionError;
    const huff = buf[start] & 0x80 != 0;
    const li = try decodeInt(buf, start, 7);
    const len = li.value;
    const data_end = li.next +| len;
    if (data_end > buf.len) return error.CompressionError;
    const raw = buf[li.next..data_end];
    if (!huff) return .{ .s = raw, .next = data_end };
    const out = scratch[used.*..];
    const n = huffman.decode(out, raw) catch |e| return switch (e) {
        error.Overflow => error.HeaderListTooLarge,
        error.BadHuffman => error.CompressionError,
    };
    used.* += n;
    return .{ .s = out[0..n], .next = data_end };
}

fn encodeStr(dest: []u8, s: []const u8) usize {
    const hlen = huffman.encodedLen(s);
    if (hlen < s.len) {
        var p = encodeInt(dest, hlen, 7, 0x80); // H=1
        p += huffman.encode(dest[p..], s);
        return p;
    }
    const p = encodeInt(dest, s.len, 7, 0x00);
    @memcpy(dest[p..][0..s.len], s);
    return p + s.len;
}

// --- decoder: static + dynamic table ----------------------------------------

// name = buf[0..name_len], value = buf[name_len..]; one allocation per live entry
const Entry = struct { buf: []u8, name_len: usize };

// the largest dynamic table we advertise (4096) holds at most 4096/32 entries
pub const dyn_cap = 128;

pub const Decoder = struct {
    gpa: std.mem.Allocator,
    entries: [dyn_cap]Entry = undefined,
    head: usize = 0, // oldest live entry
    count: usize = 0,
    size: usize = 0, // current table size in HPACK units
    max_size: usize, // current cap, lowered by a dynamic-table-size-update
    hard_max: usize, // ceiling we advertised; a size update above this is an error
    max_list: usize, // SETTINGS_MAX_HEADER_LIST_SIZE we enforce while decoding

    pub fn init(gpa: std.mem.Allocator, hard_max: usize, max_list: usize) Decoder {
        return .{ .gpa = gpa, .max_size = hard_max, .hard_max = hard_max, .max_list = max_list };
    }

    pub fn deinit(self: *Decoder) void {
        while (self.count > 0) self.evictOldest();
    }

    fn evictOldest(self: *Decoder) void {
        const e = self.entries[self.head];
        self.size -= e.buf.len + entry_overhead;
        self.gpa.free(e.buf);
        self.head = (self.head + 1) % dyn_cap;
        self.count -= 1;
    }

    fn setMaxSize(self: *Decoder, new_max: usize) void {
        self.max_size = new_max;
        while (self.size > self.max_size and self.count > 0) self.evictOldest();
    }

    fn lookup(self: *const Decoder, index: usize) Error!Field {
        if (index == 0) return error.CompressionError;
        if (index <= static.len) return static[index - 1];
        const j = index - static.len - 1; // 0 = newest dynamic entry
        if (j >= self.count) return error.CompressionError;
        const slot = (self.head + self.count - 1 - j) % dyn_cap;
        const e = self.entries[slot];
        return .{ .name = e.buf[0..e.name_len], .value = e.buf[e.name_len..] };
    }

    // insert (name,value) as the newest entry, evicting oldest to fit (RFC 7541 §4.4)
    fn add(self: *Decoder, name: []const u8, value: []const u8) Error!void {
        const need = name.len + value.len + entry_overhead;
        while (self.size + need > self.max_size and self.count > 0) self.evictOldest();
        if (need > self.max_size) return; // larger than the whole table: emptied, not stored
        const buf = self.gpa.alloc(u8, name.len + value.len) catch return error.CompressionError;
        @memcpy(buf[0..name.len], name);
        @memcpy(buf[name.len..], value);
        self.entries[(self.head + self.count) % dyn_cap] = .{ .buf = buf, .name_len = name.len };
        self.count += 1;
        self.size += need;
    }

    /// Decode one header block, emitting each field to `ctx.field(name, value, sensitive)`.
    /// `scratch` holds Huffman-decoded strings; it must outlive the emitted slices. A
    /// hard HPACK fault is a CompressionError (connection error); exceeding `max_list` is
    /// HeaderListTooLarge. `ctx.field` is infallible — semantic checks happen in the caller
    /// so the table never desyncs.
    pub fn decode(self: *Decoder, block: []const u8, scratch: []u8, ctx: anytype) Error!void {
        var i: usize = 0;
        var used: usize = 0;
        var list: usize = 0;
        var seen_field = false;
        while (i < block.len) {
            const b = block[i];
            if (b & 0x80 != 0) {
                const r = try decodeInt(block, i, 7);
                i = r.next;
                const f = try self.lookup(r.value);
                try emit(ctx, f.name, f.value, false, &list, self.max_list);
                seen_field = true;
            } else if (b & 0x40 != 0) {
                i = try self.literal(block, i, 6, scratch, &used, ctx, &list, .index);
                seen_field = true;
            } else if (b & 0x20 != 0) {
                // dynamic table size update — only valid before any field in the block
                if (seen_field) return error.CompressionError;
                const r = try decodeInt(block, i, 5);
                i = r.next;
                if (r.value > self.hard_max) return error.CompressionError;
                self.setMaxSize(r.value);
            } else {
                const mode: LiteralMode = if (b & 0x10 != 0) .never else .no_index;
                i = try self.literal(block, i, 4, scratch, &used, ctx, &list, mode);
                seen_field = true;
            }
        }
    }

    const LiteralMode = enum { index, no_index, never };

    fn literal(
        self: *Decoder,
        block: []const u8,
        start: usize,
        prefix_bits: u3,
        scratch: []u8,
        used: *usize,
        ctx: anytype,
        list: *usize,
        mode: LiteralMode,
    ) Error!usize {
        const ni = try decodeInt(block, start, prefix_bits);
        var i = ni.next;
        var name: []const u8 = undefined;
        if (ni.value == 0) {
            const ns = try decodeStr(block, i, scratch, used);
            name = ns.s;
            i = ns.next;
        } else {
            name = (try self.lookup(ni.value)).name;
        }
        const vs = try decodeStr(block, i, scratch, used);
        const value = vs.s;
        i = vs.next;
        if (mode == .index) try self.add(name, value);
        try emit(ctx, name, value, mode == .never, list, self.max_list);
        return i;
    }
};

fn emit(ctx: anytype, name: []const u8, value: []const u8, sensitive: bool, list: *usize, max_list: usize) Error!void {
    list.* +|= name.len + value.len + entry_overhead;
    if (list.* > max_list) return error.HeaderListTooLarge;
    ctx.field(name, value, sensitive);
}

// --- encoder (stateless) ----------------------------------------------------

/// Encode the `:status` pseudo-header. Common codes are a single indexed byte; the rest
/// reuse the static `:status` name with a literal value.
pub fn encodeStatus(dest: []u8, status: u16) usize {
    const indexed: ?usize = switch (status) {
        200 => 8,
        204 => 9,
        206 => 10,
        304 => 11,
        400 => 12,
        404 => 13,
        500 => 14,
        else => null,
    };
    if (indexed) |x| return encodeInt(dest, x, 7, 0x80);
    var p = encodeInt(dest, 8, 4, 0x00); // literal without indexing, name = :status (static 8)
    var digits: [3]u8 = .{ '0' + @as(u8, @intCast((status / 100) % 10)), '0' + @as(u8, @intCast((status / 10) % 10)), '0' + @as(u8, @intCast(status % 10)) };
    p += encodeStr(dest[p..], &digits);
    return p;
}

/// Encode one response header as a literal-without-indexing field. The name is lowercased
/// (RFC 9113 §8.2.1) into `lower` and matched against the static table for a name index.
pub fn encodeHeader(dest: []u8, name: []const u8, value: []const u8, lower: []u8) usize {
    const lname = toLower(lower, name);
    var p: usize = 0;
    if (staticNameIndex(lname)) |x| {
        p += encodeInt(dest, x, 4, 0x00);
    } else {
        p += encodeInt(dest, 0, 4, 0x00);
        p += encodeStr(dest[p..], lname);
    }
    p += encodeStr(dest[p..], value);
    return p;
}

fn toLower(dest: []u8, s: []const u8) []const u8 {
    const n = @min(s.len, dest.len);
    for (s[0..n], 0..) |c, i| dest[i] = std.ascii.toLower(c);
    return dest[0..n];
}

// first static entry whose name matches (1-based index), for encoder name reuse
fn staticNameIndex(name: []const u8) ?usize {
    for (static, 0..) |f, i| {
        if (std.mem.eql(u8, f.name, name)) return i + 1;
    }
    return null;
}
