//! Shared engine state, connection lifecycle, buffer helpers.
//! Imports neither loop.zig nor server.zig — keep it that way to avoid cycles.

const std = @import("std");
const napi = @import("napi.zig");
const uv = @import("uv.zig");
const router = @import("router.zig");
const request = @import("request.zig");
const static = @import("static.zig");

pub const alloc = std.heap.c_allocator;

/// inline per-conn buffer: head (capped here) + small bodies. small so idle
/// keep-alive conns stay cheap.
pub const read_buf_size = 16 * 1024;
/// bodies above the inline buffer spill to a heap buffer sized to the request,
/// freed when it completes.
pub const default_max_body = 1024 * 1024;
pub const cork_size = 512 * 1024;

pub var env: napi.Env = null;
pub var loop: ?*anyopaque = null;
pub var listen_socket: [uv.tcp_size]u8 align(16) = undefined;

pub var routes: router.RouteTable = undefined;
pub var dispatch_ref: napi.Ref = null;
/// served on a route miss for GET/HEAD
pub var static_table: static.Table = undefined;

pub var max_body: usize = default_max_body;
pub var max_headers: usize = 128;
pub var backlog: c_int = 512;
/// slowloris guard: close a conn with a partial request idle this long (0 = off)
pub var header_timeout_ms: u64 = 0;
/// SO_REUSEPORT (UV_TCP_REUSEPORT = 2) so workers can share a port
pub var bind_flags: c_uint = 0;
/// dispatch unmatched routes to a JS setNotFoundHandler instead of native 404
pub var not_found_dispatch: bool = false;
pub const not_found_index: u32 = 0xFFFFFFFF;
/// null-terminated for libuv
pub var host_buf: [256]u8 = .{ '0', '.', '0', '.', '0', '.', '0' } ++ .{0} ** 249;
/// resolved after bind, so port 0 reports the OS choice
pub var bound_port: u16 = 0;
/// when set, the server binds a unix-domain socket at this path instead of TCP.
pub var unix_path: ?[]const u8 = null;
/// null-terminated unix socket path storage.
pub var unix_path_buf: [1024]u8 = undefined;

/// intrusive list of live conns, for the slowloris sweep and graceful close
pub var conn_list: ?*Conn = null;
pub var server_closing: bool = false;
pub var sweep_timer: [uv.timer_size]u8 align(16) = undefined;

/// O(1) same-size slot allocator — no malloc churn, no fragmentation
pub var conn_pool: std.heap.MemoryPool(Conn) = .empty;

/// in-flight async handlers: dispatch id → conn awaiting a response
pub var pending: std.AutoHashMapUnmanaged(u32, *Conn) = .empty;
/// monotonic, never 0 (0 means "no dispatch")
pub var next_id: u32 = 1;

/// reused scratch; single thread → safe statics, zero per-request alloc
pub var cork: [cork_size]u8 = undefined;
pub var headers_scratch: [read_buf_size]u8 = undefined;
/// grown on demand to fit a response body; never shrinks
pub var resp_body: []u8 = &.{};

/// uv handle leads, so a *uv handle is the same address as the *Conn (libuv puts
/// data at offset 0; we recover Conn by cast)
pub const Conn = struct {
    tcp: [uv.tcp_size]u8 align(16),
    read_buf: [read_buf_size]u8,
    /// single body larger than read_buf, sized to the request, freed when it
    /// completes. null for the common small-request case.
    overflow: ?[]u8,
    /// bytes buffered so far across reads (into overflow if set, else read_buf)
    filled: usize,
    /// true while a Promise handler settles; reads stopped meanwhile
    awaiting: bool,
    reading: bool,
    /// guards against double-close and late resume
    closing: bool,
    dispatch_id: u32,
    /// bytes of the awaited request to drop once it completes
    pending_consume: usize,
    pending_keep_alive: bool,
    /// suspended request was a HEAD: its async response must omit the body bytes.
    pending_is_head: bool,
    /// loop time (ms) of last read; sweep uses it to find stalled requests
    last_read: u64,
    /// cold-path bytes not yet flushed — backpressure signal handed to JS so a
    /// producer can pause when the socket is full
    queued_bytes: usize,
    /// null-terminated; exposed to JS as req.ip
    peer_ip: [46]u8,
    next: ?*Conn,
    prev: ?*Conn,
};

/// req leads for the pointer-identity trick
pub const WriteReq = struct {
    req: [uv.write_size]u8 align(16),
    body: []u8,
    /// conn whose queued_bytes is settled on completion; null when irrelevant
    conn: ?*Conn,
};

pub const Outcome = union(enum) {
    sync: request.Response,
    awaiting,
};

pub inline fn opaqueOf(p: anytype) *anyopaque {
    return @ptrCast(p);
}

pub fn undefinedValue(e: napi.Env) napi.Value {
    var undef: napi.Value = undefined;
    _ = napi.napi_get_undefined(e, &undef);
    return undef;
}

pub fn nextId() u32 {
    const id = next_id;
    next_id +%= 1;
    if (next_id == 0) next_id = 1;
    return id;
}

/// returns resp_body grown to hold n bytes, or the old buffer on OOM
pub fn ensureRespBody(n: usize) []u8 {
    const want = n +| 1;
    if (resp_body.len >= want) return resp_body;
    resp_body = (if (resp_body.len == 0) alloc.alloc(u8, want) else alloc.realloc(resp_body, want)) catch return resp_body;
    return resp_body;
}

/// heap overflow if a big body is in flight, else the inline buffer
pub fn activeBuf(conn: *Conn) []u8 {
    return conn.overflow orelse conn.read_buf[0..];
}

fn consume(conn: *Conn, n: usize) void {
    const remaining = conn.filled - n;
    if (remaining != 0) {
        std.mem.copyForwards(u8, conn.read_buf[0..remaining], conn.read_buf[n..conn.filled]);
    }
    conn.filled = remaining;
}

/// overflow held exactly one request → free + reset; else slide inline remainder forward
pub fn finishRequest(conn: *Conn, consumed: usize) void {
    if (conn.overflow) |buffer| {
        alloc.free(buffer);
        conn.overflow = null;
        conn.filled = 0;
    } else {
        consume(conn, consumed);
    }
}

/// discard all buffered bytes (on error, before closing)
pub fn resetConn(conn: *Conn) void {
    if (conn.overflow) |buffer| {
        alloc.free(buffer);
        conn.overflow = null;
    }
    conn.filled = 0;
}

/// move head + partial body into a heap buffer sized to the whole request, so a
/// body larger than the inline buffer can keep arriving
pub fn growForBody(conn: *Conn, total: usize) bool {
    const grown = alloc.alloc(u8, total) catch return false;
    @memcpy(grown[0..conn.filled], conn.read_buf[0..conn.filled]);
    conn.overflow = grown;
    return true;
}

pub fn addConn(conn: *Conn) void {
    conn.prev = null;
    conn.next = conn_list;
    if (conn_list) |head| head.prev = conn;
    conn_list = conn;
}

pub fn removeConn(conn: *Conn) void {
    if (conn.prev) |p| p.next = conn.next else conn_list = conn.next;
    if (conn.next) |n| n.prev = conn.prev;
}
