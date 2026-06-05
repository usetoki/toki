//! native fixed-window rate limiter keyed by peer IP. runs in the engine before
//! a request reaches JS, so floods get a native 429 off the dispatch path.
//! disabled by default (max == 0) so the hot path pays nothing when off.

const std = @import("std");

const Bucket = struct { count: u32, window_start: u64 }; // window_start in loop ms

/// max requests per window; 0 disables the limiter. set from listen options.
pub var max: u32 = 0;
pub var window_ms: u64 = 0;

var table: std.StringHashMapUnmanaged(Bucket) = .empty;
var gpa: std.mem.Allocator = undefined;

pub fn init(allocator: std.mem.Allocator) void {
    gpa = allocator;
}

pub inline fn enabled() bool {
    return max > 0;
}

/// true when `ip` is over the limit. fails open on alloc failure — a rate
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

test "fixed window allows up to max then rejects" {
    init(std.testing.allocator);
    defer reset();
    max = 3;
    window_ms = 1000;
    try std.testing.expect(!exceeded("1.2.3.4", 0));
    try std.testing.expect(!exceeded("1.2.3.4", 10));
    try std.testing.expect(!exceeded("1.2.3.4", 20));
    try std.testing.expect(exceeded("1.2.3.4", 30)); // 4th in window → rejected
    try std.testing.expect(exceeded("1.2.3.4", 40));
}

test "window resets after it elapses" {
    init(std.testing.allocator);
    defer reset();
    max = 1;
    window_ms = 1000;
    try std.testing.expect(!exceeded("9.9.9.9", 0));
    try std.testing.expect(exceeded("9.9.9.9", 500)); // still in window
    try std.testing.expect(!exceeded("9.9.9.9", 1000)); // new window
}

test "separate ips have separate buckets" {
    init(std.testing.allocator);
    defer reset();
    max = 1;
    window_ms = 1000;
    try std.testing.expect(!exceeded("1.1.1.1", 0));
    try std.testing.expect(!exceeded("2.2.2.2", 0));
    try std.testing.expect(exceeded("1.1.1.1", 1));
}

test "sweep removes elapsed buckets" {
    init(std.testing.allocator);
    defer reset();
    max = 5;
    window_ms = 1000;
    _ = exceeded("3.3.3.3", 0);
    try std.testing.expectEqual(@as(u32, 1), table.count());
    sweep(2000);
    try std.testing.expectEqual(@as(u32, 0), table.count());
}

test "retry-after counts down within the window" {
    init(std.testing.allocator);
    defer reset();
    max = 1;
    window_ms = 1000;
    _ = exceeded("4.4.4.4", 0);
    try std.testing.expectEqual(@as(u64, 1), retryAfterSeconds("4.4.4.4", 200));
    try std.testing.expectEqual(@as(u64, 0), retryAfterSeconds("4.4.4.4", 1000));
}

test "enabled tracks max" {
    init(std.testing.allocator);
    defer reset();
    max = 0;
    try std.testing.expect(!enabled());
    max = 1;
    try std.testing.expect(enabled());
    max = 1_000_000;
    try std.testing.expect(enabled());
}

test "reset frees buckets and disables" {
    init(std.testing.allocator);
    max = 5;
    window_ms = 1000;
    _ = exceeded("5.5.5.5", 0);
    _ = exceeded("6.6.6.6", 0);
    try std.testing.expectEqual(@as(u32, 2), table.count());
    reset();
    // limiter disabled and every bucket freed (testing.allocator catches leaks)
    try std.testing.expectEqual(@as(u32, 0), table.count());
    try std.testing.expectEqual(@as(u32, 0), max);
    try std.testing.expectEqual(@as(u64, 0), window_ms);
    try std.testing.expect(!enabled());
}

test "reset is idempotent on empty table" {
    init(std.testing.allocator);
    reset();
    reset();
    try std.testing.expectEqual(@as(u32, 0), table.count());
    try std.testing.expect(!enabled());
}

test "max of one rejects the second request immediately" {
    init(std.testing.allocator);
    defer reset();
    max = 1;
    window_ms = 1000;
    try std.testing.expect(!exceeded("7.7.7.7", 0));
    try std.testing.expect(exceeded("7.7.7.7", 0)); // same instant, 2nd request
}

test "boundary at exactly window_ms opens a fresh window" {
    init(std.testing.allocator);
    defer reset();
    max = 2;
    window_ms = 1000;
    try std.testing.expect(!exceeded("8.8.8.8", 0));
    try std.testing.expect(!exceeded("8.8.8.8", 999)); // count 2, still in window
    try std.testing.expect(exceeded("8.8.8.8", 999)); // count would be 3 → rejected
    try std.testing.expect(!exceeded("8.8.8.8", 1000)); // elapsed == window_ms → reset
    try std.testing.expect(!exceeded("8.8.8.8", 1000)); // count 2 again
    try std.testing.expect(exceeded("8.8.8.8", 1000));
}

test "one ms before boundary still rejects" {
    init(std.testing.allocator);
    defer reset();
    max = 1;
    window_ms = 1000;
    try std.testing.expect(!exceeded("10.0.0.1", 100));
    try std.testing.expect(exceeded("10.0.0.1", 1099)); // elapsed 999 < 1000
    try std.testing.expect(!exceeded("10.0.0.1", 1100)); // elapsed 1000 → new window
}

test "rejected request does not bump the count" {
    init(std.testing.allocator);
    defer reset();
    max = 1;
    window_ms = 1000;
    try std.testing.expect(!exceeded("11.1.1.1", 0));
    try std.testing.expect(exceeded("11.1.1.1", 10));
    try std.testing.expect(exceeded("11.1.1.1", 20));
    // window resets cleanly; count was held at max, not inflated
    try std.testing.expect(!exceeded("11.1.1.1", 1000));
}

test "empty ip string is a valid distinct key" {
    init(std.testing.allocator);
    defer reset();
    max = 1;
    window_ms = 1000;
    try std.testing.expect(!exceeded("", 0));
    try std.testing.expect(exceeded("", 0)); // empty key has its own bucket
    try std.testing.expect(!exceeded("x", 0)); // unrelated key unaffected
    try std.testing.expectEqual(@as(u32, 2), table.count());
}

test "key is copied so caller buffer may be mutated after" {
    init(std.testing.allocator);
    defer reset();
    max = 2;
    window_ms = 1000;
    var buf: [16]u8 = undefined;
    const ip = "192.168.0.1";
    @memcpy(buf[0..ip.len], ip);
    try std.testing.expect(!exceeded(buf[0..ip.len], 0));
    // scribble over the caller's buffer; the stored key must be an owned copy
    @memset(buf[0..ip.len], 'Z');
    try std.testing.expect(!exceeded(ip, 1)); // same logical key still found
    try std.testing.expectEqual(@as(u32, 1), table.count());
    try std.testing.expect(exceeded(ip, 2)); // 3rd in window
}

test "long ipv6-ish key works" {
    init(std.testing.allocator);
    defer reset();
    max = 1;
    window_ms = 1000;
    const ip = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";
    try std.testing.expect(!exceeded(ip, 0));
    try std.testing.expect(exceeded(ip, 0));
}

test "retryAfterSeconds is zero for unknown ip" {
    init(std.testing.allocator);
    defer reset();
    max = 1;
    window_ms = 1000;
    try std.testing.expectEqual(@as(u64, 0), retryAfterSeconds("never.seen", 0));
}

test "retryAfterSeconds ceils partial seconds" {
    init(std.testing.allocator);
    defer reset();
    max = 1;
    window_ms = 1000;
    _ = exceeded("12.1.1.1", 0);
    // 1ms in: 999ms remain → ceil(0.999) == 1
    try std.testing.expectEqual(@as(u64, 1), retryAfterSeconds("12.1.1.1", 1));
    // 1ms before reset: 1ms remains → ceil(0.001) == 1
    try std.testing.expectEqual(@as(u64, 1), retryAfterSeconds("12.1.1.1", 999));
    // exactly at reset boundary: 0 remain
    try std.testing.expectEqual(@as(u64, 0), retryAfterSeconds("12.1.1.1", 1000));
}

test "retryAfterSeconds rounds multi-second windows up" {
    init(std.testing.allocator);
    defer reset();
    max = 1;
    window_ms = 5000;
    _ = exceeded("13.1.1.1", 0);
    try std.testing.expectEqual(@as(u64, 5), retryAfterSeconds("13.1.1.1", 0));
    try std.testing.expectEqual(@as(u64, 4), retryAfterSeconds("13.1.1.1", 1000));
    try std.testing.expectEqual(@as(u64, 1), retryAfterSeconds("13.1.1.1", 4001));
    try std.testing.expectEqual(@as(u64, 0), retryAfterSeconds("13.1.1.1", 5000));
}

test "retryAfterSeconds past window returns zero" {
    init(std.testing.allocator);
    defer reset();
    max = 1;
    window_ms = 1000;
    _ = exceeded("14.1.1.1", 0);
    try std.testing.expectEqual(@as(u64, 0), retryAfterSeconds("14.1.1.1", 9999));
}

test "sweep is a no-op when disabled" {
    init(std.testing.allocator);
    defer reset();
    max = 0; // disabled
    window_ms = 1000;
    // populate directly to prove sweep leaves a disabled table untouched
    const key = try std.testing.allocator.dupe(u8, "15.1.1.1");
    try table.put(std.testing.allocator, key, .{ .count = 1, .window_start = 0 });
    sweep(1_000_000); // would expire the bucket if it ran
    try std.testing.expectEqual(@as(u32, 1), table.count());
}

test "sweep on empty table is safe" {
    init(std.testing.allocator);
    defer reset();
    max = 5;
    window_ms = 1000;
    sweep(0);
    sweep(1_000_000);
    try std.testing.expectEqual(@as(u32, 0), table.count());
}

test "sweep keeps live buckets and drops only expired" {
    init(std.testing.allocator);
    defer reset();
    max = 5;
    window_ms = 1000;
    _ = exceeded("16.0.0.1", 0); // will be expired by now=1500
    _ = exceeded("16.0.0.2", 1000); // still live at now=1500
    try std.testing.expectEqual(@as(u32, 2), table.count());
    sweep(1500);
    try std.testing.expectEqual(@as(u32, 1), table.count());
    // the surviving bucket is the live one and keeps its state
    try std.testing.expect(table.contains("16.0.0.2"));
    try std.testing.expect(!table.contains("16.0.0.1"));
}

test "sweep boundary expires at exactly window_ms" {
    init(std.testing.allocator);
    defer reset();
    max = 5;
    window_ms = 1000;
    _ = exceeded("17.1.1.1", 0);
    sweep(999); // elapsed 999 < 1000 → kept
    try std.testing.expectEqual(@as(u32, 1), table.count());
    sweep(1000); // elapsed == 1000 → removed
    try std.testing.expectEqual(@as(u32, 0), table.count());
}

test "reusing an ip after sweep starts a clean window" {
    init(std.testing.allocator);
    defer reset();
    max = 1;
    window_ms = 1000;
    try std.testing.expect(!exceeded("18.1.1.1", 0));
    try std.testing.expect(exceeded("18.1.1.1", 10));
    sweep(2000); // bucket dropped
    try std.testing.expectEqual(@as(u32, 0), table.count());
    try std.testing.expect(!exceeded("18.1.1.1", 2001)); // fresh bucket, allowed again
}

test "max u32 boundary never rejects in practice" {
    init(std.testing.allocator);
    defer reset();
    max = std.math.maxInt(u32);
    window_ms = 1000;
    var i: u32 = 0;
    while (i < 1000) : (i += 1) {
        try std.testing.expect(!exceeded("19.1.1.1", 0));
    }
    try std.testing.expectEqual(@as(u32, 1000), table.get("19.1.1.1").?.count);
}

test "zero window allows every request" {
    init(std.testing.allocator);
    defer reset();
    max = 1;
    window_ms = 0; // elapsed >= 0 is always true → bucket resets every call
    try std.testing.expect(!exceeded("20.1.1.1", 0));
    try std.testing.expect(!exceeded("20.1.1.1", 0));
    try std.testing.expect(!exceeded("20.1.1.1", 5));
    // count never climbs past 1 because each call opens a new window
    try std.testing.expectEqual(@as(u32, 1), table.get("20.1.1.1").?.count);
}

test "zero window makes retryAfter zero" {
    init(std.testing.allocator);
    defer reset();
    max = 1;
    window_ms = 0;
    _ = exceeded("21.1.1.1", 0);
    try std.testing.expectEqual(@as(u64, 0), retryAfterSeconds("21.1.1.1", 0));
}

test "large now timestamp does not overflow" {
    init(std.testing.allocator);
    defer reset();
    max = 1;
    window_ms = 1000;
    const big: u64 = std.math.maxInt(u64) - 10;
    try std.testing.expect(!exceeded("22.1.1.1", big));
    try std.testing.expect(exceeded("22.1.1.1", big + 5)); // elapsed 5 < 1000
    try std.testing.expectEqual(@as(u64, 1), retryAfterSeconds("22.1.1.1", big + 5));
}

test "interleaved ips keep independent counts" {
    init(std.testing.allocator);
    defer reset();
    max = 2;
    window_ms = 1000;
    try std.testing.expect(!exceeded("a", 0));
    try std.testing.expect(!exceeded("b", 0));
    try std.testing.expect(!exceeded("a", 1));
    try std.testing.expect(!exceeded("b", 1));
    try std.testing.expect(exceeded("a", 2)); // a hit its max
    try std.testing.expect(exceeded("b", 2)); // b hit its max
    try std.testing.expectEqual(@as(u32, 2), table.count());
}

test "many distinct ips each get a bucket" {
    init(std.testing.allocator);
    defer reset();
    max = 1;
    window_ms = 1000;
    var buf: [8]u8 = undefined;
    var i: u32 = 0;
    while (i < 256) : (i += 1) {
        const ip = std.fmt.bufPrint(&buf, "{d}", .{i}) catch unreachable;
        try std.testing.expect(!exceeded(ip, 0));
    }
    try std.testing.expectEqual(@as(u32, 256), table.count());
}

test "init can rebind allocator between runs" {
    init(std.testing.allocator);
    max = 1;
    window_ms = 1000;
    _ = exceeded("23.1.1.1", 0);
    reset();
    // re-init with the same allocator and confirm a clean slate
    init(std.testing.allocator);
    defer reset();
    max = 1;
    window_ms = 1000;
    try std.testing.expectEqual(@as(u32, 0), table.count());
    try std.testing.expect(!exceeded("23.1.1.1", 0)); // not carried over from before
}
