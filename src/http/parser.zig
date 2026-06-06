//! Zero-copy HTTP/1.1 request-head parser. ParsedHead fields slice the caller's
//! read buffer; nothing is allocated. Body isn't parsed here — caller buffers
//! content_length bytes after head_end.

const std = @import("std");

/// Slices borrow the read buffer; valid only until it's recycled.
pub const ParsedHead = struct {
    method: []const u8,
    /// method == "HEAD"; precomputed because the drain checks it per request
    is_head: bool,
    path: []const u8,
    query: []const u8,
    /// 0 for HTTP/1.0, 1 for HTTP/1.1.
    version: u8,
    raw_headers: []const u8,
    content_length: usize,
    if_none_match: ?[]const u8,
    accept_encoding: ?[]const u8,
    /// Sec-WebSocket-Key value; non-empty marks a websocket upgrade request
    ws_key: []const u8,
    /// Sec-WebSocket-Protocol value (comma list of offered subprotocols), "" when absent
    ws_protocol: []const u8,
    /// Sec-WebSocket-Extensions value, "" when absent (probed for permessage-deflate)
    ws_extensions: []const u8,
    keep_alive: bool,
    /// one past the terminating \r\n\r\n, i.e. body start
    head_end: usize,
};

pub const ParseError = error{ BadRequest, TooManyHeaders };

/// Offset past first \r\n\r\n, or null if head incomplete. On resumed reads
/// pass scan_from = saturating_sub(filled, 3) so a terminator straddling two
/// buffers isn't missed.
pub fn findHeadEnd(buf: []const u8, scan_from: usize) ?usize {
    if (buf.len < 4) return null;
    const from = @min(scan_from, buf.len - 4);
    const rel = std.mem.indexOfPos(u8, buf, from, "\r\n\r\n") orelse return null;
    return rel + 4;
}

/// buf must end exactly at \r\n\r\n (buf.len == head_end).
pub fn parse(buf: []const u8, max_headers: usize) ParseError!ParsedHead {
    // request line: METHOD SP TARGET SP HTTP/x.y CRLF
    const line_end = std.mem.indexOf(u8, buf, "\r\n") orelse return error.BadRequest;
    const line = buf[0..line_end];

    const sp1 = std.mem.indexOfScalar(u8, line, ' ') orelse return error.BadRequest;
    const method = line[0..sp1];
    if (method.len == 0) return error.BadRequest;

    const rest = line[sp1 + 1 ..];
    const sp2 = std.mem.indexOfScalar(u8, rest, ' ') orelse return error.BadRequest;
    const target = rest[0..sp2];
    if (target.len == 0) return error.BadRequest;

    const version = parseVersion(rest[sp2 + 1 ..]) orelse return error.BadRequest;

    var path = target;
    var query: []const u8 = "";
    if (std.mem.indexOfScalar(u8, target, '?')) |q| {
        path = target[0..q];
        query = target[q + 1 ..];
    }

    const headers_start = line_end + 2;
    if (buf.len < headers_start + 2) return error.BadRequest;
    const raw_headers = buf[headers_start .. buf.len - 2];

    var content_length: usize = 0;
    var seen_content_length = false;
    var keep_alive = version == 1; // 1.1 defaults to keep-alive, 1.0 to close
    var if_none_match: ?[]const u8 = null;
    var accept_encoding: ?[]const u8 = null;
    var ws_key: []const u8 = "";
    var ws_protocol: []const u8 = "";
    var ws_extensions: []const u8 = "";
    var header_count: usize = 0;

    var it = std.mem.splitSequence(u8, raw_headers, "\r\n");
    while (it.next()) |hline| {
        if (hline.len == 0) continue;
        header_count += 1;
        if (header_count > max_headers) return error.TooManyHeaders;

        const colon = std.mem.indexOfScalar(u8, hline, ':') orelse return error.BadRequest;
        const name = hline[0..colon];
        const value = std.mem.trim(u8, hline[colon + 1 ..], " \t");

        if (std.ascii.eqlIgnoreCase(name, "content-length")) {
            // RFC 9112 §6.3: reject two Content-Length fields with different values — a
            // front-end and the origin disagreeing on body length is a smuggling desync.
            // Content-Length is 1*DIGIT — parseInt would also accept a leading '+'/'-', so
            // reject any non-digit byte (a stricter front-end could read '+5' differently).
            if (value.len == 0) return error.BadRequest;
            for (value) |c| if (!std.ascii.isDigit(c)) return error.BadRequest;
            const n = std.fmt.parseInt(usize, value, 10) catch return error.BadRequest;
            if (seen_content_length and n != content_length) return error.BadRequest;
            content_length = n;
            seen_content_length = true;
        } else if (std.ascii.eqlIgnoreCase(name, "transfer-encoding")) {
            // the engine frames bodies by Content-Length only; accepting a transfer
            // coding it doesn't decode would let the chunk framing be read as body and
            // open a request-smuggling desync, so reject it outright
            return error.BadRequest;
        } else if (std.ascii.eqlIgnoreCase(name, "connection")) {
            // may be a comma list; close wins over keep-alive
            if (containsTokenIgnoreCase(value, "close")) {
                keep_alive = false;
            } else if (containsTokenIgnoreCase(value, "keep-alive")) {
                keep_alive = true;
            }
        } else if (std.ascii.eqlIgnoreCase(name, "if-none-match")) {
            if_none_match = value;
        } else if (std.ascii.eqlIgnoreCase(name, "accept-encoding")) {
            accept_encoding = value;
        } else if (std.ascii.eqlIgnoreCase(name, "sec-websocket-key")) {
            ws_key = value;
        } else if (std.ascii.eqlIgnoreCase(name, "sec-websocket-protocol")) {
            ws_protocol = value;
        } else if (std.ascii.eqlIgnoreCase(name, "sec-websocket-extensions")) {
            ws_extensions = value;
        }
    }

    return .{
        .method = method,
        .is_head = std.mem.eql(u8, method, "HEAD"),
        .path = path,
        .query = query,
        .version = version,
        .raw_headers = raw_headers,
        .content_length = content_length,
        .if_none_match = if_none_match,
        .accept_encoding = accept_encoding,
        .ws_key = ws_key,
        .ws_protocol = ws_protocol,
        .ws_extensions = ws_extensions,
        .keep_alive = keep_alive,
        .head_end = buf.len,
    };
}

fn parseVersion(token: []const u8) ?u8 {
    if (std.mem.eql(u8, token, "HTTP/1.1")) return 1;
    if (std.mem.eql(u8, token, "HTTP/1.0")) return 0;
    return null;
}

fn containsTokenIgnoreCase(list: []const u8, token: []const u8) bool {
    var it = std.mem.splitScalar(u8, list, ',');
    while (it.next()) |part| {
        if (std.ascii.eqlIgnoreCase(std.mem.trim(u8, part, " \t"), token)) return true;
    }
    return false;
}
