//! The per-connection HTTP/2 engine (RFC 9113). Owns frame reassembly, HPACK state, the
//! stream table, and both flow-control levels; turns complete requests into the same JS
//! dispatch the HTTP/1.1 path uses and frames the response back. Driven by loop.zig on
//! Node's thread — no locks. One request crosses to JS exactly as `request.build` shapes
//! it, so the whole TypeScript pipeline is reused unchanged.

const std = @import("std");
const napi = @import("../ffi/napi.zig");
const parser = @import("../http/parser.zig");
const router = @import("../http/router.zig");
const request = @import("../http/request.zig");
const ratelimit = @import("../security/ratelimit.zig");
const static = @import("../http/static.zig");
const eng = @import("../core/engine.zig");
const loop = @import("../core/loop.zig");
const frame = @import("frame.zig");
const hpack = @import("hpack.zig");
const stream = @import("stream.zig");

const alloc = eng.alloc;
const Conn = eng.Conn;
const Stream = stream.Stream;
const Span = stream.Span;
const FT = frame.FrameType;
const FL = frame.Flags;
const ERR = frame.Error;

// What we advertise in our SETTINGS. The frame size is the protocol minimum (also the most
// any peer can make us buffer per frame); the table and list sizes bound HPACK memory.
const our_max_frame = frame.Setting.default_max_frame_size; // 16384
const our_header_table = 4096;
const our_max_header_list = 32768;
// outgoing DATA is chunked to this so a frame always fits one assembly buffer
const send_chunk = our_max_frame;

// receive reassembly: holds at most one incomplete frame (<=16 KiB) plus one fresh read
const rx_cap = 40 * 1024;
// frame assembly: one max frame + its 9-octet header
const obuf_cap = our_max_frame + 64;

var pool: std.heap.MemoryPool(Connection) = .empty;

pub const Connection = struct {
    conn: *Conn,

    rx: []u8,
    rx_len: usize = 0,

    // header block reassembled across HEADERS + CONTINUATION (one at a time, never interleaved)
    hblock: []u8,
    hblock_len: usize = 0,
    cont_stream: u32 = 0, // stream id awaiting CONTINUATION (0 = none)
    cont_end_stream: bool = false,
    cont_is_trailer: bool = false, // the in-progress block is a trailer section, not a head

    hdec: hpack.Decoder,
    // scratch for one header block: Huffman output (hscratch) + assembled head (hbuf) + encode (obuf)
    hscratch: []u8,
    hbuf: []u8,
    obuf: []u8,
    // joins HTTP/2's split Cookie fields without interleaving them among other header lines
    cookiebuf: []u8,

    streams: std.AutoHashMapUnmanaged(u32, *Stream) = .empty,

    // peer settings that affect us
    peer_initial_window: i64 = frame.Setting.default_initial_window_size,
    peer_max_frame: u32 = frame.Setting.default_max_frame_size,

    // connection-level flow control
    send_conn_window: i64 = frame.Setting.default_initial_window_size,
    recv_conn_window: i64 = frame.Setting.default_initial_window_size,
    recv_conn_unacked: u32 = 0,

    last_peer_stream: u31 = 0, // highest client stream id accepted
    open_streams: u32 = 0,
    client_resets: u32 = 0, // RST_STREAM flood guard (CVE-2023-44487)
    body_inflight: usize = 0, // sum of all streams' buffered request body, capped per connection
    preface_seen: bool = false,
    goaway_sent: bool = false,

    fn writeTo(self: *Connection, bytes: []const u8) void {
        loop.writeAll(eng.opaqueOf(&self.conn.tcp), bytes);
    }

    fn ourInitialWindow(_: *Connection) i64 {
        return @intCast(eng.h2_initial_window);
    }
};

/// Allocate the h2 state, attach it to the connection, and send the server preface
/// (our SETTINGS + a connection-level WINDOW_UPDATE). Returns false on OOM.
pub fn start(conn: *Conn) bool {
    const self = pool.create(alloc) catch return false;
    self.* = .{
        .conn = conn,
        .rx = undefined,
        .hblock = undefined,
        .hscratch = undefined,
        .hbuf = undefined,
        .obuf = undefined,
        .cookiebuf = undefined,
        .hdec = hpack.Decoder.init(alloc, our_header_table, our_max_header_list),
    };
    self.rx = alloc.alloc(u8, rx_cap) catch return abortStart(self, 0);
    self.hblock = alloc.alloc(u8, our_max_header_list) catch return abortStart(self, 1);
    self.hscratch = alloc.alloc(u8, our_max_header_list) catch return abortStart(self, 2);
    // assembled head (or an outgoing header block) — the decoded list plus per-line framing
    self.hbuf = alloc.alloc(u8, our_max_header_list + 8192) catch return abortStart(self, 3);
    self.obuf = alloc.alloc(u8, obuf_cap) catch return abortStart(self, 4);
    self.cookiebuf = alloc.alloc(u8, our_max_header_list) catch return abortStart(self, 5);
    conn.h2 = self;

    self.recv_conn_window = self.ourInitialWindow();
    sendPreface(self);
    return true;
}

// unwind a partial start(): free the buffers allocated so far, drop the pool slot
fn abortStart(self: *Connection, allocated: usize) bool {
    if (allocated > 0) alloc.free(self.rx);
    if (allocated > 1) alloc.free(self.hblock);
    if (allocated > 2) alloc.free(self.hscratch);
    if (allocated > 3) alloc.free(self.hbuf);
    if (allocated > 4) alloc.free(self.obuf);
    self.hdec.deinit();
    pool.destroy(self);
    return false;
}

fn sendPreface(self: *Connection) void {
    var p: usize = frame.header_len;
    p += frame.writeSettingEntry(self.obuf[p..], frame.Setting.max_concurrent_streams, eng.h2_max_concurrent);
    p += frame.writeSettingEntry(self.obuf[p..], frame.Setting.initial_window_size, eng.h2_initial_window);
    p += frame.writeSettingEntry(self.obuf[p..], frame.Setting.max_header_list_size, our_max_header_list);
    p += frame.writeSettingEntry(self.obuf[p..], frame.Setting.header_table_size, our_header_table);
    _ = frame.writeHeader(self.obuf, @intCast(p - frame.header_len), FT.settings, 0, 0);
    self.writeTo(self.obuf[0..p]);

    // raise the connection receive window above the 65535 default for upload throughput
    const bump = self.ourInitialWindow() - frame.Setting.default_initial_window_size;
    if (bump > 0) {
        var wu: [frame.header_len + 4]u8 = undefined;
        const n = frame.writeWindowUpdate(&wu, 0, @intCast(bump));
        self.writeTo(wu[0..n]);
    }
}

/// Drive the connection from freshly buffered plaintext. Appends the connection's read
/// buffer into the reassembly buffer (fully draining it so TLS always has room), then
/// processes every complete frame.
pub fn onData(conn: *Conn) void {
    const self: *Connection = @ptrCast(@alignCast(conn.h2.?));
    const incoming = eng.activeBuf(conn)[0..conn.filled];
    if (incoming.len > self.rx.len - self.rx_len) {
        // a peer honoring our MAX_FRAME_SIZE can never overflow this; one that doesn't is done
        connError(self, ERR.frame_size_error);
        return;
    }
    @memcpy(self.rx[self.rx_len..][0..incoming.len], incoming);
    self.rx_len += incoming.len;
    conn.filled = 0;

    const env = eng.env;
    var scope: napi.HandleScope = undefined;
    _ = napi.napi_open_handle_scope(env, &scope);
    defer _ = napi.napi_close_handle_scope(env, scope);

    var pos: usize = 0;
    if (!self.preface_seen) {
        if (self.rx_len < frame.preface.len) return; // wait for the full preface
        if (!std.mem.eql(u8, self.rx[0..frame.preface.len], frame.preface)) {
            connError(self, ERR.protocol_error);
            return;
        }
        pos = frame.preface.len;
        self.preface_seen = true;
    }

    while (self.rx_len - pos >= frame.header_len) {
        const h = frame.parseHeader(self.rx[pos..][0..frame.header_len]);
        if (h.length > our_max_frame) {
            connError(self, ERR.frame_size_error);
            return;
        }
        const total = frame.header_len + h.length;
        if (self.rx_len - pos < total) break; // frame body still arriving
        handleFrame(self, h, self.rx[pos + frame.header_len ..][0..h.length]);
        if (conn.closing) return;
        pos += total;
    }
    // slide the unconsumed tail to the front
    if (pos > 0) {
        const rem = self.rx_len - pos;
        if (rem > 0) std.mem.copyForwards(u8, self.rx[0..rem], self.rx[pos..self.rx_len]);
        self.rx_len = rem;
    }
}

fn handleFrame(self: *Connection, h: frame.Header, payload: []const u8) void {
    // a header block must be finished by CONTINUATION on the same stream before anything else
    if (self.cont_stream != 0 and (h.type != FT.continuation or h.stream_id != self.cont_stream)) {
        connError(self, ERR.protocol_error);
        return;
    }
    switch (h.type) {
        FT.data => onDataFrame(self, h, payload),
        FT.headers => onHeaders(self, h, payload),
        FT.continuation => onContinuation(self, h, payload),
        FT.priority => onPriority(self, h, payload),
        FT.rst_stream => onRstStream(self, h, payload),
        FT.settings => onSettings(self, h, payload),
        FT.ping => onPing(self, h, payload),
        FT.goaway => onGoAway(self, h),
        FT.window_update => onWindowUpdate(self, h, payload),
        FT.push_promise => connError(self, ERR.protocol_error), // a client must not push
        else => {}, // unknown frame types are ignored (RFC 9113 §4.1)
    }
}

// --- HEADERS / CONTINUATION -------------------------------------------------

fn onHeaders(self: *Connection, h: frame.Header, payload: []const u8) void {
    if (h.stream_id == 0 or h.stream_id % 2 == 0) return connError(self, ERR.protocol_error);

    var block = payload;
    if (h.has(FL.padded)) {
        if (block.len == 0) return connError(self, ERR.protocol_error);
        const pad = block[0];
        block = block[1..];
        if (pad > block.len) return connError(self, ERR.protocol_error);
        block = block[0 .. block.len - pad];
    }
    var self_dep = false;
    if (h.has(FL.priority)) {
        if (block.len < 5) return connError(self, ERR.frame_size_error);
        self_dep = (frame.read32(block[0..4]) & 0x7fffffff) == h.stream_id; // §5.3.1
        block = block[5..]; // dependency + weight are otherwise ignored
    }

    // a second HEADERS on an existing stream is the trailer section (RFC 9113 §8.1)
    if (self.streams.get(h.stream_id)) |st| return onTrailers(self, st, h, block);
    if (h.stream_id <= self.last_peer_stream) return connError(self, ERR.protocol_error);

    if (self.open_streams >= eng.h2_max_concurrent) {
        // refuse without disturbing HPACK: we still must decode the block to stay in sync,
        // so accept the stream id but reset it after assembly
        self.last_peer_stream = h.stream_id;
        if (self.hblock_len + block.len > self.hblock.len) return connError(self, ERR.enhance_your_calm);
        @memcpy(self.hblock[0..block.len], block);
        self.hblock_len = block.len;
        if (h.has(FL.end_headers)) {
            if (decodeInto(self, null)) |e| return connError(self, hpackErrCode(e)); // keep HPACK in sync
            self.hblock_len = 0;
            sendRstStream(self, h.stream_id, ERR.refused_stream);
        } else {
            self.cont_stream = h.stream_id;
            self.cont_end_stream = h.has(FL.end_stream);
            self.cont_is_trailer = false;
        }
        return;
    }

    const st = alloc.create(Stream) catch return connError(self, ERR.internal_error);
    st.* = Stream.init(h.stream_id, self.ourInitialWindow(), self.peer_initial_window);
    self.streams.put(alloc, h.stream_id, st) catch {
        alloc.destroy(st);
        return connError(self, ERR.internal_error);
    };
    self.open_streams += 1;
    self.last_peer_stream = h.stream_id;
    if (h.has(FL.end_stream)) st.end_stream_recv = true;
    if (self_dep) st.bad_request = true; // reset after the block decodes (HPACK stays in sync)

    if (self.hblock_len + block.len > self.hblock.len) return connError(self, ERR.enhance_your_calm);
    @memcpy(self.hblock[0..block.len], block);
    self.hblock_len = block.len;

    if (h.has(FL.end_headers)) {
        finishHeaders(self, st);
    } else {
        self.cont_stream = h.stream_id;
        self.cont_end_stream = st.end_stream_recv;
        self.cont_is_trailer = false;
    }
}

// a trailer section: a second HEADERS on an open stream, after DATA and before half-close.
// toki exposes no trailer API, so they are decoded for HPACK sync and dropped; only their
// END_STREAM matters (RFC 9113 §8.1 requires it).
fn onTrailers(self: *Connection, st: *Stream, h: frame.Header, block: []const u8) void {
    if (!st.headers_done or st.end_stream_recv) return connError(self, ERR.protocol_error);
    if (!h.has(FL.end_stream)) return connError(self, ERR.protocol_error);
    if (self.hblock_len + block.len > self.hblock.len) return connError(self, ERR.enhance_your_calm);
    @memcpy(self.hblock[0..block.len], block);
    self.hblock_len = block.len;
    if (h.has(FL.end_headers)) {
        finishTrailers(self, st);
    } else {
        self.cont_stream = st.id;
        self.cont_end_stream = true;
        self.cont_is_trailer = true;
    }
}

fn finishTrailers(self: *Connection, st: *Stream) void {
    var sink = TrailerSink{};
    const err = self.hdec.decode(self.hblock[0..self.hblock_len], self.hscratch, &sink);
    self.hblock_len = 0;
    err catch |e| return connError(self, hpackErrCode(e));
    if (sink.bad) return streamError(self, st, ERR.protocol_error); // pseudo-header in trailers
    st.end_stream_recv = true;
    if (st.content_length) |cl| {
        if (cl != st.body_len) return streamError(self, st, ERR.protocol_error);
    }
    dispatch(self, st);
}

// trailer fields are dropped (no trailer API), but a pseudo-header among them is malformed
const TrailerSink = struct {
    bad: bool = false,
    pub fn field(self: *TrailerSink, name: []const u8, value: []const u8, sensitive: bool) void {
        _ = value;
        _ = sensitive;
        if (name.len > 0 and name[0] == ':') self.bad = true;
    }
};

fn onContinuation(self: *Connection, h: frame.Header, payload: []const u8) void {
    if (self.cont_stream == 0 or h.stream_id != self.cont_stream) return connError(self, ERR.protocol_error);
    if (self.hblock_len + payload.len > self.hblock.len) return connError(self, ERR.enhance_your_calm);
    @memcpy(self.hblock[self.hblock_len..][0..payload.len], payload);
    self.hblock_len += payload.len;
    if (!h.has(FL.end_headers)) return;

    const id = self.cont_stream;
    const is_trailer = self.cont_is_trailer;
    self.cont_stream = 0;
    const st = self.streams.get(id) orelse {
        if (decodeInto(self, null)) |e| return connError(self, hpackErrCode(e)); // stay in HPACK sync
        self.hblock_len = 0;
        sendRstStream(self, @intCast(id), ERR.refused_stream);
        return;
    };
    if (is_trailer) return finishTrailers(self, st);
    if (self.cont_end_stream) st.end_stream_recv = true;
    finishHeaders(self, st);
}

// decode the assembled block, assembling the request head; dispatch when the request is complete
fn finishHeaders(self: *Connection, st: *Stream) void {
    var asm_ctx = Assembler{ .h2 = self, .st = st };
    const err = decodeInto(self, &asm_ctx);
    self.hblock_len = 0;
    if (err) |e| return connError(self, hpackErrCode(e));
    st.headers_done = true;
    if (st.bad_request) return streamError(self, st, ERR.protocol_error);
    if (asm_ctx.malformed) return streamError(self, st, ERR.protocol_error);
    asm_ctx.finalize();
    if (asm_ctx.malformed) return streamError(self, st, ERR.protocol_error); // missing pseudo / overflow
    if (!st.takeHead(alloc, self.hbuf[0..asm_ctx.used])) return streamError(self, st, ERR.internal_error);
    if (st.end_stream_recv) {
        // END_STREAM on HEADERS means a zero-length body; a non-zero content-length lies
        if (st.content_length) |cl| {
            if (cl != st.body_len) return streamError(self, st, ERR.protocol_error);
        }
        dispatch(self, st);
    }
}

// run the HPACK decoder over the assembled block; ctx == null only keeps the table synced.
// returns the HPACK fault, if any (a connection error either way).
fn decodeInto(self: *Connection, ctx: ?*Assembler) ?hpack.Error {
    if (ctx) |c| {
        self.hdec.decode(self.hblock[0..self.hblock_len], self.hscratch, c) catch |e| return e;
    } else {
        var sink = Discard{};
        self.hdec.decode(self.hblock[0..self.hblock_len], self.hscratch, &sink) catch |e| return e;
    }
    return null;
}

fn hpackErrCode(e: hpack.Error) u32 {
    return if (e == error.HeaderListTooLarge) ERR.enhance_your_calm else ERR.compression_error;
}

const Discard = struct {
    pub fn field(_: *Discard, _: []const u8, _: []const u8, _: bool) void {}
};

// --- request head assembly --------------------------------------------------

// Builds the request head into h2.hbuf as the decoder emits fields: pseudo-headers become
// spans, regular headers become `name: value\r\n` lines, cookie fragments are joined.
const Assembler = struct {
    h2: *Connection,
    st: *Stream,
    used: usize = 0,
    saw_regular: bool = false,
    malformed: bool = false,
    cookie_len: usize = 0, // joined cookie value accumulated in h2.cookiebuf
    has_cookie: bool = false,

    pub fn field(self: *Assembler, name: []const u8, value: []const u8, sensitive: bool) void {
        _ = sensitive;
        if (self.malformed) return;
        if (name.len == 0) {
            self.malformed = true;
            return;
        }
        if (name[0] == ':') {
            if (self.saw_regular) {
                self.malformed = true; // pseudo-header after a regular header
                return;
            }
            self.pseudo(name, value);
            return;
        }
        if (!validName(name)) {
            self.malformed = true;
            return;
        }
        // connection-specific headers are forbidden in HTTP/2 (RFC 9113 §8.2.2)
        if (isForbidden(name)) {
            self.malformed = true;
            return;
        }
        if (std.mem.eql(u8, name, "te") and !std.mem.eql(u8, value, "trailers")) {
            self.malformed = true;
            return;
        }
        self.saw_regular = true;
        if (std.mem.eql(u8, name, "content-length")) {
            self.st.content_length = std.fmt.parseInt(u64, value, 10) catch {
                self.malformed = true;
                return;
            };
            return; // recomputed from DATA framing; never forwarded
        }
        if (std.mem.eql(u8, name, "cookie")) {
            self.appendCookie(value);
            return;
        }
        self.line(name, value);
    }

    fn pseudo(self: *Assembler, name: []const u8, value: []const u8) void {
        const target: *Span = if (std.mem.eql(u8, name, ":method"))
            &self.st.method
        else if (std.mem.eql(u8, name, ":path"))
            &self.st.path
        else if (std.mem.eql(u8, name, ":scheme"))
            &self.st.scheme
        else if (std.mem.eql(u8, name, ":authority"))
            &self.st.authority
        else {
            self.malformed = true; // unknown / response pseudo-header in a request
            return;
        };
        if (!target.isEmpty()) {
            self.malformed = true; // duplicate pseudo-header
            return;
        }
        target.* = self.store(value);
    }

    // copy bytes into hbuf, returning their span; sets malformed on overflow
    fn store(self: *Assembler, bytes: []const u8) Span {
        if (self.used + bytes.len > self.h2.hbuf.len) {
            self.malformed = true;
            return .{};
        }
        const off = self.used;
        @memcpy(self.h2.hbuf[off..][0..bytes.len], bytes);
        self.used += bytes.len;
        return .{ .off = @intCast(off), .len = @intCast(bytes.len) };
    }

    fn raw(self: *Assembler, bytes: []const u8) void {
        if (self.used + bytes.len > self.h2.hbuf.len) {
            self.malformed = true;
            return;
        }
        @memcpy(self.h2.hbuf[self.used..][0..bytes.len], bytes);
        self.used += bytes.len;
    }

    fn line(self: *Assembler, name: []const u8, value: []const u8) void {
        self.raw(name);
        self.raw(": ");
        self.raw(value);
        self.raw("\r\n");
    }

    // HTTP/2 splits Cookie into separate fields; rejoin them with "; " (RFC 9113 §8.2.3)
    // into a dedicated buffer so other header lines can interleave freely
    fn appendCookie(self: *Assembler, value: []const u8) void {
        const cb = self.h2.cookiebuf;
        const sep: usize = if (self.cookie_len > 0) 2 else 0;
        if (self.cookie_len + sep + value.len > cb.len) {
            self.malformed = true;
            return;
        }
        if (sep > 0) {
            @memcpy(cb[self.cookie_len..][0..2], "; ");
            self.cookie_len += 2;
        }
        @memcpy(cb[self.cookie_len..][0..value.len], value);
        self.cookie_len += value.len;
        self.has_cookie = true;
    }

    pub fn finalize(self: *Assembler) void {
        // a request must carry :method, :scheme and a non-empty :path (RFC 9113 §8.3.1)
        if (self.st.method.isEmpty() or self.st.scheme.isEmpty() or self.st.path.isEmpty()) {
            self.malformed = true;
            return;
        }
        // split the query off the assembled :path
        const path = self.st.path.slice(self.h2.hbuf[0..self.used]);
        if (std.mem.indexOfScalar(u8, path, '?')) |q| {
            self.st.query = .{ .off = self.st.path.off + @as(u32, @intCast(q + 1)), .len = self.st.path.len - @as(u32, @intCast(q + 1)) };
            self.st.path.len = @intCast(q);
        }
        const hdr_start = self.headersStart();
        if (self.has_cookie) self.line("cookie", self.h2.cookiebuf[0..self.cookie_len]);
        // synthesize Host from :authority so req.hostname works (RFC 9113 §8.3.1). The
        // authority bytes live earlier in hbuf and the append target is past every header
        // line, so the source and destination never overlap — no copy aside is needed, and
        // raw()'s bounds check caps the full value (no silent truncation).
        if (!self.st.authority.isEmpty()) self.line("host", self.st.authority.slice(self.h2.hbuf));
        self.st.headers = .{ .off = @intCast(hdr_start), .len = @intCast(self.used - hdr_start) };
    }

    fn headersStart(self: *Assembler) usize {
        // header lines begin after the four pseudo-header values; find the max span end
        var end: usize = 0;
        for ([_]Span{ self.st.method, self.st.path, self.st.query, self.st.scheme, self.st.authority }) |s| {
            end = @max(end, s.off + s.len);
        }
        return end;
    }
};

fn validName(name: []const u8) bool {
    for (name) |c| {
        // field names are lowercase tokens in HTTP/2; uppercase is malformed (§8.2.1)
        if (c >= 'A' and c <= 'Z') return false;
        if (c == ':' or c == ' ' or c == '\t' or c == '\r' or c == '\n' or c == 0) return false;
    }
    return true;
}

fn isForbidden(name: []const u8) bool {
    const list = [_][]const u8{ "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade" };
    for (list) |f| if (std.mem.eql(u8, name, f)) return true;
    return false;
}

// --- DATA -------------------------------------------------------------------

fn onDataFrame(self: *Connection, h: frame.Header, payload: []const u8) void {
    if (h.stream_id == 0) return connError(self, ERR.protocol_error);

    // connection-level flow control counts the whole payload, even on a closed stream
    self.recv_conn_window -= @intCast(payload.len);
    if (self.recv_conn_window < 0) return connError(self, ERR.flow_control_error);
    ackConnWindow(self, @intCast(payload.len));

    var data = payload;
    if (h.has(FL.padded)) {
        if (data.len == 0) return connError(self, ERR.protocol_error);
        const pad = data[0];
        data = data[1..];
        if (pad > data.len) return connError(self, ERR.protocol_error);
        data = data[0 .. data.len - pad];
    }

    const st = self.streams.get(h.stream_id) orelse {
        // idle stream → connection error; already-closed → just reset it
        if (h.stream_id > self.last_peer_stream) return connError(self, ERR.protocol_error);
        sendRstStream(self, h.stream_id, ERR.stream_closed);
        return;
    };
    if (st.end_stream_recv) return streamError(self, st, ERR.stream_closed);

    st.recv_window -= @intCast(payload.len);
    if (st.recv_window < 0) return streamError(self, st, ERR.flow_control_error);

    // cap the aggregate buffered body across all streams so a peer can't pin
    // (max_body x max_concurrent) of heap by opening many never-completing uploads
    if (self.body_inflight + data.len > bodyBudget()) return rejectOversized(self, st);
    if (!st.appendBody(alloc, data, eng.max_body)) return rejectOversized(self, st);
    self.body_inflight += data.len;
    ackStreamWindow(self, st, @intCast(payload.len));

    if (h.has(FL.end_stream)) {
        st.end_stream_recv = true;
        if (st.content_length) |cl| {
            if (cl != st.body_len) return streamError(self, st, ERR.protocol_error);
        }
        if (st.headers_done) dispatch(self, st);
    }
}

// --- other frames -----------------------------------------------------------

fn onSettings(self: *Connection, h: frame.Header, payload: []const u8) void {
    if (h.stream_id != 0) return connError(self, ERR.protocol_error);
    if (h.has(FL.ack)) {
        if (payload.len != 0) connError(self, ERR.frame_size_error);
        return;
    }
    if (payload.len % 6 != 0) return connError(self, ERR.frame_size_error);

    var i: usize = 0;
    while (i < payload.len) : (i += 6) {
        const e = frame.readSettingEntry(payload[i..][0..6]);
        switch (e.id) {
            frame.Setting.enable_push => {
                if (e.value > 1) return connError(self, ERR.protocol_error);
            },
            frame.Setting.initial_window_size => {
                if (e.value > frame.max_window) return connError(self, ERR.flow_control_error);
                adjustStreamWindows(self, @as(i64, e.value) - self.peer_initial_window);
                self.peer_initial_window = e.value;
            },
            frame.Setting.max_frame_size => {
                if (e.value < frame.Setting.default_max_frame_size or e.value > frame.Setting.max_frame_size_limit) {
                    return connError(self, ERR.protocol_error);
                }
                self.peer_max_frame = e.value;
            },
            else => {}, // header table size / max concurrent / max header list don't bind us
        }
    }
    var ack: [frame.header_len]u8 = undefined;
    _ = frame.writeSettingsAck(&ack);
    self.writeTo(&ack);
    pumpAll(self); // a raised initial window may unblock buffered responses
}

// a changed SETTINGS_INITIAL_WINDOW_SIZE shifts every open stream's send window by the delta
fn adjustStreamWindows(self: *Connection, delta: i64) void {
    var it = self.streams.valueIterator();
    while (it.next()) |sp| sp.*.send_window += delta;
}

fn onWindowUpdate(self: *Connection, h: frame.Header, payload: []const u8) void {
    if (payload.len != 4) return connError(self, ERR.frame_size_error);
    const inc = frame.read32(payload[0..4]) & 0x7fffffff;
    if (h.stream_id == 0) {
        if (inc == 0) return connError(self, ERR.protocol_error);
        self.send_conn_window += inc;
        if (self.send_conn_window > frame.max_window) return connError(self, ERR.flow_control_error);
        pumpAll(self);
        return;
    }
    // a stream id we have never opened is idle — a WINDOW_UPDATE there is a connection error
    if (h.stream_id > self.last_peer_stream) return connError(self, ERR.protocol_error);
    const st = self.streams.get(h.stream_id) orelse return; // already-closed stream: ignore
    if (inc == 0) return streamError(self, st, ERR.protocol_error);
    st.send_window += inc;
    if (st.send_window > frame.max_window) return streamError(self, st, ERR.flow_control_error);
    pumpStream(self, st);
}

// the peer is going away; only its placement on stream 0 is validated, then teardown
// proceeds when the socket closes
fn onGoAway(self: *Connection, h: frame.Header) void {
    if (h.stream_id != 0) return connError(self, ERR.protocol_error);
}

fn onRstStream(self: *Connection, h: frame.Header, payload: []const u8) void {
    if (h.stream_id == 0) return connError(self, ERR.protocol_error);
    if (payload.len != 4) return connError(self, ERR.frame_size_error);
    const st = self.streams.get(h.stream_id) orelse {
        if (h.stream_id > self.last_peer_stream) connError(self, ERR.protocol_error);
        return;
    };
    self.client_resets += 1;
    if (self.client_resets > eng.h2_max_concurrent * 4) {
        closeStream(self, st);
        return connError(self, ERR.enhance_your_calm); // rapid-reset flood
    }
    closeStream(self, st);
}

fn onPing(self: *Connection, h: frame.Header, payload: []const u8) void {
    if (h.stream_id != 0) return connError(self, ERR.protocol_error);
    if (payload.len != 8) return connError(self, ERR.frame_size_error);
    if (h.has(FL.ack)) return; // a pong to our ping (we never send pings, but ignore cleanly)
    var pong: [frame.header_len + 8]u8 = undefined;
    _ = frame.writePingAck(&pong, payload[0..8]);
    self.writeTo(&pong);
}

fn onPriority(self: *Connection, h: frame.Header, payload: []const u8) void {
    if (h.stream_id == 0) return connError(self, ERR.protocol_error);
    if (payload.len != 5) return connError(self, ERR.frame_size_error);
    // a stream depending on itself is a stream error of type PROTOCOL_ERROR (RFC 7540 §5.3.1,
    // enforced by h2spec); priority is otherwise ignored — this server schedules round-robin
    if ((frame.read32(payload[0..4]) & 0x7fffffff) == h.stream_id) {
        sendRstStream(self, h.stream_id, ERR.protocol_error);
    }
}

// --- dispatch into the JS pipeline ------------------------------------------

fn dispatch(self: *Connection, st: *Stream) void {
    if (st.dispatched) return;
    st.dispatched = true;
    st.state = .half_closed_remote;
    // a request that reaches the handler is forward progress: let the rapid-reset budget
    // recover, so a legitimate long-lived client (gRPC cancels, fetch AbortController over a
    // pooled connection) that resets many streams over time is never throttled — only a
    // reset-without-progress flood (CVE-2023-44487) trips the cap
    if (self.client_resets > 0) self.client_resets -= 1;

    const head = st.head.?;
    const method = if (st.method.isEmpty()) "GET" else st.method.slice(head);
    const path = if (st.path.isEmpty()) "/" else st.path.slice(head);

    const ip = std.mem.sliceTo(&self.conn.peer_ip, 0);
    if (ratelimit.http.enabled() and ratelimit.http.exceeded(ip, self.conn.last_read)) {
        const retry = ratelimit.http.retryAfterSeconds(ip, self.conn.last_read);
        var buf: [64]u8 = undefined;
        const hdr = std.fmt.bufPrint(&buf, "retry-after: {d}\r\n", .{retry}) catch "";
        respond(self, st, 429, hdr, "Too Many Requests", false);
        return;
    }

    var ph = parser.ParsedHead{
        .method = method,
        .is_head = std.mem.eql(u8, method, "HEAD"),
        .path = path,
        .query = st.query.slice(head),
        .version = 1,
        .raw_headers = st.headers.slice(head),
        .content_length = st.body_len,
        .if_none_match = null,
        .accept_encoding = null,
        .ws_key = "",
        .ws_protocol = "",
        .ws_extensions = "",
        .keep_alive = true,
        .head_end = 0,
    };

    switch (eng.routes.resolve(method, path, &eng.route_scratch)) {
        .found => |f| dispatchTo(self, st, &ph, f.index, f.params),
        .method_not_allowed => |allow| {
            var buf: [128]u8 = undefined;
            const hdr = std.fmt.bufPrint(&buf, "allow: {s}\r\n", .{allow}) catch "";
            respond(self, st, 405, hdr, "Method Not Allowed", ph.is_head);
        },
        .not_found => {
            if (staticEntry(method, path)) |entry| {
                const c = static.choose(entry, findHeader(ph.raw_headers, "accept-encoding"), findHeader(ph.raw_headers, "if-none-match"));
                respond(self, st, if (c.not_modified) 304 else 200, c.headers, c.body, ph.is_head);
            } else if (eng.not_found_dispatch) {
                dispatchTo(self, st, &ph, eng.not_found_index, &.{});
            } else {
                respond(self, st, 404, "", "Not Found", ph.is_head);
            }
        },
    }
}

// static-table hit for a route miss, GET/HEAD only (mirrors the HTTP/1.1 path)
fn staticEntry(method: []const u8, path: []const u8) ?static.Entry {
    if (eng.static_table.isEmpty()) return null;
    if (!std.mem.eql(u8, method, "GET") and !std.mem.eql(u8, method, "HEAD")) return null;
    return eng.static_table.get(path);
}

fn findHeader(block: []const u8, name: []const u8) ?[]const u8 {
    var it = std.mem.splitSequence(u8, block, "\r\n");
    while (it.next()) |line| {
        const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
        if (std.ascii.eqlIgnoreCase(line[0..colon], name)) return std.mem.trim(u8, line[colon + 1 ..], " \t");
    }
    return null;
}

fn dispatchTo(self: *Connection, st: *Stream, ph: *parser.ParsedHead, route_index: u32, params: []const router.Param) void {
    const env = eng.env;
    const body = st.bodySlice();
    const ip = std.mem.sliceTo(&self.conn.peer_ip, 0);
    const id = eng.nextId();

    const req = request.build(env, ph, body, route_index, id, ip, self.conn.ip_ref, params);
    var undef: napi.Value = undefined;
    _ = napi.napi_get_undefined(env, &undef);
    var dispatch_fn: napi.Value = undefined;
    _ = napi.napi_get_reference_value(env, eng.dispatch_ref, &dispatch_fn);
    const args = [_]napi.Value{req};
    var result: napi.Value = undefined;
    if (napi.napi_call_function(env, undef, dispatch_fn, 1, &args, &result) != napi.ok) {
        var ex: napi.Value = undefined;
        _ = napi.napi_get_and_clear_last_exception(env, &ex);
        respond(self, st, 500, "", "Internal Server Error", ph.is_head);
        return;
    }
    var kind: c_int = 0;
    _ = napi.napi_typeof(env, result, &kind);
    if (kind != napi.valuetype.object) {
        // handler went async — settle later via submitResponse
        st.dispatch_id = id;
        eng.h2_pending.put(alloc, id, .{ .conn = self.conn, .stream_id = st.id }) catch {
            respond(self, st, 500, "", "Internal Server Error", ph.is_head);
        };
        return;
    }
    emitJsResponse(self, st, env, result, ph.is_head);
}

// read {status, headers, body} from the JS response object and frame it
fn emitJsResponse(self: *Connection, st: *Stream, env: napi.Env, value: napi.Value, is_head: bool) void {
    const meta = request.readMeta(env, value, &eng.headers_scratch);
    if (request.bufferBody(env, meta.body_value)) |bytes| {
        respond(self, st, meta.status, meta.headers, bytes, is_head);
        return;
    }
    const buffer = eng.ensureRespBody(request.bodyLen(env, meta.body_value));
    const text = request.readStringBody(env, meta.body_value, buffer);
    respond(self, st, meta.status, meta.headers, text, is_head);
}

/// Settle an async (or streamed) handler. Called by loop.submitResponse for an h2 stream.
pub fn submit(conn: *Conn, stream_id: u32, env: napi.Env, value: napi.Value) void {
    const self: *Connection = @ptrCast(@alignCast(conn.h2 orelse return));
    const st = self.streams.get(stream_id) orelse return; // reset/closed while awaiting
    const is_head = std.mem.eql(u8, st.method.slice(st.head.?), "HEAD");
    emitJsResponse(self, st, env, value, is_head);
}

// --- streaming responses (reply.stream): startStream / writeStreamChunk / endStream -----

/// Write the streaming response head (no content-length, END_STREAM deferred to streamEnd).
pub fn streamStart(conn: *Conn, stream_id: u32, status: u16, headers: []const u8) void {
    const self: *Connection = @ptrCast(@alignCast(conn.h2 orelse return));
    const st = self.streams.get(stream_id) orelse return;
    if (st.response_done) return;
    if (!writeStreamHead(self, st, status, headers)) streamError(self, st, ERR.internal_error);
}

/// Queue a chunk as DATA, flushing what the flow-control windows allow. Returns the pending
/// backlog (buffered + socket) for the JS producer's backpressure, or -1 if the stream is gone.
pub fn streamChunk(conn: *Conn, stream_id: u32, data: []const u8) i32 {
    const self: *Connection = @ptrCast(@alignCast(conn.h2 orelse return -1));
    const st = self.streams.get(stream_id) orelse return -1;
    if (st.response_done) return -1;
    if (!queueOut(self, st, data)) {
        streamError(self, st, ERR.internal_error);
        return -1;
    }
    pumpStream(self, st); // out_fin is false → drains without closing
    if (self.streams.get(stream_id) == null) return -1;
    return streamBacklog(self, st);
}

/// Finish a streaming response: flag END_STREAM, flush, and close once drained.
pub fn streamEnd(conn: *Conn, stream_id: u32) void {
    const self: *Connection = @ptrCast(@alignCast(conn.h2 orelse return));
    const st = self.streams.get(stream_id) orelse return;
    if (st.response_done) return;
    st.out_fin = true;
    if (st.out == null or st.out_sent == st.out_len) {
        writeData(self, st.id, "", true); // a lone END_STREAM
        st.response_done = true;
        closeStream(self, st);
    } else {
        pumpStream(self, st);
    }
}

// append a chunk to the stream's pending send buffer, compacting the already-sent prefix.
// false when the backlog would blow maxWriteQueue (a producer ignoring backpressure).
fn queueOut(self: *Connection, st: *Stream, bytes: []const u8) bool {
    _ = self;
    if (bytes.len == 0) return true;
    if (st.out) |buf| {
        if (st.out_sent > 0) {
            const pending = st.out_len - st.out_sent;
            if (pending > 0) std.mem.copyForwards(u8, buf[0..pending], buf[st.out_sent..st.out_len]);
            st.out_len = pending;
            st.out_sent = 0;
        }
        const need = st.out_len + bytes.len;
        if (need > eng.max_write_queue) return false;
        if (buf.len < need) st.out = alloc.realloc(buf, need) catch return false;
        @memcpy(st.out.?[st.out_len..need], bytes);
        st.out_len = need;
    } else {
        if (bytes.len > eng.max_write_queue) return false;
        st.out = alloc.dupe(u8, bytes) catch return false;
        st.out_sent = 0;
        st.out_len = bytes.len;
    }
    return true;
}

fn streamBacklog(self: *Connection, st: *Stream) i32 {
    const pending = (st.out_len - st.out_sent) + self.conn.queued_bytes;
    return if (pending > std.math.maxInt(i32)) std.math.maxInt(i32) else @intCast(pending);
}

// --- response framing -------------------------------------------------------

fn respond(self: *Connection, st: *Stream, status: u16, headers: []const u8, body: []const u8, is_head: bool) void {
    if (writeResponse(self, st, status, headers, body, is_head)) {
        if (st.response_done) closeStream(self, st);
    } else {
        streamError(self, st, ERR.internal_error);
    }
}

// frame a full response (HEADERS + any DATA), buffering a body remainder on the stream when
// a window is exhausted; sets response_done once fully flushed. Returns false only on a
// header-encode overflow (nothing was sent). Never frees the stream.
fn writeResponse(self: *Connection, st: *Stream, status: u16, headers: []const u8, body: []const u8, is_head: bool) bool {
    if (st.response_done) return true;
    const has_body = body.len > 0 and !is_head;
    if (!encodeHeaders(self, st, status, headers, body.len, !has_body)) return false;
    if (!has_body) {
        st.response_done = true;
        return true;
    }
    sendBody(self, st, body);
    return true;
}

// HEADERS for a streaming response: no content-length (length unknown), END_STREAM deferred
// to streamEnd. Returns false on encode overflow.
fn writeStreamHead(self: *Connection, st: *Stream, status: u16, headers: []const u8) bool {
    return encodeHeadersInner(self, st, status, headers, 0, false, false);
}

// reject a request whose body exceeds maxBodyBytes: send a complete 413 then ask the client
// to stop uploading with RST_STREAM(NO_ERROR) (RFC 9113 §8.1), rather than a bare reset
fn rejectOversized(self: *Connection, st: *Stream) void {
    _ = writeResponse(self, st, 413, "", "Content Too Large", false);
    sendRstStream(self, st.id, ERR.no_error);
    closeStream(self, st);
}

// encode :status + the response headers into one or more HEADERS/CONTINUATION frames.
// returns false if the encoded block won't fit (caller resets the stream).
fn encodeHeaders(self: *Connection, st: *Stream, status: u16, headers: []const u8, body_len: usize, end_stream: bool) bool {
    return encodeHeadersInner(self, st, status, headers, body_len, end_stream, true);
}

fn encodeHeadersInner(self: *Connection, st: *Stream, status: u16, headers: []const u8, body_len: usize, end_stream: bool, with_clen: bool) bool {
    var lower: [1024]u8 = undefined; // big enough for any realistic header name (no silent truncation)
    const enc = self.hbuf; // reuse the head buffer; the request head is already copied out
    var n: usize = 0;
    n += hpack.encodeStatus(enc[n..], status);
    // content-length, unless the status forbids a body or the length is unknown (streaming)
    if (with_clen and status != 204 and status != 304 and (status < 100 or status >= 200)) {
        var cl: [24]u8 = undefined;
        const s = std.fmt.bufPrint(&cl, "{d}", .{body_len}) catch "0";
        n += hpack.encodeHeader(enc[n..], "content-length", s, &lower);
    }

    var it = std.mem.splitSequence(u8, headers, "\r\n");
    while (it.next()) |line| {
        if (line.len == 0) continue;
        const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
        const name = line[0..colon];
        // connection-specific headers are forbidden in HTTP/2 (RFC 9113 §8.2.2); content-length
        // is recomputed by the engine; a pseudo-header can't be set by a handler
        if (skipResponseHeader(name)) continue;
        const value = std.mem.trim(u8, line[colon + 1 ..], " \t");
        // a name we can't lowercase, or a worst-case literal past the buffer, fails the response
        if (name.len > lower.len) return false;
        if (n + value.len + name.len + 16 > enc.len) return false;
        n += hpack.encodeHeader(enc[n..], name, value, &lower);
    }

    frameHeaderBlock(self, st.id, enc[0..n], end_stream);
    return true;
}

// names that must not appear in an HTTP/2 response: connection-specific fields (§8.2.2),
// the engine-computed content-length, and any pseudo-header
fn skipResponseHeader(name: []const u8) bool {
    const drop = [_][]const u8{ "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "content-length" };
    for (drop) |d| if (std.ascii.eqlIgnoreCase(name, d)) return true;
    return name.len > 0 and name[0] == ':';
}

// split an encoded header block into HEADERS + CONTINUATION frames bounded by max frame size
fn frameHeaderBlock(self: *Connection, stream_id: u31, block: []const u8, end_stream: bool) void {
    var off: usize = 0;
    var first = true;
    while (true) {
        const remaining = block.len - off;
        const take = @min(remaining, send_chunk);
        const last = off + take == block.len;
        const ftype: u8 = if (first) FT.headers else FT.continuation;
        var flags: u8 = 0;
        if (last) flags |= FL.end_headers;
        if (first and end_stream) flags |= FL.end_stream;
        const hlen = frame.writeHeader(self.obuf, @intCast(take), ftype, flags, stream_id);
        @memcpy(self.obuf[hlen..][0..take], block[off..][0..take]);
        self.writeTo(self.obuf[0 .. hlen + take]);
        off += take;
        first = false;
        if (last) break;
    }
}

// send the response body as DATA frames within the flow-control windows, buffering the
// remainder on the stream when a window is exhausted
fn sendBody(self: *Connection, st: *Stream, body: []const u8) void {
    var off: usize = 0;
    while (off < body.len) {
        const win = @min(st.send_window, self.send_conn_window);
        if (win <= 0) break;
        const n = @min(@min(body.len - off, @as(usize, @intCast(win))), send_chunk);
        const last = off + n == body.len;
        writeData(self, st.id, body[off..][0..n], last);
        st.send_window -= @intCast(n);
        self.send_conn_window -= @intCast(n);
        off += n;
    }
    if (off < body.len) {
        st.out = alloc.dupe(u8, body[off..]) catch {
            // can't buffer the remainder; abort the stream and let the caller free it
            sendRstStream(self, st.id, ERR.internal_error);
            st.response_done = true;
            return;
        };
        st.out_sent = 0;
        st.out_len = body.len - off;
        st.out_fin = true;
    } else {
        st.response_done = true;
    }
}

fn writeData(self: *Connection, stream_id: u31, data: []const u8, end_stream: bool) void {
    const hlen = frame.writeHeader(self.obuf, @intCast(data.len), FT.data, if (end_stream) FL.end_stream else 0, stream_id);
    @memcpy(self.obuf[hlen..][0..data.len], data);
    self.writeTo(self.obuf[0 .. hlen + data.len]);
}

// flush a stream's buffered response bytes as its window allows. For a streaming response
// the buffer is reused across chunks (kept until close); for a one-shot body out_fin closes
// the stream once it drains.
fn pumpStream(self: *Connection, st: *Stream) void {
    const out = st.out orelse return;
    while (st.out_sent < st.out_len) {
        const win = @min(st.send_window, self.send_conn_window);
        if (win <= 0) return;
        const n = @min(@min(st.out_len - st.out_sent, @as(usize, @intCast(win))), send_chunk);
        const last = st.out_sent + n == st.out_len;
        writeData(self, st.id, out[st.out_sent..][0..n], last and st.out_fin);
        st.send_window -= @intCast(n);
        self.send_conn_window -= @intCast(n);
        st.out_sent += n;
    }
    if (st.out_sent == st.out_len) {
        if (st.out_fin) {
            st.response_done = true;
            closeStream(self, st);
        } else {
            st.out_sent = 0; // drained; keep the buffer for the next streamed chunk
            st.out_len = 0;
        }
    }
}

fn pumpAll(self: *Connection) void {
    var it = self.streams.valueIterator();
    var blocked: [256]*Stream = undefined;
    var n: usize = 0;
    while (it.next()) |sp| {
        if (sp.*.out != null) {
            if (n < blocked.len) {
                blocked[n] = sp.*;
                n += 1;
            }
        }
    }
    // pumpStream may free a stream, so collect first, then drain
    for (blocked[0..n]) |sp| {
        if (self.streams.get(sp.id) != null) pumpStream(self, sp);
    }
}

// --- flow-control acks ------------------------------------------------------

fn ackConnWindow(self: *Connection, consumed: u32) void {
    self.recv_conn_unacked += consumed;
    if (self.recv_conn_unacked >= eng.h2_initial_window / 2) {
        var wu: [frame.header_len + 4]u8 = undefined;
        const n = frame.writeWindowUpdate(&wu, 0, self.recv_conn_unacked);
        self.writeTo(wu[0..n]);
        self.recv_conn_window += self.recv_conn_unacked;
        self.recv_conn_unacked = 0;
    }
}

fn ackStreamWindow(self: *Connection, st: *Stream, consumed: u32) void {
    st.recv_unacked += consumed;
    if (st.recv_unacked >= eng.h2_initial_window / 2 and !st.end_stream_recv) {
        var wu: [frame.header_len + 4]u8 = undefined;
        const n = frame.writeWindowUpdate(&wu, st.id, st.recv_unacked);
        self.writeTo(wu[0..n]);
        st.recv_window += st.recv_unacked;
        st.recv_unacked = 0;
    }
}

// --- teardown ---------------------------------------------------------------

fn sendRstStream(self: *Connection, stream_id: u31, code: u32) void {
    var buf: [frame.header_len + 4]u8 = undefined;
    const n = frame.writeRstStream(&buf, stream_id, code);
    self.writeTo(buf[0..n]);
}

fn streamError(self: *Connection, st: *Stream, code: u32) void {
    sendRstStream(self, st.id, code);
    closeStream(self, st);
}

fn closeStream(self: *Connection, st: *Stream) void {
    if (st.dispatch_id != 0) _ = eng.h2_pending.remove(st.dispatch_id);
    self.body_inflight -|= st.body_len; // release this stream's share of the body budget
    if (self.streams.fetchRemove(st.id)) |_| {
        if (self.open_streams > 0) self.open_streams -= 1;
    }
    st.deinit(alloc);
    alloc.destroy(st);
}

// per-connection ceiling on buffered (incomplete) request bodies: enough for several
// concurrent uploads, but bounded so a peer can't pin max_body x max_concurrent of heap
fn bodyBudget() usize {
    return @max(eng.max_body, 16 * 1024 * 1024);
}

fn connError(self: *Connection, code: u32) void {
    if (!self.goaway_sent) {
        var buf: [frame.header_len + 8]u8 = undefined;
        const n = frame.writeGoAway(&buf, self.last_peer_stream, code);
        self.writeTo(buf[0..n]);
        self.goaway_sent = true;
    }
    loop.closeConn(eng.opaqueOf(&self.conn.tcp));
}

/// Free all h2 state. Called from loop.onClose; safe to call once per connection.
pub fn onClosed(conn: *Conn) void {
    const self: *Connection = @ptrCast(@alignCast(conn.h2 orelse return));
    conn.h2 = null;
    var it = self.streams.valueIterator();
    while (it.next()) |sp| {
        if (sp.*.dispatch_id != 0) _ = eng.h2_pending.remove(sp.*.dispatch_id);
        sp.*.deinit(alloc);
        alloc.destroy(sp.*);
    }
    self.streams.deinit(alloc);
    self.hdec.deinit();
    alloc.free(self.rx);
    alloc.free(self.hblock);
    alloc.free(self.hscratch);
    alloc.free(self.hbuf);
    alloc.free(self.obuf);
    alloc.free(self.cookiebuf);
    pool.destroy(self);
}

/// Whether this h2 connection is stalled mid-request, for the header-timeout sweep: the
/// preface is incomplete, a partial frame sits buffered, or a stream is still receiving its
/// request. An idle keep-alive connection (preface done, no buffered bytes, every stream
/// half-closed remote) is NOT stalled, and a stream merely awaiting our async response
/// doesn't count — that's a slow handler, not a slow client.
pub fn stalled(conn: *Conn) bool {
    const self: *Connection = @ptrCast(@alignCast(conn.h2 orelse return false));
    if (!self.preface_seen) return true;
    if (self.rx_len > 0) return true;
    var it = self.streams.valueIterator();
    while (it.next()) |sp| {
        if (!sp.*.end_stream_recv) return true;
    }
    return false;
}

/// Whether a plaintext connection's buffered bytes are the h2c preface (prior knowledge).
/// Returns .yes once enough bytes confirm it, .partial while still a possible prefix, .no
/// when they diverge — so the HTTP/1.1 path keeps the connection otherwise.
pub const Detect = enum { yes, partial, no };

pub fn detectPreface(buf: []const u8) Detect {
    const n = @min(buf.len, frame.preface.len);
    if (!std.mem.eql(u8, buf[0..n], frame.preface[0..n])) return .no;
    return if (buf.len >= frame.preface.len) .yes else .partial;
}

/// Exclusive h2c mode: a cleartext connection that didn't open with the preface gets a
/// GOAWAY(PROTOCOL_ERROR) and is closed, instead of falling back to HTTP/1.1.
pub fn rejectCleartext(conn: *Conn) void {
    var buf: [frame.header_len + 8]u8 = undefined;
    const n = frame.writeGoAway(&buf, 0, ERR.protocol_error);
    loop.writeAll(eng.opaqueOf(&conn.tcp), buf[0..n]);
    loop.closeConn(eng.opaqueOf(&conn.tcp));
}
