//! HTTP/1.1 response serialization, written straight into a caller-owned slice.
//! Handler header block goes out verbatim; this layer owns only the status line,
//! recomputed Content-Length, and Connection framing. No alloc.

const std = @import("std");

/// Worst-case fixed bytes a frame adds around header+body. Callers size their
/// flush threshold against this plus header/body lengths.
pub const max_overhead =
    "HTTP/1.1 ".len + 3 + 1 + 32 + 2 + // status line: code + space + reason + CRLF
    "Content-Type: text/plain; charset=utf-8".len + 2 + // injected on error paths
    "Allow: ".len + 2 + // 405 only
    "Content-Length: ".len + 20 + 2 +
    "Connection: keep-alive".len + 2 +
    2; // blank line

/// Serialize into `dest`, return bytes written. `headers` must already be
/// CRLF-terminated lines (or empty); `dest` must hold max_overhead + headers + body.
pub fn serializeInto(dest: []u8, status: u16, headers: []const u8, body: []const u8, keep_alive: bool) usize {
    var p: usize = 0;
    p += put(dest[p..], "HTTP/1.1 ");
    p += writeUint(dest[p..], status);
    p += put(dest[p..], " ");
    p += put(dest[p..], reasonPhrase(status));
    p += put(dest[p..], "\r\n");
    p += put(dest[p..], headers);
    p += put(dest[p..], "Content-Length: ");
    p += writeUint(dest[p..], body.len);
    p += put(dest[p..], "\r\nConnection: ");
    p += put(dest[p..], if (keep_alive) "keep-alive" else "close");
    p += put(dest[p..], "\r\n\r\n");
    p += put(dest[p..], body);
    return p;
}

/// Head only, no body; caller supplies Content-Length. HEAD reports the would-be
/// body size, 304 reports 0.
pub fn serializeHead(dest: []u8, status: u16, headers: []const u8, content_length: usize, keep_alive: bool) usize {
    var p: usize = 0;
    p += put(dest[p..], "HTTP/1.1 ");
    p += writeUint(dest[p..], status);
    p += put(dest[p..], " ");
    p += put(dest[p..], reasonPhrase(status));
    p += put(dest[p..], "\r\n");
    p += put(dest[p..], headers);
    p += put(dest[p..], "Content-Length: ");
    p += writeUint(dest[p..], content_length);
    p += put(dest[p..], "\r\nConnection: ");
    p += put(dest[p..], if (keep_alive) "keep-alive" else "close");
    p += put(dest[p..], "\r\n\r\n");
    return p;
}

/// Head of a Transfer-Encoding: chunked response; chunks follow via writeChunkHeader.
pub fn serializeChunkedHead(dest: []u8, status: u16, headers: []const u8) usize {
    var p: usize = 0;
    p += put(dest[p..], "HTTP/1.1 ");
    p += writeUint(dest[p..], status);
    p += put(dest[p..], " ");
    p += put(dest[p..], reasonPhrase(status));
    p += put(dest[p..], "\r\n");
    p += put(dest[p..], headers);
    p += put(dest[p..], "Transfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n");
    return p;
}

/// Writes one chunk-size line `<hex>\r\n`, returns byte count.
pub fn writeChunkHeader(dest: []u8, n: usize) usize {
    var tmp: [16]u8 = undefined;
    var i: usize = tmp.len;
    var v = n;
    while (v > 0) {
        i -= 1;
        tmp[i] = "0123456789abcdef"[v & 0xF];
        v >>= 4;
    }
    if (i == tmp.len) { // n == 0
        i -= 1;
        tmp[i] = '0';
    }
    const len = tmp.len - i;
    @memcpy(dest[0..len], tmp[i..]);
    dest[len] = '\r';
    dest[len + 1] = '\n';
    return len + 2;
}

pub const ErrorKind = enum { bad_request, not_found, method_not_allowed, payload_too_large, unsupported_media_type, internal_error };

/// Self-contained text/plain error response. `allow` is the 405 Allow value.
pub fn renderError(dest: []u8, kind: ErrorKind, allow: ?[]const u8, keep_alive: bool) usize {
    const status = errorStatus(kind);
    const body = reasonPhrase(status);
    var p: usize = 0;
    p += put(dest[p..], "HTTP/1.1 ");
    p += writeUint(dest[p..], status);
    p += put(dest[p..], " ");
    p += put(dest[p..], body);
    p += put(dest[p..], "\r\nContent-Type: text/plain; charset=utf-8\r\n");
    if (allow) |a| {
        p += put(dest[p..], "Allow: ");
        p += put(dest[p..], a);
        p += put(dest[p..], "\r\n");
    }
    p += put(dest[p..], "Content-Length: ");
    p += writeUint(dest[p..], body.len);
    p += put(dest[p..], "\r\nConnection: ");
    p += put(dest[p..], if (keep_alive) "keep-alive" else "close");
    p += put(dest[p..], "\r\n\r\n");
    p += put(dest[p..], body);
    return p;
}

/// Serializes a self-contained `429 Too Many Requests` with a `Retry-After` header.
pub fn renderRateLimited(dest: []u8, retry_after_s: u64, keep_alive: bool) usize {
    const body = "Too Many Requests";
    var p: usize = 0;
    p += put(dest[p..], "HTTP/1.1 429 Too Many Requests\r\nContent-Type: text/plain; charset=utf-8\r\nRetry-After: ");
    p += writeUint(dest[p..], retry_after_s);
    p += put(dest[p..], "\r\nContent-Length: ");
    p += writeUint(dest[p..], body.len);
    p += put(dest[p..], "\r\nConnection: ");
    p += put(dest[p..], if (keep_alive) "keep-alive" else "close");
    p += put(dest[p..], "\r\n\r\n");
    p += put(dest[p..], body);
    return p;
}

fn errorStatus(kind: ErrorKind) u16 {
    return switch (kind) {
        .bad_request => 400,
        .not_found => 404,
        .method_not_allowed => 405,
        .payload_too_large => 413,
        .unsupported_media_type => 415,
        .internal_error => 500,
    };
}

/// IANA registry phrasing (RFC 9110). Unknown codes fall back to a class-generic
/// phrase so the status line stays well-formed.
pub fn reasonPhrase(status: u16) []const u8 {
    return switch (status) {
        100 => "Continue",
        101 => "Switching Protocols",
        102 => "Processing",
        103 => "Early Hints",
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        203 => "Non-Authoritative Information",
        204 => "No Content",
        205 => "Reset Content",
        206 => "Partial Content",
        207 => "Multi-Status",
        208 => "Already Reported",
        226 => "IM Used",
        300 => "Multiple Choices",
        301 => "Moved Permanently",
        302 => "Found",
        303 => "See Other",
        304 => "Not Modified",
        305 => "Use Proxy",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        401 => "Unauthorized",
        402 => "Payment Required",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        406 => "Not Acceptable",
        407 => "Proxy Authentication Required",
        408 => "Request Timeout",
        409 => "Conflict",
        410 => "Gone",
        411 => "Length Required",
        412 => "Precondition Failed",
        413 => "Content Too Large",
        414 => "URI Too Long",
        415 => "Unsupported Media Type",
        416 => "Range Not Satisfiable",
        417 => "Expectation Failed",
        418 => "I'm a Teapot",
        421 => "Misdirected Request",
        422 => "Unprocessable Content",
        423 => "Locked",
        424 => "Failed Dependency",
        425 => "Too Early",
        426 => "Upgrade Required",
        428 => "Precondition Required",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        451 => "Unavailable For Legal Reasons",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        505 => "HTTP Version Not Supported",
        506 => "Variant Also Negotiates",
        507 => "Insufficient Storage",
        508 => "Loop Detected",
        510 => "Not Extended",
        511 => "Network Authentication Required",
        else => switch (status / 100) {
            1 => "Informational",
            2 => "OK",
            3 => "Redirect",
            4 => "Client Error",
            else => "Server Error",
        },
    };
}

inline fn put(dest: []u8, bytes: []const u8) usize {
    @memcpy(dest[0..bytes.len], bytes);
    return bytes.len;
}

// decimal v into dest, returns digit count
fn writeUint(dest: []u8, v: u64) usize {
    if (v == 0) {
        dest[0] = '0';
        return 1;
    }
    var tmp: [20]u8 = undefined;
    var i: usize = tmp.len;
    var n = v;
    while (n > 0) {
        i -= 1;
        tmp[i] = '0' + @as(u8, @intCast(n % 10));
        n /= 10;
    }
    const len = tmp.len - i;
    @memcpy(dest[0..len], tmp[i..]);
    return len;
}

test "serialize a simple 200" {
    var buf: [256]u8 = undefined;
    const n = serializeInto(&buf, 200, "Content-Type: text/plain\r\n", "hi", true);
    try std.testing.expectEqualStrings(
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nhi",
        buf[0..n],
    );
}

test "serialize close + empty headers + empty body" {
    var buf: [256]u8 = undefined;
    const n = serializeInto(&buf, 204, "", "", false);
    try std.testing.expectEqualStrings(
        "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        buf[0..n],
    );
}

test "render 405 with Allow" {
    var buf: [256]u8 = undefined;
    const n = renderError(&buf, .method_not_allowed, "GET, POST", true);
    try std.testing.expectEqualStrings(
        "HTTP/1.1 405 Method Not Allowed\r\nContent-Type: text/plain; charset=utf-8\r\nAllow: GET, POST\r\nContent-Length: 18\r\nConnection: keep-alive\r\n\r\nMethod Not Allowed",
        buf[0..n],
    );
}

test "render 404" {
    var buf: [256]u8 = undefined;
    const n = renderError(&buf, .not_found, null, true);
    try std.testing.expect(std.mem.startsWith(u8, buf[0..n], "HTTP/1.1 404 Not Found\r\n"));
    try std.testing.expect(std.mem.endsWith(u8, buf[0..n], "\r\n\r\nNot Found"));
}

test "chunked head + chunk-size lines" {
    var buf: [256]u8 = undefined;
    const n = serializeChunkedHead(&buf, 200, "Content-Type: text/event-stream\r\n");
    try std.testing.expectEqualStrings(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n",
        buf[0..n],
    );
    try std.testing.expectEqualStrings("ff\r\n", buf[0..writeChunkHeader(&buf, 255)]);
    try std.testing.expectEqualStrings("1a\r\n", buf[0..writeChunkHeader(&buf, 26)]);
    try std.testing.expectEqualStrings("0\r\n", buf[0..writeChunkHeader(&buf, 0)]);
}

test "render 429 with Retry-After" {
    var buf: [256]u8 = undefined;
    const n = renderRateLimited(&buf, 7, true);
    try std.testing.expectEqualStrings(
        "HTTP/1.1 429 Too Many Requests\r\nContent-Type: text/plain; charset=utf-8\r\nRetry-After: 7\r\nContent-Length: 17\r\nConnection: keep-alive\r\n\r\nToo Many Requests",
        buf[0..n],
    );
}

test "reason phrases span the registry" {
    try std.testing.expectEqualStrings("Continue", reasonPhrase(100));
    try std.testing.expectEqualStrings("Early Hints", reasonPhrase(103));
    try std.testing.expectEqualStrings("Partial Content", reasonPhrase(206));
    try std.testing.expectEqualStrings("I'm a Teapot", reasonPhrase(418));
    try std.testing.expectEqualStrings("Unprocessable Content", reasonPhrase(422));
    try std.testing.expectEqualStrings("Too Many Requests", reasonPhrase(429));
    try std.testing.expectEqualStrings("Unavailable For Legal Reasons", reasonPhrase(451));
    try std.testing.expectEqualStrings("Bad Gateway", reasonPhrase(502));
    try std.testing.expectEqualStrings("Network Authentication Required", reasonPhrase(511));
    // unknown codes still get a class-generic phrase
    try std.testing.expectEqualStrings("Client Error", reasonPhrase(499));
}

// serializeInto: status framing, Content-Length recompute, Connection framing

test "serializeInto 200 keep-alive full frame" {
    var buf: [256]u8 = undefined;
    const n = serializeInto(&buf, 200, "X-Foo: bar\r\n", "body!", true);
    try std.testing.expectEqualStrings(
        "HTTP/1.1 200 OK\r\nX-Foo: bar\r\nContent-Length: 5\r\nConnection: keep-alive\r\n\r\nbody!",
        buf[0..n],
    );
}

test "serializeInto 200 close flag emits Connection close" {
    var buf: [256]u8 = undefined;
    const n = serializeInto(&buf, 200, "", "x", false);
    try std.testing.expectEqualStrings(
        "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx",
        buf[0..n],
    );
}

test "serializeInto 204 empty body Content-Length zero" {
    var buf: [256]u8 = undefined;
    const n = serializeInto(&buf, 204, "", "", true);
    try std.testing.expectEqualStrings(
        "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n",
        buf[0..n],
    );
}

test "serializeInto recomputes Content-Length ignoring any header claim" {
    // Handler-supplied header block goes out verbatim; this layer appends its own
    // authoritative Content-Length regardless of what the headers say.
    var buf: [256]u8 = undefined;
    const n = serializeInto(&buf, 200, "Content-Length: 999\r\n", "ab", true);
    try std.testing.expectEqualStrings(
        "HTTP/1.1 200 OK\r\nContent-Length: 999\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nab",
        buf[0..n],
    );
}

test "serializeInto byte count equals written length" {
    var buf: [256]u8 = undefined;
    const headers = "A: 1\r\n";
    const body = "hello";
    const n = serializeInto(&buf, 200, headers, body, true);
    const expected =
        "HTTP/1.1 200 OK\r\n".len + headers.len +
        "Content-Length: 5\r\n".len +
        "Connection: keep-alive\r\n\r\n".len + body.len;
    try std.testing.expectEqual(@as(usize, expected), n);
}

test "serializeInto body with embedded CRLF and NUL survives verbatim" {
    var buf: [256]u8 = undefined;
    const body = "a\r\nb\x00c";
    const n = serializeInto(&buf, 200, "", body, true);
    try std.testing.expect(std.mem.endsWith(u8, buf[0..n], body));
    try std.testing.expect(std.mem.indexOf(u8, buf[0..n], "Content-Length: 6\r\n") != null);
}

test "serializeInto unknown status falls to class phrase" {
    var buf: [256]u8 = undefined;
    const n = serializeInto(&buf, 299, "", "", true);
    try std.testing.expect(std.mem.startsWith(u8, buf[0..n], "HTTP/1.1 299 OK\r\n"));
}

test "serializeInto exact-fit buffer no overflow" {
    // Size dest to exactly the bytes produced; a one-past write would panic.
    var sizing: [256]u8 = undefined;
    const headers = "K: v\r\n";
    const body = "payload";
    const need = serializeInto(&sizing, 200, headers, body, false);
    const dest = try std.testing.allocator.alloc(u8, need);
    defer std.testing.allocator.free(dest);
    const n = serializeInto(dest, 200, headers, body, false);
    try std.testing.expectEqual(need, n);
    try std.testing.expectEqualStrings(sizing[0..need], dest[0..n]);
}

// serializeHead: head-only, caller-supplied Content-Length

test "serializeHead carries caller content_length without body" {
    var buf: [256]u8 = undefined;
    const n = serializeHead(&buf, 200, "X: y\r\n", 4096, true);
    try std.testing.expectEqualStrings(
        "HTTP/1.1 200 OK\r\nX: y\r\nContent-Length: 4096\r\nConnection: keep-alive\r\n\r\n",
        buf[0..n],
    );
}

test "serializeHead 304 zero length close" {
    var buf: [256]u8 = undefined;
    const n = serializeHead(&buf, 304, "", 0, false);
    try std.testing.expectEqualStrings(
        "HTTP/1.1 304 Not Modified\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        buf[0..n],
    );
}

test "serializeHead never appends a body" {
    var buf: [256]u8 = undefined;
    const n = serializeHead(&buf, 200, "", 12345, true);
    try std.testing.expect(std.mem.endsWith(u8, buf[0..n], "\r\n\r\n"));
}

// serializeChunkedHead: always chunked + keep-alive, no Content-Length

test "chunkedHead emits Transfer-Encoding not Content-Length" {
    var buf: [256]u8 = undefined;
    const n = serializeChunkedHead(&buf, 200, "Content-Type: application/json\r\n");
    try std.testing.expectEqualStrings(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n",
        buf[0..n],
    );
    try std.testing.expect(std.mem.indexOf(u8, buf[0..n], "Content-Length") == null);
}

test "chunkedHead empty headers" {
    var buf: [256]u8 = undefined;
    const n = serializeChunkedHead(&buf, 200, "");
    try std.testing.expectEqualStrings(
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n",
        buf[0..n],
    );
}

test "chunkedHead forces keep-alive even for non-200 status" {
    var buf: [256]u8 = undefined;
    const n = serializeChunkedHead(&buf, 201, "");
    try std.testing.expectEqualStrings(
        "HTTP/1.1 201 Created\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n",
        buf[0..n],
    );
}

// writeChunkHeader: hex size line for 0 / small / large / boundary

test "writeChunkHeader zero" {
    var buf: [32]u8 = undefined;
    const n = writeChunkHeader(&buf, 0);
    try std.testing.expectEqualStrings("0\r\n", buf[0..n]);
}

test "writeChunkHeader single hex digit boundaries" {
    var buf: [32]u8 = undefined;
    try std.testing.expectEqualStrings("1\r\n", buf[0..writeChunkHeader(&buf, 1)]);
    try std.testing.expectEqualStrings("9\r\n", buf[0..writeChunkHeader(&buf, 9)]);
    try std.testing.expectEqualStrings("a\r\n", buf[0..writeChunkHeader(&buf, 10)]);
    try std.testing.expectEqualStrings("f\r\n", buf[0..writeChunkHeader(&buf, 15)]);
}

test "writeChunkHeader two-digit rollover at 16" {
    var buf: [32]u8 = undefined;
    try std.testing.expectEqualStrings("10\r\n", buf[0..writeChunkHeader(&buf, 16)]);
    try std.testing.expectEqualStrings("ff\r\n", buf[0..writeChunkHeader(&buf, 255)]);
    try std.testing.expectEqualStrings("100\r\n", buf[0..writeChunkHeader(&buf, 256)]);
}

test "writeChunkHeader large value lowercase hex" {
    var buf: [32]u8 = undefined;
    const n = writeChunkHeader(&buf, 0xDEADBEEF);
    try std.testing.expectEqualStrings("deadbeef\r\n", buf[0..n]);
}

test "writeChunkHeader usize max fits 16-digit field" {
    var buf: [32]u8 = undefined;
    const n = writeChunkHeader(&buf, std.math.maxInt(usize));
    // usize is 64-bit on this target: 16 hex digits + CRLF.
    try std.testing.expectEqualStrings("ffffffffffffffff\r\n", buf[0..n]);
    try std.testing.expectEqual(@as(usize, 18), n);
}

test "writeChunkHeader length matches hex digits plus CRLF" {
    var buf: [32]u8 = undefined;
    try std.testing.expectEqual(@as(usize, 3), writeChunkHeader(&buf, 0)); // "0" + CRLF
    try std.testing.expectEqual(@as(usize, 3), writeChunkHeader(&buf, 15)); // "f" + CRLF
    try std.testing.expectEqual(@as(usize, 4), writeChunkHeader(&buf, 16)); // "10" + CRLF
    try std.testing.expectEqual(@as(usize, 7), writeChunkHeader(&buf, 0x10000)); // "10000" + CRLF
}

// renderError: 400 / 404 / 405 / 413 / 415 / 500, Allow handling

test "renderError 400 bad request body matches reason" {
    var buf: [256]u8 = undefined;
    const n = renderError(&buf, .bad_request, null, true);
    try std.testing.expectEqualStrings(
        "HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 11\r\nConnection: keep-alive\r\n\r\nBad Request",
        buf[0..n],
    );
}

test "renderError 404 not found close" {
    var buf: [256]u8 = undefined;
    const n = renderError(&buf, .not_found, null, false);
    try std.testing.expectEqualStrings(
        "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 9\r\nConnection: close\r\n\r\nNot Found",
        buf[0..n],
    );
}

test "renderError 405 with Allow header" {
    var buf: [256]u8 = undefined;
    const n = renderError(&buf, .method_not_allowed, "GET, HEAD, POST", true);
    try std.testing.expectEqualStrings(
        "HTTP/1.1 405 Method Not Allowed\r\nContent-Type: text/plain; charset=utf-8\r\nAllow: GET, HEAD, POST\r\nContent-Length: 18\r\nConnection: keep-alive\r\n\r\nMethod Not Allowed",
        buf[0..n],
    );
}

test "renderError 405 without Allow omits the header" {
    var buf: [256]u8 = undefined;
    const n = renderError(&buf, .method_not_allowed, null, true);
    try std.testing.expect(std.mem.indexOf(u8, buf[0..n], "Allow:") == null);
    try std.testing.expect(std.mem.startsWith(u8, buf[0..n], "HTTP/1.1 405 Method Not Allowed\r\n"));
}

test "renderError 405 empty Allow value still emits header line" {
    var buf: [256]u8 = undefined;
    const n = renderError(&buf, .method_not_allowed, "", true);
    try std.testing.expect(std.mem.indexOf(u8, buf[0..n], "\r\nAllow: \r\n") != null);
}

test "renderError emits Allow whenever allow is non-null regardless of kind" {
    // The real contract: renderError appends the Allow header for any non-null
    // allow argument, not just for 405. Callers gate it by passing null.
    var buf: [256]u8 = undefined;
    const n = renderError(&buf, .not_found, "GET", true);
    try std.testing.expect(std.mem.indexOf(u8, buf[0..n], "\r\nAllow: GET\r\n") != null);
}

test "renderError 413 payload too large" {
    var buf: [256]u8 = undefined;
    const n = renderError(&buf, .payload_too_large, null, true);
    try std.testing.expectEqualStrings(
        "HTTP/1.1 413 Content Too Large\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 17\r\nConnection: keep-alive\r\n\r\nContent Too Large",
        buf[0..n],
    );
}

test "renderError 415 unsupported media type" {
    var buf: [256]u8 = undefined;
    const n = renderError(&buf, .unsupported_media_type, null, false);
    try std.testing.expect(std.mem.startsWith(u8, buf[0..n], "HTTP/1.1 415 Unsupported Media Type\r\n"));
    try std.testing.expect(std.mem.endsWith(u8, buf[0..n], "\r\n\r\nUnsupported Media Type"));
    try std.testing.expect(std.mem.indexOf(u8, buf[0..n], "Content-Length: 22\r\n") != null);
}

test "renderError 500 internal error" {
    var buf: [256]u8 = undefined;
    const n = renderError(&buf, .internal_error, null, true);
    try std.testing.expect(std.mem.startsWith(u8, buf[0..n], "HTTP/1.1 500 Internal Server Error\r\n"));
    try std.testing.expect(std.mem.endsWith(u8, buf[0..n], "\r\n\r\nInternal Server Error"));
}

test "renderError body length equals reason phrase length for all kinds" {
    var buf: [256]u8 = undefined;
    inline for (.{
        ErrorKind.bad_request,
        ErrorKind.not_found,
        ErrorKind.method_not_allowed,
        ErrorKind.payload_too_large,
        ErrorKind.unsupported_media_type,
        ErrorKind.internal_error,
    }) |kind| {
        const n = renderError(&buf, kind, null, true);
        const status = errorStatus(kind);
        const phrase = reasonPhrase(status);
        try std.testing.expect(std.mem.endsWith(u8, buf[0..n], phrase));
        var lenbuf: [4]u8 = undefined;
        const cl = std.fmt.bufPrint(&lenbuf, "{d}", .{phrase.len}) catch unreachable;
        var marker: [32]u8 = undefined;
        const m = std.fmt.bufPrint(&marker, "Content-Length: {s}\r\n", .{cl}) catch unreachable;
        try std.testing.expect(std.mem.indexOf(u8, buf[0..n], m) != null);
    }
}

// renderRateLimited: 429 + Retry-After boundary values

test "renderRateLimited zero retry-after" {
    var buf: [256]u8 = undefined;
    const n = renderRateLimited(&buf, 0, true);
    try std.testing.expectEqualStrings(
        "HTTP/1.1 429 Too Many Requests\r\nContent-Type: text/plain; charset=utf-8\r\nRetry-After: 0\r\nContent-Length: 17\r\nConnection: keep-alive\r\n\r\nToo Many Requests",
        buf[0..n],
    );
}

test "renderRateLimited close flag" {
    var buf: [256]u8 = undefined;
    const n = renderRateLimited(&buf, 60, false);
    try std.testing.expect(std.mem.indexOf(u8, buf[0..n], "Retry-After: 60\r\n") != null);
    try std.testing.expect(std.mem.indexOf(u8, buf[0..n], "Connection: close\r\n") != null);
}

test "renderRateLimited max u64 retry-after" {
    var buf: [256]u8 = undefined;
    const n = renderRateLimited(&buf, std.math.maxInt(u64), true);
    try std.testing.expect(std.mem.indexOf(u8, buf[0..n], "Retry-After: 18446744073709551615\r\n") != null);
    try std.testing.expect(std.mem.endsWith(u8, buf[0..n], "Too Many Requests"));
}

// reasonPhrase: every class incl. unknown-code fallbacks

test "reasonPhrase known codes per class" {
    try std.testing.expectEqualStrings("Switching Protocols", reasonPhrase(101));
    try std.testing.expectEqualStrings("Created", reasonPhrase(201));
    try std.testing.expectEqualStrings("No Content", reasonPhrase(204));
    try std.testing.expectEqualStrings("Moved Permanently", reasonPhrase(301));
    try std.testing.expectEqualStrings("Not Modified", reasonPhrase(304));
    try std.testing.expectEqualStrings("Method Not Allowed", reasonPhrase(405));
    try std.testing.expectEqualStrings("Content Too Large", reasonPhrase(413));
    try std.testing.expectEqualStrings("Unsupported Media Type", reasonPhrase(415));
    try std.testing.expectEqualStrings("Internal Server Error", reasonPhrase(500));
    try std.testing.expectEqualStrings("Service Unavailable", reasonPhrase(503));
}

test "reasonPhrase unknown 1xx falls to Informational" {
    try std.testing.expectEqualStrings("Informational", reasonPhrase(150));
    try std.testing.expectEqualStrings("Informational", reasonPhrase(199));
}

test "reasonPhrase unknown 2xx falls to OK" {
    try std.testing.expectEqualStrings("OK", reasonPhrase(250));
    try std.testing.expectEqualStrings("OK", reasonPhrase(299));
}

test "reasonPhrase unknown 3xx falls to Redirect" {
    try std.testing.expectEqualStrings("Redirect", reasonPhrase(306));
    try std.testing.expectEqualStrings("Redirect", reasonPhrase(399));
}

test "reasonPhrase unknown 4xx falls to Client Error" {
    try std.testing.expectEqualStrings("Client Error", reasonPhrase(420));
    try std.testing.expectEqualStrings("Client Error", reasonPhrase(499));
}

test "reasonPhrase unknown 5xx falls to Server Error" {
    try std.testing.expectEqualStrings("Server Error", reasonPhrase(509));
    try std.testing.expectEqualStrings("Server Error", reasonPhrase(599));
}

test "reasonPhrase out-of-range codes still well-formed" {
    // 0 and 6xx land in the else->Server Error arm; never empty.
    try std.testing.expectEqualStrings("Server Error", reasonPhrase(0));
    try std.testing.expectEqualStrings("Server Error", reasonPhrase(600));
    try std.testing.expectEqualStrings("Server Error", reasonPhrase(999));
    try std.testing.expect(reasonPhrase(0).len > 0);
}

// errorStatus mapping

test "errorStatus maps each kind to its code" {
    try std.testing.expectEqual(@as(u16, 400), errorStatus(.bad_request));
    try std.testing.expectEqual(@as(u16, 404), errorStatus(.not_found));
    try std.testing.expectEqual(@as(u16, 405), errorStatus(.method_not_allowed));
    try std.testing.expectEqual(@as(u16, 413), errorStatus(.payload_too_large));
    try std.testing.expectEqual(@as(u16, 415), errorStatus(.unsupported_media_type));
    try std.testing.expectEqual(@as(u16, 500), errorStatus(.internal_error));
}

// writeUint / put internals: zero, boundaries, max

test "writeUint zero is single digit" {
    var buf: [32]u8 = undefined;
    const n = writeUint(&buf, 0);
    try std.testing.expectEqualStrings("0", buf[0..n]);
}

test "writeUint single and multi digit boundaries" {
    var buf: [32]u8 = undefined;
    try std.testing.expectEqualStrings("9", buf[0..writeUint(&buf, 9)]);
    try std.testing.expectEqualStrings("10", buf[0..writeUint(&buf, 10)]);
    try std.testing.expectEqualStrings("99", buf[0..writeUint(&buf, 99)]);
    try std.testing.expectEqualStrings("100", buf[0..writeUint(&buf, 100)]);
}

test "writeUint usize max" {
    var buf: [32]u8 = undefined;
    const n = writeUint(&buf, std.math.maxInt(usize));
    try std.testing.expectEqualStrings("18446744073709551615", buf[0..n]);
    try std.testing.expectEqual(@as(usize, 20), n);
}

test "put copies exact byte count and is a no-op for empty" {
    var buf: [16]u8 = undefined;
    try std.testing.expectEqual(@as(usize, 0), put(&buf, ""));
    const n = put(&buf, "abc");
    try std.testing.expectEqual(@as(usize, 3), n);
    try std.testing.expectEqualStrings("abc", buf[0..n]);
}

// Cross-cutting: max_overhead is a real upper bound on the frame's fixed cost

test "max_overhead bounds serializeInto fixed framing" {
    // Fixed bytes added around headers+body must never exceed the advertised
    // budget; size a worst-ish frame and check the non-header, non-body slack.
    var buf: [512]u8 = undefined;
    const headers = "Content-Type: text/plain; charset=utf-8\r\n";
    const body = "z" ** 64;
    const n = serializeInto(&buf, 200, headers, body, true);
    const framing = n - headers.len - body.len;
    try std.testing.expect(framing <= max_overhead);
}

test "max_overhead bounds renderError 405 framing" {
    var buf: [512]u8 = undefined;
    const allow = "GET, POST, PUT, DELETE, PATCH";
    const n = renderError(&buf, .method_not_allowed, allow, true);
    const body = reasonPhrase(405);
    const framing = n - allow.len - body.len;
    try std.testing.expect(framing <= max_overhead);
}
