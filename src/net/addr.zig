//! Socket-address helpers shared by the TCP and UDP servers. The port lives at byte
//! offset 2 of every sockaddr_in / sockaddr_in6 on every platform, so read it from the
//! raw bytes: no struct overlay, no alignment assumption on a kernel-supplied ptr.

const std = @import("std");
const uv = @import("../ffi/uv.zig");

fn opaqueOf(p: anytype) *anyopaque {
    return @ptrCast(p);
}

/// Host port (native byte order) from a sockaddr the kernel/libuv handed us. sin_port and
/// sin6_port are both 16-bit network-order at offset 2; read the two bytes directly.
pub fn portOf(addr: *const anyopaque) u16 {
    const bytes: [*]const u8 = @ptrCast(addr);
    return (@as(u16, bytes[2]) << 8) | bytes[3];
}

/// Fill `out` (must be sockaddr_storage-sized — an IPv6 sockaddr is larger than
/// sockaddr_in) from a host string + port. IPv4 by default; a host with ':' is IPv6.
pub fn parse(host: [*c]const u8, host_len: usize, port: i32, out: *anyopaque) bool {
    const slice = host[0..host_len];
    if (std.mem.indexOfScalar(u8, slice, ':') != null) {
        return uv.uv_ip6_addr(host, port, out) == 0;
    }
    return uv.uv_ip4_addr(host, port, out) == 0;
}

/// Presentation string of a sockaddr into `dst` (null-terminated). "" on failure.
pub fn name(addr: *const anyopaque, dst: []u8) void {
    _ = uv.uv_ip_name(addr, dst.ptr, dst.len);
}

/// Raw address bytes of a sockaddr — no port, no formatting — for hash keying on the
/// per-packet/per-accept paths where an ntop round trip is wasted work. 4 bytes for
/// IPv4 (sin_addr at offset 4), 16 for IPv6 (sin6_addr at offset 8, past flowinfo).
/// AF_INET is 2 on every platform: byte 0 on Linux/Windows (LE u16 family), byte 1 on
/// the BSDs (u8 len, then u8 family). No AF_INET6 value puts a 2 in either byte.
pub fn ipBytes(addr: *const anyopaque) []const u8 {
    const bytes: [*]const u8 = @ptrCast(addr);
    if (bytes[0] == 2 or bytes[1] == 2) return bytes[4..8];
    const v6 = bytes[8..24];
    // a v4-mapped address (::ffff:a.b.c.d) is the same peer as its native IPv4 form on a
    // dual-stack listener — key it on the embedded 4 bytes so it can't earn a second bucket.
    if (isV4Mapped(v6)) return v6[12..16];
    return v6;
}

fn isV4Mapped(v6: []const u8) bool {
    for (v6[0..10]) |b| {
        if (b != 0) return false;
    }
    return v6[10] == 0xff and v6[11] == 0xff;
}
