const std = @import("std");
const mod = @import("ratelimit.zig");
const Limiter = mod.Limiter;

fn limiter(max: u32, window_ms: u64) Limiter {
    var l = Limiter{ .max = max, .window_ms = window_ms };
    l.init(std.testing.allocator);
    return l;
}

test "fixed window allows up to max then rejects" {
    var l = limiter(3, 1000);
    defer l.reset();
    try std.testing.expect(!l.exceeded("1.2.3.4", 0));
    try std.testing.expect(!l.exceeded("1.2.3.4", 10));
    try std.testing.expect(!l.exceeded("1.2.3.4", 20));
    try std.testing.expect(l.exceeded("1.2.3.4", 30)); // 4th in window → rejected
    try std.testing.expect(l.exceeded("1.2.3.4", 40));
}

test "window resets after it elapses" {
    var l = limiter(1, 1000);
    defer l.reset();
    try std.testing.expect(!l.exceeded("9.9.9.9", 0));
    try std.testing.expect(l.exceeded("9.9.9.9", 500)); // still in window
    try std.testing.expect(!l.exceeded("9.9.9.9", 1000)); // new window
}

test "separate ips have separate buckets" {
    var l = limiter(1, 1000);
    defer l.reset();
    try std.testing.expect(!l.exceeded("1.1.1.1", 0));
    try std.testing.expect(!l.exceeded("2.2.2.2", 0));
    try std.testing.expect(l.exceeded("1.1.1.1", 1));
}

test "separate limiters have separate state" {
    var a = limiter(1, 1000);
    defer a.reset();
    var b = limiter(1, 1000);
    defer b.reset();
    try std.testing.expect(!a.exceeded("1.2.3.4", 0));
    try std.testing.expect(a.exceeded("1.2.3.4", 1));
    // same key in the other limiter is untouched
    try std.testing.expect(!b.exceeded("1.2.3.4", 1));
    try std.testing.expectEqual(@as(u32, 1), b.table.count());
}

test "sweep removes elapsed buckets" {
    var l = limiter(5, 1000);
    defer l.reset();
    _ = l.exceeded("3.3.3.3", 0);
    try std.testing.expectEqual(@as(u32, 1), l.table.count());
    l.sweep(2000);
    try std.testing.expectEqual(@as(u32, 0), l.table.count());
}

test "retry-after counts down within the window" {
    var l = limiter(1, 1000);
    defer l.reset();
    _ = l.exceeded("4.4.4.4", 0);
    try std.testing.expectEqual(@as(u64, 1), l.retryAfterSeconds("4.4.4.4", 200));
    try std.testing.expectEqual(@as(u64, 0), l.retryAfterSeconds("4.4.4.4", 1000));
}

test "enabled tracks max" {
    var l = limiter(0, 0);
    defer l.reset();
    try std.testing.expect(!l.enabled());
    l.max = 1;
    try std.testing.expect(l.enabled());
    l.max = 1_000_000;
    try std.testing.expect(l.enabled());
}

test "reset frees buckets and disables" {
    var l = limiter(5, 1000);
    _ = l.exceeded("5.5.5.5", 0);
    _ = l.exceeded("6.6.6.6", 0);
    try std.testing.expectEqual(@as(u32, 2), l.table.count());
    l.reset();
    // limiter disabled and every bucket freed (testing.allocator catches leaks)
    try std.testing.expectEqual(@as(u32, 0), l.table.count());
    try std.testing.expectEqual(@as(u32, 0), l.max);
    try std.testing.expectEqual(@as(u64, 0), l.window_ms);
    try std.testing.expect(!l.enabled());
}

test "reset is idempotent on empty table" {
    var l = limiter(0, 0);
    l.reset();
    l.reset();
    try std.testing.expectEqual(@as(u32, 0), l.table.count());
    try std.testing.expect(!l.enabled());
}

test "max of one rejects the second request immediately" {
    var l = limiter(1, 1000);
    defer l.reset();
    try std.testing.expect(!l.exceeded("7.7.7.7", 0));
    try std.testing.expect(l.exceeded("7.7.7.7", 0)); // same instant, 2nd request
}

test "boundary at exactly window_ms opens a fresh window" {
    var l = limiter(2, 1000);
    defer l.reset();
    try std.testing.expect(!l.exceeded("8.8.8.8", 0));
    try std.testing.expect(!l.exceeded("8.8.8.8", 999)); // count 2, still in window
    try std.testing.expect(l.exceeded("8.8.8.8", 999)); // count would be 3 → rejected
    try std.testing.expect(!l.exceeded("8.8.8.8", 1000)); // elapsed == window_ms → reset
    try std.testing.expect(!l.exceeded("8.8.8.8", 1000)); // count 2 again
    try std.testing.expect(l.exceeded("8.8.8.8", 1000));
}

test "one ms before boundary still rejects" {
    var l = limiter(1, 1000);
    defer l.reset();
    try std.testing.expect(!l.exceeded("10.0.0.1", 100));
    try std.testing.expect(l.exceeded("10.0.0.1", 1099)); // elapsed 999 < 1000
    try std.testing.expect(!l.exceeded("10.0.0.1", 1100)); // elapsed 1000 → new window
}

test "rejected request does not bump the count" {
    var l = limiter(1, 1000);
    defer l.reset();
    try std.testing.expect(!l.exceeded("11.1.1.1", 0));
    try std.testing.expect(l.exceeded("11.1.1.1", 10));
    try std.testing.expect(l.exceeded("11.1.1.1", 20));
    // window resets cleanly; count was held at max, not inflated
    try std.testing.expect(!l.exceeded("11.1.1.1", 1000));
}

test "empty key is a valid distinct key" {
    var l = limiter(1, 1000);
    defer l.reset();
    try std.testing.expect(!l.exceeded("", 0));
    try std.testing.expect(l.exceeded("", 0)); // empty key has its own bucket
    try std.testing.expect(!l.exceeded("x", 0)); // unrelated key unaffected
    try std.testing.expectEqual(@as(u32, 2), l.table.count());
}

test "key is copied so caller buffer may be mutated after" {
    var l = limiter(2, 1000);
    defer l.reset();
    var buf: [16]u8 = undefined;
    const ip = "192.168.0.1";
    @memcpy(buf[0..ip.len], ip);
    try std.testing.expect(!l.exceeded(buf[0..ip.len], 0));
    // scribble over the caller's buffer; the stored key must be an owned copy
    @memset(buf[0..ip.len], 'Z');
    try std.testing.expect(!l.exceeded(ip, 1)); // same logical key still found
    try std.testing.expectEqual(@as(u32, 1), l.table.count());
    try std.testing.expect(l.exceeded(ip, 2)); // 3rd in window
}

test "raw address bytes work as keys" {
    var l = limiter(1, 1000);
    defer l.reset();
    // the TCP/UDP guards key on raw sockaddr address bytes, not text
    const v4 = [_]u8{ 192, 168, 0, 1 };
    const v6 = [_]u8{0x20} ++ [_]u8{0} ** 14 ++ [_]u8{1};
    try std.testing.expect(!l.exceeded(&v4, 0));
    try std.testing.expect(l.exceeded(&v4, 0));
    try std.testing.expect(!l.exceeded(&v6, 0));
    try std.testing.expect(l.exceeded(&v6, 0));
    try std.testing.expectEqual(@as(u32, 2), l.table.count());
}

test "long ipv6-ish key works" {
    var l = limiter(1, 1000);
    defer l.reset();
    const ip = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";
    try std.testing.expect(!l.exceeded(ip, 0));
    try std.testing.expect(l.exceeded(ip, 0));
}

test "retryAfterSeconds is zero for unknown ip" {
    var l = limiter(1, 1000);
    defer l.reset();
    try std.testing.expectEqual(@as(u64, 0), l.retryAfterSeconds("never.seen", 0));
}

test "retryAfterSeconds ceils partial seconds" {
    var l = limiter(1, 1000);
    defer l.reset();
    _ = l.exceeded("12.1.1.1", 0);
    // 1ms in: 999ms remain → ceil(0.999) == 1
    try std.testing.expectEqual(@as(u64, 1), l.retryAfterSeconds("12.1.1.1", 1));
    // 1ms before reset: 1ms remains → ceil(0.001) == 1
    try std.testing.expectEqual(@as(u64, 1), l.retryAfterSeconds("12.1.1.1", 999));
    // exactly at reset boundary: 0 remain
    try std.testing.expectEqual(@as(u64, 0), l.retryAfterSeconds("12.1.1.1", 1000));
}

test "retryAfterSeconds rounds multi-second windows up" {
    var l = limiter(1, 5000);
    defer l.reset();
    _ = l.exceeded("13.1.1.1", 0);
    try std.testing.expectEqual(@as(u64, 5), l.retryAfterSeconds("13.1.1.1", 0));
    try std.testing.expectEqual(@as(u64, 4), l.retryAfterSeconds("13.1.1.1", 1000));
    try std.testing.expectEqual(@as(u64, 1), l.retryAfterSeconds("13.1.1.1", 4001));
    try std.testing.expectEqual(@as(u64, 0), l.retryAfterSeconds("13.1.1.1", 5000));
}

test "retryAfterSeconds past window returns zero" {
    var l = limiter(1, 1000);
    defer l.reset();
    _ = l.exceeded("14.1.1.1", 0);
    try std.testing.expectEqual(@as(u64, 0), l.retryAfterSeconds("14.1.1.1", 9999));
}

test "sweep is a no-op when disabled" {
    var l = limiter(0, 1000);
    defer l.reset();
    // populate directly to prove sweep leaves a disabled table untouched
    const key = try std.testing.allocator.dupe(u8, "15.1.1.1");
    try l.table.put(std.testing.allocator, key, .{ .count = 1, .window_start = 0 });
    l.sweep(1_000_000); // would expire the bucket if it ran
    try std.testing.expectEqual(@as(u32, 1), l.table.count());
}

test "sweep on empty table is safe" {
    var l = limiter(5, 1000);
    defer l.reset();
    l.sweep(0);
    l.sweep(1_000_000);
    try std.testing.expectEqual(@as(u32, 0), l.table.count());
}

test "sweep keeps live buckets and drops only expired" {
    var l = limiter(5, 1000);
    defer l.reset();
    _ = l.exceeded("16.0.0.1", 0); // will be expired by now=1500
    _ = l.exceeded("16.0.0.2", 1000); // still live at now=1500
    try std.testing.expectEqual(@as(u32, 2), l.table.count());
    l.sweep(1500);
    try std.testing.expectEqual(@as(u32, 1), l.table.count());
    // the surviving bucket is the live one and keeps its state
    try std.testing.expect(l.table.contains("16.0.0.2"));
    try std.testing.expect(!l.table.contains("16.0.0.1"));
}

test "sweep boundary expires at exactly window_ms" {
    var l = limiter(5, 1000);
    defer l.reset();
    _ = l.exceeded("17.1.1.1", 0);
    l.sweep(999); // elapsed 999 < 1000 → kept
    try std.testing.expectEqual(@as(u32, 1), l.table.count());
    l.sweep(1000); // elapsed == 1000 → removed
    try std.testing.expectEqual(@as(u32, 0), l.table.count());
}

test "maybeSweep runs at most once per window" {
    var l = limiter(5, 1000);
    defer l.reset();
    _ = l.exceeded("17.2.2.2", 0);
    l.maybeSweep(500); // first call past last_sweep=0? 500 - 0 < 1000 → no-op
    try std.testing.expectEqual(@as(u32, 1), l.table.count());
    l.maybeSweep(1000); // 1000 - 0 >= 1000 → sweeps, bucket expired
    try std.testing.expectEqual(@as(u32, 0), l.table.count());
    _ = l.exceeded("17.2.2.2", 1100);
    l.maybeSweep(1999); // 1999 - 1000 < 1000 → no-op even though within reach
    try std.testing.expectEqual(@as(u32, 1), l.table.count());
}

test "maybeSweep with zero window never runs" {
    var l = limiter(5, 0);
    defer l.reset();
    l.maybeSweep(1_000_000);
    try std.testing.expectEqual(@as(u64, 0), l.last_sweep);
}

test "reusing an ip after sweep starts a clean window" {
    var l = limiter(1, 1000);
    defer l.reset();
    try std.testing.expect(!l.exceeded("18.1.1.1", 0));
    try std.testing.expect(l.exceeded("18.1.1.1", 10));
    l.sweep(2000); // bucket dropped
    try std.testing.expectEqual(@as(u32, 0), l.table.count());
    try std.testing.expect(!l.exceeded("18.1.1.1", 2001)); // fresh bucket, allowed again
}

test "max u32 boundary never rejects in practice" {
    var l = limiter(std.math.maxInt(u32), 1000);
    defer l.reset();
    var i: u32 = 0;
    while (i < 1000) : (i += 1) {
        try std.testing.expect(!l.exceeded("19.1.1.1", 0));
    }
    try std.testing.expectEqual(@as(u32, 1000), l.table.get("19.1.1.1").?.count);
}

test "zero window allows every request" {
    var l = limiter(1, 0);
    defer l.reset();
    // elapsed >= 0 is always true → bucket resets every call
    try std.testing.expect(!l.exceeded("20.1.1.1", 0));
    try std.testing.expect(!l.exceeded("20.1.1.1", 0));
    try std.testing.expect(!l.exceeded("20.1.1.1", 5));
    // count never climbs past 1 because each call opens a new window
    try std.testing.expectEqual(@as(u32, 1), l.table.get("20.1.1.1").?.count);
}

test "zero window makes retryAfter zero" {
    var l = limiter(1, 0);
    defer l.reset();
    _ = l.exceeded("21.1.1.1", 0);
    try std.testing.expectEqual(@as(u64, 0), l.retryAfterSeconds("21.1.1.1", 0));
}

test "large now timestamp does not overflow" {
    var l = limiter(1, 1000);
    defer l.reset();
    const big: u64 = std.math.maxInt(u64) - 10;
    try std.testing.expect(!l.exceeded("22.1.1.1", big));
    try std.testing.expect(l.exceeded("22.1.1.1", big + 5)); // elapsed 5 < 1000
    try std.testing.expectEqual(@as(u64, 1), l.retryAfterSeconds("22.1.1.1", big + 5));
}

test "interleaved ips keep independent counts" {
    var l = limiter(2, 1000);
    defer l.reset();
    try std.testing.expect(!l.exceeded("a", 0));
    try std.testing.expect(!l.exceeded("b", 0));
    try std.testing.expect(!l.exceeded("a", 1));
    try std.testing.expect(!l.exceeded("b", 1));
    try std.testing.expect(l.exceeded("a", 2)); // a hit its max
    try std.testing.expect(l.exceeded("b", 2)); // b hit its max
    try std.testing.expectEqual(@as(u32, 2), l.table.count());
}

test "many distinct ips each get a bucket" {
    var l = limiter(1, 1000);
    defer l.reset();
    var buf: [8]u8 = undefined;
    var i: u32 = 0;
    while (i < 256) : (i += 1) {
        const ip = std.fmt.bufPrint(&buf, "{d}", .{i}) catch unreachable;
        try std.testing.expect(!l.exceeded(ip, 0));
    }
    try std.testing.expectEqual(@as(u32, 256), l.table.count());
}

test "key cap: new keys fail open while the table is full of live buckets" {
    var l = limiter(1, 1000);
    l.max_keys = 4;
    defer l.reset();
    _ = l.exceeded("k1", 0);
    _ = l.exceeded("k2", 0);
    _ = l.exceeded("k3", 0);
    _ = l.exceeded("k4", 0);
    try std.testing.expectEqual(@as(u32, 4), l.table.count());
    // all live, table full → the 5th address is allowed but never tracked
    try std.testing.expect(!l.exceeded("k5", 1));
    try std.testing.expect(!l.exceeded("k5", 2)); // still untracked, still allowed
    try std.testing.expectEqual(@as(u32, 4), l.table.count());
    // tracked keys keep being limited the whole time
    try std.testing.expect(l.exceeded("k1", 3));
}

test "key cap: a full table of expired buckets is swept to make room" {
    var l = limiter(1, 1000);
    l.max_keys = 2;
    defer l.reset();
    _ = l.exceeded("k1", 0);
    _ = l.exceeded("k2", 0);
    try std.testing.expectEqual(@as(u32, 2), l.table.count());
    // both windows elapsed by now=2000 → sweep frees the slots, new key is tracked
    try std.testing.expect(!l.exceeded("k3", 2000));
    try std.testing.expect(l.exceeded("k3", 2001));
    try std.testing.expect(l.table.contains("k3"));
}

test "key cap: an existing key is still limited at capacity" {
    var l = limiter(1, 1000);
    l.max_keys = 1;
    defer l.reset();
    try std.testing.expect(!l.exceeded("k1", 0));
    try std.testing.expect(l.exceeded("k1", 1)); // found_existing path skips the cap check
}

test "init can rebind allocator between runs" {
    var l = limiter(1, 1000);
    _ = l.exceeded("23.1.1.1", 0);
    l.reset();
    // re-init with the same allocator and confirm a clean slate
    l.init(std.testing.allocator);
    l.max = 1;
    l.window_ms = 1000;
    defer l.reset();
    try std.testing.expectEqual(@as(u32, 0), l.table.count());
    try std.testing.expect(!l.exceeded("23.1.1.1", 0)); // not carried over from before
}
