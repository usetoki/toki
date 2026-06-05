//! In-memory static file table with content-encoding variants.
//!
//! Files are read once at `listen` (by the TypeScript layer), which also
//! pre-computes gzip/brotli variants for compressible files. Serving is a hash
//! lookup, an `Accept-Encoding` choice, and a corked write — no per-request I/O,
//! no compression cost, no JavaScript. No path traversal is possible because only
//! registered URLs exist. ETag/304 and HEAD are handled here; ranges are not yet.

const std = @import("std");
const response = @import("response.zig");
const mime = @import("mime.zig");

pub const Variant = struct {
    headers: []const u8,
    body: []const u8,
};

pub const Entry = struct {
    etag: []const u8, // quoted, shared across encodings
    identity: Variant,
    gzip: ?Variant,
    brotli: ?Variant,
};

/// Table.put input; optional fields add encoding variants.
pub const Input = struct {
    path: []const u8,
    etag: []const u8,
    headers: []const u8,
    body: []const u8,
    gzip_headers: ?[]const u8 = null,
    gzip: ?[]const u8 = null,
    brotli_headers: ?[]const u8 = null,
    brotli: ?[]const u8 = null,
};

pub const Table = struct {
    arena: std.heap.ArenaAllocator,
    by_path: std.StringHashMapUnmanaged(Entry),

    pub fn init(gpa: std.mem.Allocator) Table {
        return .{ .arena = std.heap.ArenaAllocator.init(gpa), .by_path = .empty };
    }

    pub fn deinit(self: *Table) void {
        self.arena.deinit();
    }

    pub fn isEmpty(self: *const Table) bool {
        return self.by_path.count() == 0;
    }

    /// copies every slice into the arena; caller keeps ownership of inputs
    pub fn put(self: *Table, in: Input) !void {
        const a = self.arena.allocator();
        try self.by_path.put(a, try a.dupe(u8, in.path), .{
            .etag = try a.dupe(u8, in.etag),
            .identity = .{ .headers = try a.dupe(u8, in.headers), .body = try a.dupe(u8, in.body) },
            .gzip = try dupeVariant(a, in.gzip_headers, in.gzip),
            .brotli = try dupeVariant(a, in.brotli_headers, in.brotli),
        });
    }

    pub fn get(self: *const Table, path: []const u8) ?Entry {
        return self.by_path.get(path);
    }

    /// derives mime/etag/header blocks natively; TS only ships bytes + policy + variants
    pub fn putFile(self: *Table, path: []const u8, body: []const u8, mtime_ms: u64, cache_control: []const u8, gzip: ?[]const u8, brotli: ?[]const u8) !void {
        const a = self.arena.allocator();
        const content_type = mime.lookupPath(path);
        const etag = try std.fmt.allocPrint(a, "\"{x}-{x}\"", .{ body.len, mtime_ms });
        const vary: []const u8 = if (gzip != null or brotli != null) "Vary: Accept-Encoding\r\n" else "";

        try self.by_path.put(a, try a.dupe(u8, path), .{
            .etag = etag,
            .identity = .{
                .headers = try headerBlock(a, content_type, etag, cache_control, null, vary),
                .body = try a.dupe(u8, body),
            },
            .gzip = try encodedVariant(a, content_type, etag, cache_control, vary, "gzip", gzip),
            .brotli = try encodedVariant(a, content_type, etag, cache_control, vary, "br", brotli),
        });
    }
};

fn headerBlock(a: std.mem.Allocator, content_type: []const u8, etag: []const u8, cache_control: []const u8, encoding: ?[]const u8, vary: []const u8) ![]const u8 {
    const enc_line = if (encoding) |e|
        try std.fmt.allocPrint(a, "Content-Encoding: {s}\r\n", .{e})
    else
        "";
    return std.fmt.allocPrint(a, "Content-Type: {s}\r\nETag: {s}\r\nCache-Control: {s}\r\n{s}{s}", .{ content_type, etag, cache_control, enc_line, vary });
}

fn encodedVariant(a: std.mem.Allocator, content_type: []const u8, etag: []const u8, cache_control: []const u8, vary: []const u8, encoding: []const u8, body: ?[]const u8) !?Variant {
    const bytes = body orelse return null;
    return .{
        .headers = try headerBlock(a, content_type, etag, cache_control, encoding, vary),
        .body = try a.dupe(u8, bytes),
    };
}

fn dupeVariant(a: std.mem.Allocator, headers: ?[]const u8, body: ?[]const u8) !?Variant {
    const h = headers orelse return null;
    const b = body orelse return null;
    return .{ .headers = try a.dupe(u8, h), .body = try a.dupe(u8, b) };
}

/// head bytes (in caller's buffer) + body to write after; body empty for 304/HEAD.
/// body stays separate so caller writes it straight from the arena, any size, never via the cork.
pub const Rendered = struct {
    head_len: usize,
    body: []const u8,
};

/// frames the head into head_dest, negotiates encoding; 304 wins over content
pub fn render(head_dest: []u8, entry: Entry, accept_encoding: ?[]const u8, if_none_match: ?[]const u8, is_head: bool, keep_alive: bool) Rendered {
    if (etagMatches(if_none_match, entry.etag)) {
        return .{ .head_len = response.serializeHead(head_dest, 304, entry.identity.headers, 0, keep_alive), .body = "" };
    }
    const chosen = negotiate(entry, accept_encoding);
    const head_len = response.serializeHead(head_dest, 200, chosen.headers, chosen.body.len, keep_alive);
    return .{ .head_len = head_len, .body = if (is_head) "" else chosen.body };
}

/// preference order: brotli > gzip > identity
fn negotiate(entry: Entry, accept_encoding: ?[]const u8) Variant {
    const accept = accept_encoding orelse return entry.identity;
    if (entry.brotli) |v| {
        if (accepts(accept, "br")) return v;
    }
    if (entry.gzip) |v| {
        if (accepts(accept, "gzip")) return v;
    }
    return entry.identity;
}

/// coding allowed when token (or `*`) present with q != 0
fn accepts(accept_encoding: []const u8, coding: []const u8) bool {
    var it = std.mem.splitScalar(u8, accept_encoding, ',');
    while (it.next()) |part| {
        const segment = std.mem.trim(u8, part, " \t");
        const semi = std.mem.indexOfScalar(u8, segment, ';');
        const name = std.mem.trim(u8, if (semi) |s| segment[0..s] else segment, " \t");
        if (!std.ascii.eqlIgnoreCase(name, coding) and !std.mem.eql(u8, name, "*")) continue;
        if (semi) |s| {
            if (std.mem.indexOf(u8, segment[s + 1 ..], "q=")) |qi| {
                const q = std.fmt.parseFloat(f64, std.mem.trim(u8, segment[s + 1 + qi + 2 ..], " \t")) catch 1.0;
                if (q == 0) continue;
            }
        }
        return true;
    }
    return false;
}

/// matches `*` or any token == etag; weak `W/` prefix stripped before compare
fn etagMatches(if_none_match: ?[]const u8, etag: []const u8) bool {
    const header = if_none_match orelse return false;
    const trimmed = std.mem.trim(u8, header, " \t");
    if (std.mem.eql(u8, trimmed, "*")) return true;

    var it = std.mem.splitScalar(u8, trimmed, ',');
    while (it.next()) |part| {
        const candidate = std.mem.trim(u8, part, " \t");
        const unweak = if (std.mem.startsWith(u8, candidate, "W/")) candidate[2..] else candidate;
        if (std.mem.eql(u8, unweak, etag)) return true;
    }
    return false;
}

fn cssEntry(table: *Table) !void {
    try table.put(.{
        .path = "/app.css",
        .etag = "\"abc\"",
        .headers = "Content-Type: text/css\r\nVary: Accept-Encoding\r\n",
        .body = "body{color:red}",
        .gzip_headers = "Content-Type: text/css\r\nContent-Encoding: gzip\r\nVary: Accept-Encoding\r\n",
        .gzip = "GZIPPED",
        .brotli_headers = "Content-Type: text/css\r\nContent-Encoding: br\r\nVary: Accept-Encoding\r\n",
        .brotli = "BROTLIED",
    });
}

test "negotiates brotli, gzip, identity" {
    var table = Table.init(std.testing.allocator);
    defer table.deinit();
    try cssEntry(&table);
    const entry = table.get("/app.css").?;
    var buf: [256]u8 = undefined;

    const br = render(&buf, entry, "gzip, br", null, false, true);
    try std.testing.expectEqualStrings("BROTLIED", br.body);
    try std.testing.expect(std.mem.indexOf(u8, buf[0..br.head_len], "Content-Encoding: br\r\n") != null);

    const gz = render(&buf, entry, "gzip, deflate", null, false, true);
    try std.testing.expectEqualStrings("GZIPPED", gz.body);

    const id = render(&buf, entry, "identity", null, false, true);
    try std.testing.expectEqualStrings("body{color:red}", id.body);

    const none = render(&buf, entry, null, null, false, true);
    try std.testing.expectEqualStrings("body{color:red}", none.body);
}

test "q=0 excludes an encoding" {
    var table = Table.init(std.testing.allocator);
    defer table.deinit();
    try cssEntry(&table);
    const entry = table.get("/app.css").?;
    var buf: [256]u8 = undefined;
    const out = render(&buf, entry, "br;q=0, gzip", null, false, true);
    try std.testing.expectEqualStrings("GZIPPED", out.body);
}

test "304 ignores encoding" {
    var table = Table.init(std.testing.allocator);
    defer table.deinit();
    try cssEntry(&table);
    const entry = table.get("/app.css").?;
    var buf: [256]u8 = undefined;
    const out = render(&buf, entry, "br", "\"abc\"", false, true);
    try std.testing.expect(std.mem.startsWith(u8, buf[0..out.head_len], "HTTP/1.1 304"));
    try std.testing.expectEqual(@as(usize, 0), out.body.len);
}

test "putFile derives mime, etag, and headers natively" {
    var table = Table.init(std.testing.allocator);
    defer table.deinit();
    try table.putFile("/assets/app.css", "body{color:red}", 1000, "public, max-age=60", "GZIP", null);

    const entry = table.get("/assets/app.css").?;
    try std.testing.expectEqualStrings("\"f-3e8\"", entry.etag); // len 15 = 0xf, mtime 1000 = 0x3e8
    try std.testing.expect(std.mem.indexOf(u8, entry.identity.headers, "Content-Type: text/css; charset=utf-8\r\n") != null);
    try std.testing.expect(std.mem.indexOf(u8, entry.identity.headers, "Cache-Control: public, max-age=60\r\n") != null);
    try std.testing.expect(std.mem.indexOf(u8, entry.identity.headers, "Vary: Accept-Encoding\r\n") != null);
    try std.testing.expect(entry.gzip != null);
    try std.testing.expect(std.mem.indexOf(u8, entry.gzip.?.headers, "Content-Encoding: gzip\r\n") != null);
    try std.testing.expect(entry.brotli == null);
}

test "file without variants serves identity" {
    var table = Table.init(std.testing.allocator);
    defer table.deinit();
    try table.put(.{ .path = "/x.png", .etag = "\"v\"", .headers = "Content-Type: image/png\r\n", .body = "PNG" });
    const entry = table.get("/x.png").?;
    var buf: [256]u8 = undefined;
    const out = render(&buf, entry, "br, gzip", null, false, true);
    try std.testing.expectEqualStrings("PNG", out.body);
}
