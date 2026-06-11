//! Per-stream state for an HTTP/2 connection (RFC 9113 §5). A server stream carries the
//! request being assembled (pseudo-header spans into `head`, plus the body), the two
//! flow-control windows, and the response bytes still waiting on a send window. The
//! connection drives the lifecycle; this owns the buffers and frees them.

const std = @import("std");

/// a {name,value} region inside `head`, offset-based so head can be reallocated
pub const Span = struct {
    off: u32 = 0,
    len: u32 = 0,

    pub fn slice(self: Span, buf: []const u8) []const u8 {
        return buf[self.off..][0..self.len];
    }
    pub fn isEmpty(self: Span) bool {
        return self.len == 0;
    }
};

/// Server-relevant subset of the stream state machine. Push/reserved states are absent —
/// this server never sends PUSH_PROMISE.
pub const State = enum { idle, open, half_closed_remote, closed };

pub const Stream = struct {
    id: u31,
    state: State = .idle,

    /// how much more request body the peer may send us (our advertised receive window,
    /// decremented per DATA, replenished by WINDOW_UPDATE)
    recv_window: i64,
    /// how much response body we may send (the peer's window, grown by its WINDOW_UPDATE)
    send_window: i64,
    /// request body received but not yet acknowledged with a WINDOW_UPDATE
    recv_unacked: u32 = 0,

    /// assembled request head: method/path/scheme/authority values + the regular header
    /// lines, copied stable when END_HEADERS lands. spans index into it.
    head: ?[]u8 = null,
    method: Span = .{},
    path: Span = .{},
    query: Span = .{},
    scheme: Span = .{},
    authority: Span = .{},
    headers: Span = .{}, // the `name: value\r\n` block handed to request.build

    /// accumulated request body, grown as DATA arrives
    body: ?[]u8 = null,
    body_len: usize = 0,
    /// declared Content-Length, for the exact-length check at END_STREAM (null = absent)
    content_length: ?u64 = null,

    /// response bytes still waiting on a send window: the pending slice is out[out_sent..out_len].
    /// `out` is the backing buffer (grows for streaming); freed when the stream closes.
    out: ?[]u8 = null,
    out_sent: usize = 0,
    out_len: usize = 0,
    /// emit END_STREAM once the pending bytes have fully drained
    out_fin: bool = false,

    end_stream_recv: bool = false, // client half-closed (request complete)
    headers_done: bool = false, // END_HEADERS seen, head assembled
    dispatched: bool = false, // handed to the JS handler
    response_done: bool = false, // we sent END_STREAM
    /// semantically invalid request (bad pseudo-header, uppercase name, …) → the
    /// connection answers with RST_STREAM(PROTOCOL_ERROR) instead of dispatching
    malformed: bool = false,
    /// flagged during framing (e.g. a self-dependent priority) to reset once the header
    /// block finishes decoding, keeping HPACK in sync first
    bad_request: bool = false,
    /// async handler correlation; 0 when sync or not yet dispatched
    dispatch_id: u32 = 0,

    pub fn init(id: u31, recv_window: i64, send_window: i64) Stream {
        return .{ .id = id, .state = .open, .recv_window = recv_window, .send_window = send_window };
    }

    pub fn deinit(self: *Stream, gpa: std.mem.Allocator) void {
        if (self.head) |h| gpa.free(h);
        if (self.body) |b| gpa.free(b);
        if (self.out) |o| gpa.free(o);
        self.head = null;
        self.body = null;
        self.out = null;
    }

    /// copy the assembled head into right-sized owned storage; spans already reference
    /// these offsets, so they stay valid against the copy
    pub fn takeHead(self: *Stream, gpa: std.mem.Allocator, src: []const u8) bool {
        const buf = gpa.alloc(u8, src.len) catch return false;
        @memcpy(buf, src);
        self.head = buf;
        return true;
    }

    /// append a DATA payload to the request body, enforcing `max`. Returns false when the
    /// body would exceed the cap (the caller resets the stream).
    pub fn appendBody(self: *Stream, gpa: std.mem.Allocator, data: []const u8, max: usize) bool {
        if (data.len == 0) return true;
        const need = self.body_len + data.len;
        if (need > max) return false;
        if (self.body == null) {
            const hint = if (self.content_length) |cl| @min(@as(usize, @intCast(cl)), max) else need;
            self.body = gpa.alloc(u8, @max(hint, need)) catch return false;
        } else if (self.body.?.len < need) {
            self.body = gpa.realloc(self.body.?, need) catch return false;
        }
        @memcpy(self.body.?[self.body_len..need], data);
        self.body_len = need;
        return true;
    }

    pub fn bodySlice(self: *const Stream) ?[]const u8 {
        if (self.body_len == 0) return null;
        return self.body.?[0..self.body_len];
    }
};
