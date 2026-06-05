const std = @import("std");
const mod = @import("mime.zig");
const default_type = mod.default_type;
const isCompressible = mod.isCompressible;
const lookupExt = mod.lookupExt;
const lookupPath = mod.lookupPath;

test "lookup by path and extension" {
    try std.testing.expectEqualStrings("text/html; charset=utf-8", lookupPath("/index.html"));
    try std.testing.expectEqualStrings("font/woff2", lookupPath("/fonts/a.woff2"));
    try std.testing.expectEqualStrings("application/wasm", lookupExt("wasm"));
    try std.testing.expectEqualStrings("image/png", lookupExt("PNG"));
    try std.testing.expectEqualStrings(default_type, lookupPath("/noext"));
    try std.testing.expectEqualStrings(default_type, lookupExt("madeup"));
}

const testing = std.testing;

test "lookupExt case insensitive variants" {
    // every case permutation maps to the same entry
    try testing.expectEqualStrings("image/png", lookupExt("png"));
    try testing.expectEqualStrings("image/png", lookupExt("PNG"));
    try testing.expectEqualStrings("image/png", lookupExt("Png"));
    try testing.expectEqualStrings("image/png", lookupExt("pNg"));
    try testing.expectEqualStrings("text/html; charset=utf-8", lookupExt("HTML"));
    try testing.expectEqualStrings("text/html; charset=utf-8", lookupExt("HtMl"));
    try testing.expectEqualStrings("application/json; charset=utf-8", lookupExt("JSON"));
    try testing.expectEqualStrings("application/json; charset=utf-8", lookupExt("Json"));
}

test "lookupPath case insensitive" {
    try testing.expectEqualStrings("image/jpeg", lookupPath("/a/PHOTO.JPG"));
    try testing.expectEqualStrings("image/jpeg", lookupPath("/a/Photo.Jpeg"));
    try testing.expectEqualStrings("application/pdf", lookupPath("REPORT.PDF"));
    try testing.expectEqualStrings("text/css; charset=utf-8", lookupPath("/styles/MAIN.CSS"));
}

test "charset on text types" {
    // text/* and several text-ish application/* carry an explicit utf-8 charset
    try testing.expectEqualStrings("text/plain; charset=utf-8", lookupExt("txt"));
    try testing.expectEqualStrings("text/css; charset=utf-8", lookupExt("css"));
    try testing.expectEqualStrings("text/javascript; charset=utf-8", lookupExt("js"));
    try testing.expectEqualStrings("text/markdown; charset=utf-8", lookupExt("md"));
    try testing.expectEqualStrings("text/csv; charset=utf-8", lookupExt("csv"));
    try testing.expectEqualStrings("text/calendar; charset=utf-8", lookupExt("ics"));
    try testing.expectEqualStrings("application/json; charset=utf-8", lookupExt("json"));
    try testing.expectEqualStrings("application/xml; charset=utf-8", lookupExt("xml"));
    try testing.expectEqualStrings("application/ld+json; charset=utf-8", lookupExt("jsonld"));
    try testing.expectEqualStrings("application/manifest+json; charset=utf-8", lookupExt("webmanifest"));
    try testing.expectEqualStrings("image/svg+xml; charset=utf-8", lookupExt("svg"));
    try testing.expectEqualStrings("text/x-zig; charset=utf-8", lookupExt("zig"));
    try testing.expectEqualStrings("application/yaml; charset=utf-8", lookupExt("yaml"));
}

test "text types end with charset suffix" {
    // assert the charset is literally appended, not just present somewhere
    const types = [_][]const u8{ "txt", "html", "css", "js", "md", "json", "xml", "svg" };
    for (types) |ext| {
        const ct = lookupExt(ext);
        try testing.expect(std.mem.endsWith(u8, ct, "; charset=utf-8"));
    }
}

test "binary types carry no charset" {
    // image/audio/video/font/archive binaries must not declare a charset
    const types = [_][]const u8{ "png", "jpg", "gif", "webp", "mp3", "mp4", "woff2", "zip", "pdf", "wasm" };
    for (types) |ext| {
        const ct = lookupExt(ext);
        try testing.expect(std.mem.indexOf(u8, ct, "charset") == null);
    }
}

test "default octet-stream on miss" {
    try testing.expectEqualStrings(default_type, lookupExt("madeup"));
    try testing.expectEqualStrings(default_type, lookupExt("xyz"));
    try testing.expectEqualStrings(default_type, lookupExt("zzz"));
    try testing.expectEqualStrings(default_type, lookupPath("/file.unknownext"));
    try testing.expectEqualStrings(default_type, lookupPath("/file.q"));
}

test "default_type constant value" {
    try testing.expectEqualStrings("application/octet-stream", default_type);
}

test "lookupExt empty slice" {
    try testing.expectEqualStrings(default_type, lookupExt(""));
    try testing.expectEqualStrings(default_type, lookupExt(&[_]u8{}));
}

test "lookupExt boundary at 16 byte buffer" {
    // buffer is exactly 16 bytes: 16-char ext is processed, 17-char ext bails early
    const len16 = "aaaaaaaaaaaaaaaa"; // 16 chars, not in table -> default
    try testing.expectEqual(@as(usize, 16), len16.len);
    try testing.expectEqualStrings(default_type, lookupExt(len16));

    const len17 = "aaaaaaaaaaaaaaaaa"; // 17 chars, exceeds buffer -> bails -> default
    try testing.expectEqual(@as(usize, 17), len17.len);
    try testing.expectEqualStrings(default_type, lookupExt(len17));

    // a giant ext must not overrun; still returns default safely
    const huge = "x" ** 256;
    try testing.expectEqualStrings(default_type, lookupExt(huge));
}

test "lookupExt single char extensions" {
    try testing.expectEqualStrings("text/x-csrc; charset=utf-8", lookupExt("c"));
    try testing.expectEqualStrings("text/x-chdr; charset=utf-8", lookupExt("h"));
    try testing.expectEqualStrings("text/x-csrc; charset=utf-8", lookupExt("C"));
    // single unknown char -> default
    try testing.expectEqualStrings(default_type, lookupExt("q"));
}

test "lookupExt longest table key webmanifest" {
    // 11-char key fits comfortably under the 16-byte cap
    try testing.expectEqual(@as(usize, 11), "webmanifest".len);
    try testing.expectEqualStrings("application/manifest+json; charset=utf-8", lookupExt("webmanifest"));
    try testing.expectEqualStrings("application/manifest+json; charset=utf-8", lookupExt("WEBMANIFEST"));
}

test "lookupPath no dot" {
    try testing.expectEqualStrings(default_type, lookupPath("noext"));
    try testing.expectEqualStrings(default_type, lookupPath("/a/b/c/noext"));
    try testing.expectEqualStrings(default_type, lookupPath(""));
    try testing.expectEqualStrings(default_type, lookupPath("/"));
}

test "lookupPath trailing dot empty ext" {
    // dot is the last char -> ext slice is empty -> default
    try testing.expectEqualStrings(default_type, lookupPath("file."));
    try testing.expectEqualStrings(default_type, lookupPath("/dir/archive."));
}

test "lookupPath leading dot dotfile" {
    // a dotfile like ".gitignore": the only dot is at the front, ext is the whole name
    try testing.expectEqualStrings(default_type, lookupPath(".gitignore"));
    // ".html" -> dot at index 0, ext "html" -> matches
    try testing.expectEqualStrings("text/html; charset=utf-8", lookupPath(".html"));
}

test "lookupPath multiple dots uses last" {
    try testing.expectEqualStrings("application/gzip", lookupPath("archive.tar.gz"));
    try testing.expectEqualStrings("text/javascript; charset=utf-8", lookupPath("app.min.js"));
    try testing.expectEqualStrings("application/json; charset=utf-8", lookupPath("bundle.js.map"));
    try testing.expectEqualStrings("text/x-zig; charset=utf-8", lookupPath("a.b.c.d.zig"));
}

test "lookupPath dot in directory not filename" {
    // last dot belongs to a directory component; filename has no extension
    try testing.expectEqualStrings(default_type, lookupPath("/v1.2/release/binary"));
    // but a real ext after such a dir still resolves
    try testing.expectEqualStrings("application/pdf", lookupPath("/v1.2/release/doc.pdf"));
}

test "lookupPath unknown ext after valid dot" {
    try testing.expectEqualStrings(default_type, lookupPath("/x/y.bogusext"));
}

test "lookupPath query-like and dotted names" {
    // no special URL handling: a query string is part of the ext slice -> miss
    try testing.expectEqualStrings(default_type, lookupPath("/style.css?v=2"));
    // bare ext at root
    try testing.expectEqualStrings("image/x-icon", lookupPath("/favicon.ico"));
}

test "isCompressible text family true" {
    try testing.expect(isCompressible("text/html; charset=utf-8"));
    try testing.expect(isCompressible("text/plain"));
    try testing.expect(isCompressible("text/css; charset=utf-8"));
    try testing.expect(isCompressible("text/x-zig; charset=utf-8"));
    try testing.expect(isCompressible("text/"));
}

test "isCompressible svg true other images false" {
    try testing.expect(isCompressible("image/svg+xml; charset=utf-8"));
    try testing.expect(isCompressible("image/svg"));
    try testing.expect(!isCompressible("image/png"));
    try testing.expect(!isCompressible("image/jpeg"));
    try testing.expect(!isCompressible("image/webp"));
    try testing.expect(!isCompressible("image/gif"));
}

test "isCompressible application subtypes true" {
    try testing.expect(isCompressible("application/json; charset=utf-8"));
    try testing.expect(isCompressible("application/javascript"));
    try testing.expect(isCompressible("application/xml; charset=utf-8"));
    try testing.expect(isCompressible("application/wasm"));
    // +json and +xml structured-syntax suffixes
    try testing.expect(isCompressible("application/ld+json; charset=utf-8"));
    try testing.expect(isCompressible("application/manifest+json; charset=utf-8"));
    try testing.expect(isCompressible("application/atom+xml"));
    try testing.expect(isCompressible("application/rss+xml"));
    try testing.expect(isCompressible("application/xhtml+xml; charset=utf-8"));
}

test "isCompressible application binaries false" {
    try testing.expect(!isCompressible("application/octet-stream"));
    try testing.expect(!isCompressible("application/pdf"));
    try testing.expect(!isCompressible("application/zip"));
    try testing.expect(!isCompressible("application/gzip"));
    try testing.expect(!isCompressible("application/msword"));
    try testing.expect(!isCompressible("application/x-tar"));
    try testing.expect(!isCompressible(default_type));
}

test "isCompressible non text non app false" {
    try testing.expect(!isCompressible("audio/mpeg"));
    try testing.expect(!isCompressible("video/mp4"));
    try testing.expect(!isCompressible("font/woff2"));
    try testing.expect(!isCompressible("image/avif"));
}

test "isCompressible empty and short inputs" {
    // must survive degenerate inputs without panicking
    try testing.expect(!isCompressible(""));
    try testing.expect(!isCompressible("t"));
    try testing.expect(!isCompressible("text")); // no trailing slash -> not "text/"
    try testing.expect(!isCompressible("application")); // no slash -> prefix check fails
    try testing.expect(!isCompressible("application/")); // empty subtype -> none match
    try testing.expect(!isCompressible("image/sv")); // truncated, not "image/svg"
}

test "isCompressible json/xml substring not false positive" {
    // "json"/"xml" only count as a prefix of the subtype or via +json/+xml suffix
    try testing.expect(!isCompressible("application/notjson")); // does not start with json, no +json
    try testing.expect(isCompressible("application/jsonish")); // starts with "json" -> prefix match true
    try testing.expect(!isCompressible("application/x-json")); // neither prefix nor +json
    try testing.expect(isCompressible("application/vnd.api+json")); // +json suffix present
}

test "round trip ext to compressibility" {
    // end-to-end: resolve a real path, then judge its compressibility
    try testing.expect(isCompressible(lookupPath("/index.html")));
    try testing.expect(isCompressible(lookupPath("/app.js")));
    try testing.expect(isCompressible(lookupPath("/data.json")));
    try testing.expect(isCompressible(lookupPath("/logo.svg")));
    try testing.expect(!isCompressible(lookupPath("/photo.png")));
    try testing.expect(!isCompressible(lookupPath("/movie.mp4")));
    try testing.expect(!isCompressible(lookupPath("/unknown.zzz"))); // default_type -> not compressible
}

test "real extensions spot check" {
    // a broad sweep across categories to lock in the table
    try testing.expectEqualStrings("image/gif", lookupExt("gif"));
    try testing.expectEqualStrings("image/jpeg", lookupExt("jpeg"));
    try testing.expectEqualStrings("image/webp", lookupExt("webp"));
    try testing.expectEqualStrings("image/avif", lookupExt("avif"));
    try testing.expectEqualStrings("font/woff", lookupExt("woff"));
    try testing.expectEqualStrings("font/ttf", lookupExt("ttf"));
    try testing.expectEqualStrings("audio/mpeg", lookupExt("mp3"));
    try testing.expectEqualStrings("audio/ogg", lookupExt("ogg"));
    try testing.expectEqualStrings("video/mp4", lookupExt("mp4"));
    try testing.expectEqualStrings("video/webm", lookupExt("webm"));
    try testing.expectEqualStrings("application/pdf", lookupExt("pdf"));
    try testing.expectEqualStrings("application/zip", lookupExt("zip"));
    try testing.expectEqualStrings("application/gzip", lookupExt("gz"));
    try testing.expectEqualStrings("application/wasm", lookupExt("wasm"));
    try testing.expectEqualStrings("application/vnd.openxmlformats-officedocument.wordprocessingml.document", lookupExt("docx"));
}

test "aliased extensions share type" {
    // distinct keys intentionally resolve to the same MIME string
    try testing.expectEqualStrings(lookupExt("jpg"), lookupExt("jpeg"));
    try testing.expectEqualStrings(lookupExt("htm"), lookupExt("html"));
    try testing.expectEqualStrings(lookupExt("mjs"), lookupExt("js"));
    try testing.expectEqualStrings(lookupExt("tif"), lookupExt("tiff"));
    try testing.expectEqualStrings(lookupExt("mid"), lookupExt("midi"));
    try testing.expectEqualStrings(lookupExt("yml"), lookupExt("yaml"));
}

test "lookupExt rejects ext with leading dot" {
    // caller is expected to pass a bare ext; a leading dot is treated literally and misses
    try testing.expectEqualStrings(default_type, lookupExt(".png"));
    try testing.expectEqualStrings(default_type, lookupExt(".json"));
}

test "lookupExt whitespace and control chars miss" {
    try testing.expectEqualStrings(default_type, lookupExt(" png"));
    try testing.expectEqualStrings(default_type, lookupExt("png "));
    try testing.expectEqualStrings(default_type, lookupExt("p\tng"));
    try testing.expectEqualStrings(default_type, lookupExt("\x00"));
}

test "lookupPath returns pointer into static table" {
    // returned slices are static; same input yields byte-identical, persistent result
    const a = lookupPath("/a.html");
    const b = lookupPath("/b.html");
    try testing.expectEqualStrings(a, b);
    try testing.expectEqual(a.ptr, b.ptr);
}
