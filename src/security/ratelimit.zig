//! native fixed-window rate limiter keyed by peer IP. runs in the engine before
//! a request reaches JS, so floods get a native 429 off the dispatch path.
//! disabled by default (max == 0) so the hot path pays nothing when off.

const std = @import("std");

const Bucket = struct { count: u32, window_start: u64 }; // window_start in loop ms

/// max requests per window; 0 disables the limiter. set from listen options.
pub var max: u32 = 0;
pub var window_ms: u64 = 0;

pub var table: std.StringHashMapUnmanaged(Bucket) = .empty;
var gpa: std.mem.Allocator = undefined;

pub fn init(allocator: std.mem.Allocator) void {
    gpa = allocator;
}

pub inline fn enabled() bool {
    return max > 0;
}

/// true when `ip` is over the limit. fails open on alloc failure; a rate
/// limiter must never take the server down.
pub fn exceeded(ip: []const u8, now: u64) bool {
    const gop = table.getOrPut(gpa, ip) catch return false;
    if (!gop.found_existing) {
        // getOrPut stored the borrowed `ip` as the key; own a copy or back the slot out
        // by that same key (not the borrowed slice) so nothing dangles.
        const stored_key = gop.key_ptr.*;
        const key = gpa.dupe(u8, ip) catch {
            _ = table.remove(stored_key);
            return false;
        };
        gop.key_ptr.* = key;
        gop.value_ptr.* = .{ .count = 1, .window_start = now };
        return false;
    }
    const bucket = gop.value_ptr;
    if (now - bucket.window_start >= window_ms) {
        bucket.* = .{ .count = 1, .window_start = now };
        return false;
    }
    if (bucket.count >= max) return true;
    bucket.count += 1;
    return false;
}

/// whole seconds until `ip`'s window resets, for the Retry-After header.
pub fn retryAfterSeconds(ip: []const u8, now: u64) u64 {
    const bucket = table.get(ip) orelse return 0;
    const elapsed = now - bucket.window_start;
    if (elapsed >= window_ms) return 0;
    return (window_ms - elapsed + 999) / 1000;
}

/// drops buckets whose window has elapsed; periodic sweep so idle clients don't
/// accumulate.
pub fn sweep(now: u64) void {
    if (!enabled() or table.count() == 0) return;
    var expired: std.ArrayListUnmanaged([]const u8) = .empty;
    defer expired.deinit(gpa);
    var it = table.iterator();
    while (it.next()) |entry| {
        if (now - entry.value_ptr.window_start >= window_ms) {
            expired.append(gpa, entry.key_ptr.*) catch break;
        }
    }
    for (expired.items) |key| {
        if (table.fetchRemove(key)) |kv| gpa.free(kv.key);
    }
}

/// frees every bucket and disables the limiter (shutdown / reuse).
pub fn reset() void {
    var it = table.iterator();
    while (it.next()) |entry| gpa.free(entry.key_ptr.*);
    table.clearAndFree(gpa);
    max = 0;
    window_ms = 0;
}
