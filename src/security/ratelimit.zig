//! native fixed-window rate limiter keyed by peer address. Each transport owns an
//! instance: the HTTP engine answers floods with a native 429 off the dispatch path,
//! the TCP server resets over-limit accepts before the TLS handshake runs, and the
//! UDP server drops over-limit datagrams before they cross into JS.
//! Disabled by default (max == 0) so a hot path pays one branch when off.

const std = @import("std");

const Bucket = struct { count: u32, window_start: u64 }; // window_start in loop ms

// ceiling on tracked keys, so a flood from many distinct addresses can't grow the
// table without bound. At the cap a sweep runs first; if every bucket is still live
// the new address goes untracked (fail open) rather than evicting an active abuser.
const default_max_keys: u32 = 100_000;

pub const Limiter = struct {
    /// max hits per window; 0 disables the limiter. set from listen/bind options.
    max: u32 = 0,
    window_ms: u64 = 0,
    max_keys: u32 = default_max_keys,

    table: std.StringHashMapUnmanaged(Bucket) = .empty,
    gpa: std.mem.Allocator = undefined,
    last_sweep: u64 = 0,

    pub fn init(self: *Limiter, allocator: std.mem.Allocator) void {
        self.gpa = allocator;
    }

    pub inline fn enabled(self: *const Limiter) bool {
        return self.max > 0;
    }

    /// true when `key` is over the limit. fails open on alloc failure or a full
    /// table; a rate limiter must never take the server down.
    pub fn exceeded(self: *Limiter, key: []const u8, now: u64) bool {
        if (!self.table.contains(key) and self.table.count() >= self.max_keys) {
            // at the key cap a flood of distinct (spoofable) sources would otherwise scan
            // the whole table on every new key; throttle the reclaim to once per window so
            // the cap can't be turned into a per-packet O(max_keys) amplifier.
            self.maybeSweep(now);
            if (self.table.count() >= self.max_keys) return false;
        }
        const gop = self.table.getOrPut(self.gpa, key) catch return false;
        if (!gop.found_existing) {
            // getOrPut stored the borrowed `key`; own a copy or back the slot out
            // by that same key (not the borrowed slice) so nothing dangles.
            const stored_key = gop.key_ptr.*;
            const owned = self.gpa.dupe(u8, key) catch {
                _ = self.table.remove(stored_key);
                return false;
            };
            gop.key_ptr.* = owned;
            gop.value_ptr.* = .{ .count = 1, .window_start = now };
            return false;
        }
        const bucket = gop.value_ptr;
        if (now - bucket.window_start >= self.window_ms) {
            bucket.* = .{ .count = 1, .window_start = now };
            return false;
        }
        if (bucket.count >= self.max) return true;
        bucket.count += 1;
        return false;
    }

    /// whole seconds until `key`'s window resets, for the Retry-After header.
    pub fn retryAfterSeconds(self: *const Limiter, key: []const u8, now: u64) u64 {
        const bucket = self.table.get(key) orelse return 0;
        const elapsed = now - bucket.window_start;
        if (elapsed >= self.window_ms) return 0;
        return (self.window_ms - elapsed + 999) / 1000;
    }

    /// drops buckets whose window has elapsed; periodic sweep so idle clients don't
    /// accumulate.
    pub fn sweep(self: *Limiter, now: u64) void {
        if (!self.enabled() or self.table.count() == 0) return;
        var expired: std.ArrayList([]const u8) = .empty;
        defer expired.deinit(self.gpa);
        var it = self.table.iterator();
        while (it.next()) |entry| {
            if (now - entry.value_ptr.window_start >= self.window_ms) {
                expired.append(self.gpa, entry.key_ptr.*) catch break;
            }
        }
        for (expired.items) |key| {
            if (self.table.fetchRemove(key)) |kv| self.gpa.free(kv.key);
        }
    }

    /// timerless sweep for the TCP/UDP guards: amortized into the accept/recv path,
    /// at most once per window.
    pub fn maybeSweep(self: *Limiter, now: u64) void {
        if (self.window_ms == 0 or now - self.last_sweep < self.window_ms) return;
        self.last_sweep = now;
        self.sweep(now);
    }

    /// frees every bucket and disables the limiter (shutdown / reuse).
    pub fn reset(self: *Limiter) void {
        var it = self.table.iterator();
        while (it.next()) |entry| self.gpa.free(entry.key_ptr.*);
        self.table.clearAndFree(self.gpa);
        self.max = 0;
        self.window_ms = 0;
        self.max_keys = default_max_keys;
        self.last_sweep = 0;
    }
};

/// the HTTP engine's limiter (server.zig owns its lifecycle; loop.zig checks it
/// per-request). TCP and UDP keep their own instances in their modules.
pub var http: Limiter = .{};
