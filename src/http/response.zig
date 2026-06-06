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
/// Connection framing tracks the request: a client that asked to close is told close,
/// so it won't reuse a socket the engine tears down after the final chunk.
pub fn serializeChunkedHead(dest: []u8, status: u16, headers: []const u8, keep_alive: bool) usize {
    var p: usize = 0;
    p += put(dest[p..], "HTTP/1.1 ");
    p += writeUint(dest[p..], status);
    p += put(dest[p..], " ");
    p += put(dest[p..], reasonPhrase(status));
    p += put(dest[p..], "\r\n");
    p += put(dest[p..], headers);
    p += put(dest[p..], "Transfer-Encoding: chunked\r\nConnection: ");
    p += put(dest[p..], if (keep_alive) "keep-alive" else "close");
    p += put(dest[p..], "\r\n\r\n");
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

pub fn errorStatus(kind: ErrorKind) u16 {
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

pub inline fn put(dest: []u8, bytes: []const u8) usize {
    @memcpy(dest[0..bytes.len], bytes);
    return bytes.len;
}

// decimal v into dest, returns digit count
pub fn writeUint(dest: []u8, v: u64) usize {
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
