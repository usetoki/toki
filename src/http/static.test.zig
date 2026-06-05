const std = @import("std");
const mod = @import("static.zig");
const Entry = mod.Entry;
const Input = mod.Input;
const Rendered = mod.Rendered;
const Table = mod.Table;
const Variant = mod.Variant;
const deinit = mod.deinit;
const get = mod.get;
const init = mod.init;
const isEmpty = mod.isEmpty;
const put = mod.put;
const putFile = mod.putFile;
const render = mod.render;

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
