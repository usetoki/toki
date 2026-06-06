//! Route table: exact matches (method→path→index map, the hot path) plus dynamic
//! `:param`/`*` patterns scanned only on an exact miss. Miss probes every method
//! to decide 404 vs 405.

const std = @import("std");

pub const max_params = 16;

pub const Param = struct {
    name: []const u8,
    value: []const u8,
};

/// params slice into the caller's scratch, valid only for the handler turn.
pub const Found = struct {
    index: u32,
    params: []const Param,
};

pub const Match = union(enum) {
    found: Found,
    not_found,
    /// `Allow` header value, written into the caller's scratch.
    method_not_allowed: []const u8,
};

/// Caller owns this on the stack across a resolve; holds Allow value, params,
/// and their percent-decoded values.
pub const Scratch = struct {
    allow: [256]u8 = undefined,
    params: [max_params]Param = undefined,
    decoded: [4096]u8 = undefined,
};

const Segment = union(enum) {
    literal: []const u8,
    param: []const u8, // capture name
    wildcard: []const u8, // capture name; matches rest of path incl. slashes
};

const DynamicRoute = struct {
    method: []const u8,
    segments: []const Segment,
    index: u32,
};

pub const RouteTable = struct {
    arena: std.heap.ArenaAllocator,
    /// method → (path → handler index) for exact routes.
    exact: std.StringHashMapUnmanaged(std.StringHashMapUnmanaged(u32)),
    /// Compiled `:param`/`*` routes, scanned on an exact miss.
    dynamic: []const DynamicRoute,

    pub fn build(gpa: std.mem.Allocator, methods: []const []const u8, paths: []const []const u8) !RouteTable {
        std.debug.assert(methods.len == paths.len);
        var table: RouteTable = .{
            .arena = std.heap.ArenaAllocator.init(gpa),
            .exact = .empty,
            .dynamic = &.{},
        };
        const a = table.arena.allocator();
        var dynamic: std.ArrayListUnmanaged(DynamicRoute) = .empty;

        for (methods, paths, 0..) |method, path, i| {
            const m = try a.dupe(u8, method);
            if (try compile(a, path)) |segments| {
                try dynamic.append(a, .{ .method = m, .segments = segments, .index = @intCast(i) });
            } else {
                const gop = try table.exact.getOrPut(a, m);
                if (!gop.found_existing) gop.value_ptr.* = .empty;
                try gop.value_ptr.put(a, try a.dupe(u8, path), @intCast(i));
            }
        }
        table.dynamic = try dynamic.toOwnedSlice(a);
        return table;
    }

    pub fn deinit(self: *RouteTable) void {
        self.arena.deinit();
    }

    pub fn resolve(self: *const RouteTable, method: []const u8, path: []const u8, sc: *Scratch) Match {
        if (self.lookup(method, path, sc)) |f| return .{ .found = f };
        // a HEAD with no HEAD route is served by the GET handler; the engine drops the
        // body on the wire but keeps the computed Content-Length
        if (std.mem.eql(u8, method, "HEAD")) {
            if (self.lookup("GET", path, sc)) |f| return .{ .found = f };
        }
        return self.resolveMiss(path, sc);
    }

    fn lookup(self: *const RouteTable, method: []const u8, path: []const u8, sc: *Scratch) ?Found {
        if (self.exact.get(method)) |paths| {
            if (paths.get(path)) |index| return .{ .index = index, .params = &.{} };
        }
        for (self.dynamic) |route| {
            if (!std.mem.eql(u8, route.method, method)) continue;
            if (matchPattern(route.segments, path, sc)) |params| {
                return .{ .index = route.index, .params = params };
            }
        }
        return null;
    }

    /// Cold path: collect every method that would serve `path` to decide 404 vs 405.
    fn resolveMiss(self: *const RouteTable, path: []const u8, sc: *Scratch) Match {
        var allowed: [16][]const u8 = undefined;
        var n: usize = 0;

        var it = self.exact.iterator();
        while (it.next()) |entry| {
            if (entry.value_ptr.get(path) != null) n = pushUnique(&allowed, n, entry.key_ptr.*);
        }
        for (self.dynamic) |route| {
            // a trailing `*` catch-all is a fallback, not a precise resource — it must not
            // advertise its method for 405 (else e.g. `OPTIONS /*` from cors() turns every
            // unmatched GET into a 405 and shadows the static-file / not-found fallback).
            if (endsWithWildcard(route.segments)) continue;
            if (matchPattern(route.segments, path, sc) != null) n = pushUnique(&allowed, n, route.method);
        }
        if (n == 0) return .not_found;

        std.mem.sort([]const u8, allowed[0..n], {}, lessThanStr);
        var w: usize = 0;
        for (allowed[0..n], 0..) |m, i| {
            if (i != 0) {
                @memcpy(sc.allow[w..][0..2], ", ");
                w += 2;
            }
            @memcpy(sc.allow[w..][0..m.len], m);
            w += m.len;
        }
        return .{ .method_not_allowed = sc.allow[0..w] };
    }
};

// null when path has no `:param`/`*` (caller routes those to the exact map).
// segments are arena-owned.
fn compile(a: std.mem.Allocator, path: []const u8) !?[]const Segment {
    if (!isDynamic(path)) return null;
    var segments: std.ArrayListUnmanaged(Segment) = .empty;
    var it = std.mem.splitScalar(u8, std.mem.trimStart(u8, path, "/"), '/');
    while (it.next()) |part| {
        if (part.len > 0 and part[0] == ':') {
            try segments.append(a, .{ .param = try a.dupe(u8, part[1..]) });
        } else if (std.mem.eql(u8, part, "*")) {
            try segments.append(a, .{ .wildcard = "*" });
        } else {
            try segments.append(a, .{ .literal = try a.dupe(u8, part) });
        }
    }
    return try segments.toOwnedSlice(a);
}

fn isDynamic(path: []const u8) bool {
    var it = std.mem.splitScalar(u8, path, '/');
    while (it.next()) |part| {
        if (part.len > 0 and part[0] == ':') return true;
        if (std.mem.eql(u8, part, "*")) return true;
    }
    return false;
}

fn matchPattern(segments: []const Segment, path: []const u8, sc: *Scratch) ?[]const Param {
    const p = std.mem.trimStart(u8, path, "/");
    var off: usize = 0;
    var n: usize = 0;
    var decoded: usize = 0;

    for (segments) |segment| {
        switch (segment) {
            .wildcard => |name| {
                // off can sit one past the end when the prefix matched with no trailing
                // slash (GET /static vs /static/*) — clamp to an empty tail, never slice OOB.
                const tail = p[@min(off, p.len)..];
                const value = percentDecode(tail, sc.decoded[decoded..]);
                if (n >= max_params) return null;
                sc.params[n] = .{ .name = name, .value = value };
                return sc.params[0 .. n + 1];
            },
            else => {
                if (off > p.len) return null;
                const end = std.mem.indexOfScalarPos(u8, p, off, '/') orelse p.len;
                const part = p[off..end];
                switch (segment) {
                    .literal => |lit| if (!std.mem.eql(u8, part, lit)) return null,
                    .param => |name| {
                        if (n >= max_params) return null;
                        const value = percentDecode(part, sc.decoded[decoded..]);
                        decoded += value.len;
                        sc.params[n] = .{ .name = name, .value = value };
                        n += 1;
                    },
                    .wildcard => unreachable,
                }
                off = end + 1;
            },
        }
    }
    // reject leftover path: off must have advanced past the end, not just to it.
    if (off <= p.len) return null;
    return sc.params[0..n];
}

// decodes %XX into dest; `+` stays literal, malformed escapes pass through.
fn percentDecode(src: []const u8, dest: []u8) []const u8 {
    var w: usize = 0;
    var i: usize = 0;
    while (i < src.len and w < dest.len) {
        if (src[i] == '%' and i + 2 < src.len) {
            const hi = std.fmt.charToDigit(src[i + 1], 16) catch {
                dest[w] = src[i];
                w += 1;
                i += 1;
                continue;
            };
            const lo = std.fmt.charToDigit(src[i + 2], 16) catch {
                dest[w] = src[i];
                w += 1;
                i += 1;
                continue;
            };
            dest[w] = @as(u8, hi) * 16 + lo;
            w += 1;
            i += 3;
        } else {
            dest[w] = src[i];
            w += 1;
            i += 1;
        }
    }
    return dest[0..w];
}

fn endsWithWildcard(segments: []const Segment) bool {
    return segments.len > 0 and segments[segments.len - 1] == .wildcard;
}

fn pushUnique(list: *[16][]const u8, n: usize, value: []const u8) usize {
    if (n >= list.len) return n;
    for (list[0..n]) |existing| {
        if (std.mem.eql(u8, existing, value)) return n;
    }
    list[n] = value;
    return n + 1;
}

fn lessThanStr(_: void, a: []const u8, b: []const u8) bool {
    return std.mem.lessThan(u8, a, b);
}
