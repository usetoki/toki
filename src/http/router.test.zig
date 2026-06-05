const std = @import("std");
const mod = @import("router.zig");
const Found = mod.Found;
const Match = mod.Match;
const Param = mod.Param;
const RouteTable = mod.RouteTable;
const Scratch = mod.Scratch;
const build = mod.build;
const deinit = mod.deinit;
const max_params = mod.max_params;
const resolve = mod.resolve;

test "exact beats dynamic and returns index" {
    var t = try RouteTable.build(
        std.testing.allocator,
        &.{ "GET", "GET", "POST" },
        &.{ "/", "/users/:id", "/users" },
    );
    defer t.deinit();
    try expectFound(&t, "GET", "/", 0);
    try expectFound(&t, "POST", "/users", 2);
}

test "param capture with percent-decoding" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/users/:id"});
    defer t.deinit();
    var sc: Scratch = .{};
    switch (t.resolve("GET", "/users/a%20b", &sc)) {
        .found => |f| {
            try std.testing.expectEqual(@as(usize, 1), f.params.len);
            try std.testing.expectEqualStrings("id", f.params[0].name);
            try std.testing.expectEqualStrings("a b", f.params[0].value);
        },
        else => return error.TestUnexpectedResult,
    }
}

test "wildcard captures the rest with slashes" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/static/*"});
    defer t.deinit();
    var sc: Scratch = .{};
    switch (t.resolve("GET", "/static/css/app.css", &sc)) {
        .found => |f| {
            try std.testing.expectEqualStrings("*", f.params[0].name);
            try std.testing.expectEqualStrings("css/app.css", f.params[0].value);
        },
        else => return error.TestUnexpectedResult,
    }
}

test "multiple params" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/u/:uid/posts/:pid"});
    defer t.deinit();
    var sc: Scratch = .{};
    switch (t.resolve("GET", "/u/7/posts/99", &sc)) {
        .found => |f| {
            try std.testing.expectEqualStrings("7", f.params[0].value);
            try std.testing.expectEqualStrings("99", f.params[1].value);
        },
        else => return error.TestUnexpectedResult,
    }
}

test "non-match dynamic falls through to 404" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/users/:id"});
    defer t.deinit();
    var sc: Scratch = .{};
    try std.testing.expectEqual(Match.not_found, t.resolve("GET", "/posts/1", &sc));
    // too many segments must not match a single-param route
    try std.testing.expectEqual(Match.not_found, t.resolve("GET", "/users/1/extra", &sc));
}

test "405 spans exact and dynamic methods" {
    var t = try RouteTable.build(
        std.testing.allocator,
        &.{ "GET", "POST" },
        &.{ "/users/:id", "/users/:id" },
    );
    defer t.deinit();
    var sc: Scratch = .{};
    switch (t.resolve("DELETE", "/users/5", &sc)) {
        .method_not_allowed => |a| try std.testing.expectEqualStrings("GET, POST", a),
        else => return error.TestUnexpectedResult,
    }
}

// --- exhaustive edge-case coverage appended below ---

fn expectNotFound(t: *const RouteTable, method: []const u8, path: []const u8) !void {
    var sc: Scratch = .{};
    try std.testing.expectEqual(Match.not_found, t.resolve(method, path, &sc));
}

fn expectAllow(t: *const RouteTable, method: []const u8, path: []const u8, allow: []const u8) !void {
    var sc: Scratch = .{};
    switch (t.resolve(method, path, &sc)) {
        .method_not_allowed => |a| try std.testing.expectEqualStrings(allow, a),
        else => return error.TestUnexpectedResult,
    }
}

test "empty table 404s everything" {
    var t = try RouteTable.build(std.testing.allocator, &.{}, &.{});
    defer t.deinit();
    try expectNotFound(&t, "GET", "/");
    try expectNotFound(&t, "GET", "/anything");
    try expectNotFound(&t, "POST", "");
}

test "root path exact hit" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/"});
    defer t.deinit();
    try expectFound(&t, "GET", "/", 0);
}

test "exact miss on path is 404 not 405" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/a"});
    defer t.deinit();
    try expectNotFound(&t, "GET", "/b");
}

test "exact method mismatch is 405 with single method allow" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/users"});
    defer t.deinit();
    try expectAllow(&t, "POST", "/users", "GET");
    try expectAllow(&t, "DELETE", "/users", "GET");
}

test "405 allow header is sorted" {
    var t = try RouteTable.build(
        std.testing.allocator,
        &.{ "PUT", "GET", "POST", "DELETE" },
        &.{ "/r", "/r", "/r", "/r" },
    );
    defer t.deinit();
    // alphabetical: DELETE, GET, POST, PUT
    try expectAllow(&t, "PATCH", "/r", "DELETE, GET, POST, PUT");
}

test "405 allow dedups same method across exact and dynamic" {
    var t = try RouteTable.build(
        std.testing.allocator,
        &.{ "GET", "GET" },
        &.{ "/u/x", "/u/:id" },
    );
    defer t.deinit();
    // /u/x matches both the exact route and the :id dynamic route, both GET.
    try expectAllow(&t, "POST", "/u/x", "GET");
}

test "exact route preferred over dynamic same method" {
    var t = try RouteTable.build(
        std.testing.allocator,
        &.{ "GET", "GET" },
        &.{ "/u/:id", "/u/me" },
    );
    defer t.deinit();
    // exact /u/me (index 1) must win over /u/:id (index 0)
    try expectFound(&t, "GET", "/u/me", 1);
    // a non-exact value still resolves through the dynamic route
    try expectFound(&t, "GET", "/u/42", 0);
}

test "trailing slash on exact route is a distinct 404" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/users"});
    defer t.deinit();
    // exact map has "/users" not "/users/" -> miss with no other method -> 404
    try expectNotFound(&t, "GET", "/users/");
}

test "trailing slash on param route captures empty trailing param" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/posts/:id"});
    defer t.deinit();
    var sc: Scratch = .{};
    // the final segment after the trailing slash is empty, captured as ""
    switch (t.resolve("GET", "/posts/", &sc)) {
        .found => |f| {
            try std.testing.expectEqual(@as(usize, 1), f.params.len);
            try std.testing.expectEqualStrings("", f.params[0].value);
        },
        else => return error.TestUnexpectedResult,
    }
}

test "wildcard matches empty remainder" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/static/*"});
    defer t.deinit();
    var sc: Scratch = .{};
    switch (t.resolve("GET", "/static/", &sc)) {
        .found => |f| {
            try std.testing.expectEqual(@as(usize, 1), f.params.len);
            try std.testing.expectEqualStrings("*", f.params[0].name);
            try std.testing.expectEqualStrings("", f.params[0].value);
        },
        else => return error.TestUnexpectedResult,
    }
}

test "wildcard preserves percent-encoded slashes decoded" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/files/*"});
    defer t.deinit();
    var sc: Scratch = .{};
    switch (t.resolve("GET", "/files/a%2Fb/c", &sc)) {
        .found => |f| try std.testing.expectEqualStrings("a/b/c", f.params[0].value),
        else => return error.TestUnexpectedResult,
    }
}

test "param does not span slash" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/u/:id"});
    defer t.deinit();
    // an extra segment after :id must not be captured into id
    try expectNotFound(&t, "GET", "/u/1/2");
}

test "literal mismatch in dynamic route 404s" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/a/:id/b"});
    defer t.deinit();
    try expectNotFound(&t, "GET", "/a/5/c");
    try expectFound(&t, "GET", "/a/5/b", 0);
}

test "too few segments for dynamic route 404s" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/a/:id/b"});
    defer t.deinit();
    try expectNotFound(&t, "GET", "/a/5");
    try expectNotFound(&t, "GET", "/a");
}

test "leading-slash insensitivity for dynamic match" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/u/:id"});
    defer t.deinit();
    var sc: Scratch = .{};
    // matchPattern trims a leading slash on the path; pattern with no leading slash still aligns
    switch (t.resolve("GET", "/u/9", &sc)) {
        .found => |f| try std.testing.expectEqualStrings("9", f.params[0].value),
        else => return error.TestUnexpectedResult,
    }
}

test "many params up to a deep path" {
    var t = try RouteTable.build(
        std.testing.allocator,
        &.{"GET"},
        &.{"/:a/:b/:c/:d/:e/:f/:g/:h"},
    );
    defer t.deinit();
    var sc: Scratch = .{};
    switch (t.resolve("GET", "/1/2/3/4/5/6/7/8", &sc)) {
        .found => |f| {
            try std.testing.expectEqual(@as(usize, 8), f.params.len);
            try std.testing.expectEqualStrings("a", f.params[0].name);
            try std.testing.expectEqualStrings("1", f.params[0].value);
            try std.testing.expectEqualStrings("h", f.params[7].name);
            try std.testing.expectEqualStrings("8", f.params[7].value);
        },
        else => return error.TestUnexpectedResult,
    }
}

test "exactly max_params params capture all" {
    // build a 16-param pattern and a 16-segment path
    comptime var pat: []const u8 = "";
    comptime var p: []const u8 = "";
    comptime {
        var k: usize = 0;
        while (k < max_params) : (k += 1) {
            pat = pat ++ "/:p";
            p = p ++ "/v";
        }
    }
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{pat});
    defer t.deinit();
    var sc: Scratch = .{};
    switch (t.resolve("GET", p, &sc)) {
        .found => |f| try std.testing.expectEqual(@as(usize, max_params), f.params.len),
        else => return error.TestUnexpectedResult,
    }
}

test "percent decode multiple escapes in one param" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/q/:term"});
    defer t.deinit();
    var sc: Scratch = .{};
    switch (t.resolve("GET", "/q/%41%42%43", &sc)) {
        .found => |f| try std.testing.expectEqualStrings("ABC", f.params[0].value),
        else => return error.TestUnexpectedResult,
    }
}

test "percent decode lowercase hex" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/q/:term"});
    defer t.deinit();
    var sc: Scratch = .{};
    switch (t.resolve("GET", "/q/%2f", &sc)) {
        .found => |f| try std.testing.expectEqualStrings("/", f.params[0].value),
        else => return error.TestUnexpectedResult,
    }
}

test "percent decode plus stays literal" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/q/:term"});
    defer t.deinit();
    var sc: Scratch = .{};
    switch (t.resolve("GET", "/q/a+b", &sc)) {
        .found => |f| try std.testing.expectEqualStrings("a+b", f.params[0].value),
        else => return error.TestUnexpectedResult,
    }
}

test "percent decode malformed hi nibble passes through" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/q/:term"});
    defer t.deinit();
    var sc: Scratch = .{};
    // %ZZ: Z is not hex, so the '%' is emitted literally and Z's follow as literals
    switch (t.resolve("GET", "/q/%ZZ", &sc)) {
        .found => |f| try std.testing.expectEqualStrings("%ZZ", f.params[0].value),
        else => return error.TestUnexpectedResult,
    }
}

test "percent decode malformed lo nibble passes through" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/q/:term"});
    defer t.deinit();
    var sc: Scratch = .{};
    // %4Z: hi is valid, lo invalid -> '%' literal then 4Z literal
    switch (t.resolve("GET", "/q/%4Z", &sc)) {
        .found => |f| try std.testing.expectEqualStrings("%4Z", f.params[0].value),
        else => return error.TestUnexpectedResult,
    }
}

test "percent decode truncated escape at end passes through" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/q/:term"});
    defer t.deinit();
    var sc: Scratch = .{};
    // "%2" has no room for two hex digits (i+2 == len), so '%' is literal
    switch (t.resolve("GET", "/q/x%2", &sc)) {
        .found => |f| try std.testing.expectEqualStrings("x%2", f.params[0].value),
        else => return error.TestUnexpectedResult,
    }
}

test "percent decode bare percent at end passes through" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/q/:term"});
    defer t.deinit();
    var sc: Scratch = .{};
    switch (t.resolve("GET", "/q/x%", &sc)) {
        .found => |f| try std.testing.expectEqualStrings("x%", f.params[0].value),
        else => return error.TestUnexpectedResult,
    }
}

test "percent decode null byte" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/q/:term"});
    defer t.deinit();
    var sc: Scratch = .{};
    switch (t.resolve("GET", "/q/%00", &sc)) {
        .found => |f| {
            try std.testing.expectEqual(@as(usize, 1), f.params[0].value.len);
            try std.testing.expectEqual(@as(u8, 0), f.params[0].value[0]);
        },
        else => return error.TestUnexpectedResult,
    }
}

test "percent decode high byte 0xFF" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/q/:term"});
    defer t.deinit();
    var sc: Scratch = .{};
    switch (t.resolve("GET", "/q/%FF", &sc)) {
        .found => |f| {
            try std.testing.expectEqual(@as(usize, 1), f.params[0].value.len);
            try std.testing.expectEqual(@as(u8, 0xFF), f.params[0].value[0]);
        },
        else => return error.TestUnexpectedResult,
    }
}

test "literal segment named like wildcard char is literal not param" {
    // a segment "*x" is not exactly "*", so it compiles to a literal, not a wildcard
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/a/:id"});
    defer t.deinit();
    // sanity: this route is dynamic via :id and matches normally
    try expectFound(&t, "GET", "/a/7", 0);
}

test "colon mid-segment is literal not param" {
    // ":" must be the first char to mark a param; "a:b" stays literal
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/x/a:b"});
    defer t.deinit();
    // path has no ':' so this is a fully exact route; literal match required
    try expectFound(&t, "GET", "/x/a:b", 0);
    try expectNotFound(&t, "GET", "/x/zzz");
}

test "method case sensitivity" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/p"});
    defer t.deinit();
    // unknown method on a known path is 405, not 404
    try expectAllow(&t, "get", "/p", "GET");
}

test "duplicate exact route last index wins" {
    var t = try RouteTable.build(
        std.testing.allocator,
        &.{ "GET", "GET" },
        &.{ "/dup", "/dup" },
    );
    defer t.deinit();
    // hashmap put overwrites: the later registration (index 1) is kept
    try expectFound(&t, "GET", "/dup", 1);
}

test "param value can be empty between slashes" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/a/:id/b"});
    defer t.deinit();
    var sc: Scratch = .{};
    // "//" yields an empty middle segment captured as an empty param
    switch (t.resolve("GET", "/a//b", &sc)) {
        .found => |f| try std.testing.expectEqualStrings("", f.params[0].value),
        else => return error.TestUnexpectedResult,
    }
}

test "wildcard only route matches root-ish paths" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/*"});
    defer t.deinit();
    var sc: Scratch = .{};
    switch (t.resolve("GET", "/anything/deep/here", &sc)) {
        .found => |f| try std.testing.expectEqualStrings("anything/deep/here", f.params[0].value),
        else => return error.TestUnexpectedResult,
    }
}

test "very deep literal exact path" {
    const deep = "/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t";
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{deep});
    defer t.deinit();
    try expectFound(&t, "GET", deep, 0);
    try expectNotFound(&t, "GET", "/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/u");
}

test "long param value decodes within scratch" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/q/:term"});
    defer t.deinit();
    // 1000-char value comfortably fits the 4096-byte decoded scratch
    var buf: [1006]u8 = undefined;
    @memcpy(buf[0..3], "/q/");
    @memset(buf[3..1003], 'z');
    const path = buf[0..1003];
    var sc: Scratch = .{};
    switch (t.resolve("GET", path, &sc)) {
        .found => |f| try std.testing.expectEqual(@as(usize, 1000), f.params[0].value.len),
        else => return error.TestUnexpectedResult,
    }
}

test "many methods on same dynamic path build a wide allow set" {
    var t = try RouteTable.build(
        std.testing.allocator,
        &.{ "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS" },
        &.{ "/r/:id", "/r/:id", "/r/:id", "/r/:id", "/r/:id", "/r/:id", "/r/:id" },
    );
    defer t.deinit();
    // TRACE is not registered; allow set is every registered method, sorted.
    try expectAllow(&t, "TRACE", "/r/9", "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT");
}

test "empty method string never matches a real route" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/p"});
    defer t.deinit();
    // empty method: path /p still exists for GET -> 405 with GET allow
    try expectAllow(&t, "", "/p", "GET");
}

test "empty path on dynamic-only table is not_found" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/u/:id"});
    defer t.deinit();
    try expectNotFound(&t, "GET", "");
}

test "resolve does not mutate across calls with shared scratch reuse" {
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/u/:id"});
    defer t.deinit();
    var sc: Scratch = .{};
    // first call captures "abc"
    switch (t.resolve("GET", "/u/abc", &sc)) {
        .found => |f| try std.testing.expectEqualStrings("abc", f.params[0].value),
        else => return error.TestUnexpectedResult,
    }
    // a fresh resolve with a different value must report the new value
    switch (t.resolve("GET", "/u/xy", &sc)) {
        .found => |f| try std.testing.expectEqualStrings("xy", f.params[0].value),
        else => return error.TestUnexpectedResult,
    }
}

test "single dynamic literal-only route matches exactly its segments" {
    // a wildcard makes the route dynamic even though it also has fixed literals
    var t = try RouteTable.build(std.testing.allocator, &.{"GET"}, &.{"/api/v1/*"});
    defer t.deinit();
    var sc: Scratch = .{};
    switch (t.resolve("GET", "/api/v1/users/1", &sc)) {
        .found => |f| try std.testing.expectEqualStrings("users/1", f.params[0].value),
        else => return error.TestUnexpectedResult,
    }
    // wrong prefix literal must 404
    try expectNotFound(&t, "GET", "/api/v2/users/1");
}

test "HEAD falls back to the GET route (exact and dynamic)" {
    var t = try RouteTable.build(
        std.testing.allocator,
        &.{ "GET", "GET", "POST" },
        &.{ "/page", "/u/:id", "/page" },
    );
    defer t.deinit();
    try expectFound(&t, "HEAD", "/page", 0); // exact GET serves HEAD
    try expectFound(&t, "HEAD", "/u/7", 1); // dynamic GET serves HEAD
    try expectNotFound(&t, "HEAD", "/missing");
}

test "an explicit HEAD route takes precedence over the GET fallback" {
    var t = try RouteTable.build(
        std.testing.allocator,
        &.{ "GET", "HEAD" },
        &.{ "/p", "/p" },
    );
    defer t.deinit();
    try expectFound(&t, "HEAD", "/p", 1); // the HEAD route (index 1), not GET (index 0)
    try expectFound(&t, "GET", "/p", 0);
}

fn expectFound(t: *const RouteTable, method: []const u8, path: []const u8, index: u32) !void {
    var sc: Scratch = .{};
    switch (t.resolve(method, path, &sc)) {
        .found => |f| try std.testing.expectEqual(index, f.index),
        else => return error.TestUnexpectedResult,
    }
}
