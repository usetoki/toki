const std = @import("std");
const mod = @import("parser.zig");
const ParseError = mod.ParseError;
const ParsedHead = mod.ParsedHead;
const findHeadEnd = mod.findHeadEnd;
const parse = mod.parse;

test "parse GET with query and keep-alive default" {
    const raw = "GET /users/42?active=1 HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n";
    const end = findHeadEnd(raw, 0).?;
    const h = try parse(raw[0..end], 128);
    try std.testing.expectEqualStrings("GET", h.method);
    try std.testing.expectEqualStrings("/users/42", h.path);
    try std.testing.expectEqualStrings("active=1", h.query);
    try std.testing.expectEqual(@as(u8, 1), h.version);
    try std.testing.expectEqual(@as(usize, 0), h.content_length);
    try std.testing.expect(h.keep_alive);
}

test "HTTP/1.0 closes unless keep-alive asked" {
    const raw = "GET / HTTP/1.0\r\nHost: x\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expect(!h.keep_alive);

    const raw2 = "GET / HTTP/1.0\r\nConnection: keep-alive\r\n\r\n";
    const h2 = try parse(raw2[0..findHeadEnd(raw2, 0).?], 128);
    try std.testing.expect(h2.keep_alive);
}

test "Connection: close overrides 1.1 default" {
    const raw = "POST /x HTTP/1.1\r\nConnection: close\r\nContent-Length: 5\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expect(!h.keep_alive);
    try std.testing.expectEqual(@as(usize, 5), h.content_length);
    try std.testing.expectEqualStrings("POST", h.method);
}

test "findHeadEnd returns null on partial head" {
    try std.testing.expect(findHeadEnd("GET / HTTP/1.1\r\nHost: x\r\n", 0) == null);
}

test "too many headers rejected" {
    const raw = "GET / HTTP/1.1\r\nA: 1\r\nB: 2\r\nC: 3\r\n\r\n";
    try std.testing.expectError(error.TooManyHeaders, parse(raw[0..findHeadEnd(raw, 0).?], 2));
}

test "malformed request line rejected" {
    const raw = "GARBAGE\r\n\r\n";
    try std.testing.expectError(error.BadRequest, parse(raw[0..findHeadEnd(raw, 0).?], 128));
}

// findHeadEnd: boundary & scan_from behavior

test "findHeadEnd empty buffer is null" {
    try std.testing.expect(findHeadEnd("", 0) == null);
}

test "findHeadEnd short buffers under 4 bytes are null" {
    try std.testing.expect(findHeadEnd("\r", 0) == null);
    try std.testing.expect(findHeadEnd("\r\n", 0) == null);
    try std.testing.expect(findHeadEnd("\r\n\r", 0) == null);
}

test "findHeadEnd minimal exact terminator" {
    try std.testing.expectEqual(@as(?usize, 4), findHeadEnd("\r\n\r\n", 0));
}

test "findHeadEnd returns first terminator only" {
    const raw = "GET / HTTP/1.1\r\n\r\nBODY\r\n\r\n";
    // first \r\n\r\n is right after the request line
    try std.testing.expectEqual(@as(?usize, 18), findHeadEnd(raw, 0));
}

test "findHeadEnd offset points one past terminator" {
    const raw = "A: b\r\n\r\nx";
    const end = findHeadEnd(raw, 0).?;
    try std.testing.expectEqual(@as(usize, 8), end);
    try std.testing.expectEqualStrings("x", raw[end..]);
}

test "findHeadEnd scan_from beyond len is clamped not crash" {
    const raw = "GET / HTTP/1.1\r\n\r\n";
    // scan_from way past buffer length must be saturated to buf.len-4
    try std.testing.expectEqual(@as(?usize, raw.len), findHeadEnd(raw, 9999));
}

test "findHeadEnd resumed scan with overlap finds straddling terminator" {
    // terminator straddles where a prior read stopped; scan_from = filled-3
    const raw = "X: y\r\n\r\n";
    const filled = raw.len;
    const scan_from = if (filled >= 3) filled - 3 else 0;
    try std.testing.expectEqual(@as(?usize, raw.len), findHeadEnd(raw, scan_from));
}

test "findHeadEnd no terminator present is null" {
    try std.testing.expect(findHeadEnd("no crlf crlf here at all", 0) == null);
}

test "findHeadEnd lone newlines without CR are null" {
    try std.testing.expect(findHeadEnd("a\n\nb\n\n", 0) == null);
}

// Request line: methods, targets, versions

test "minimal request no headers" {
    const raw = "GET / HTTP/1.1\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqualStrings("GET", h.method);
    try std.testing.expectEqualStrings("/", h.path);
    try std.testing.expectEqualStrings("", h.query);
    try std.testing.expectEqual(@as(u8, 1), h.version);
    try std.testing.expectEqual(@as(usize, 0), h.content_length);
    try std.testing.expectEqualStrings("", h.raw_headers);
    try std.testing.expect(h.if_none_match == null);
    try std.testing.expect(h.accept_encoding == null);
    try std.testing.expect(h.keep_alive);
}

test "method preserves exact case uppercase" {
    const raw = "DELETE /a HTTP/1.1\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqualStrings("DELETE", h.method);
}

test "method lowercase preserved verbatim" {
    const raw = "get / HTTP/1.1\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqualStrings("get", h.method);
}

test "method mixed case preserved verbatim" {
    const raw = "PoSt / HTTP/1.1\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqualStrings("PoSt", h.method);
}

test "long uncommon method accepted" {
    const raw = "PROPPATCH /dav HTTP/1.1\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqualStrings("PROPPATCH", h.method);
}

test "empty method rejected leading space" {
    const raw = " / HTTP/1.1\r\n\r\n";
    try std.testing.expectError(error.BadRequest, parse(raw[0..findHeadEnd(raw, 0).?], 128));
}

test "empty target rejected double space" {
    const raw = "GET  HTTP/1.1\r\n\r\n";
    try std.testing.expectError(error.BadRequest, parse(raw[0..findHeadEnd(raw, 0).?], 128));
}

test "missing second space rejected" {
    const raw = "GET /onlytarget\r\n\r\n";
    try std.testing.expectError(error.BadRequest, parse(raw[0..findHeadEnd(raw, 0).?], 128));
}

test "no spaces in request line rejected" {
    const raw = "GET\r\n\r\n";
    try std.testing.expectError(error.BadRequest, parse(raw[0..findHeadEnd(raw, 0).?], 128));
}

test "HTTP 1.1 version recognized" {
    const raw = "GET / HTTP/1.1\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqual(@as(u8, 1), h.version);
}

test "HTTP 1.0 version recognized" {
    const raw = "GET / HTTP/1.0\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqual(@as(u8, 0), h.version);
}

test "unsupported HTTP 2.0 rejected" {
    const raw = "GET / HTTP/2.0\r\n\r\n";
    try std.testing.expectError(error.BadRequest, parse(raw[0..findHeadEnd(raw, 0).?], 128));
}

test "garbage version token rejected" {
    const raw = "GET / SPDY/3\r\n\r\n";
    try std.testing.expectError(error.BadRequest, parse(raw[0..findHeadEnd(raw, 0).?], 128));
}

test "version with trailing garbage rejected" {
    const raw = "GET / HTTP/1.1x\r\n\r\n";
    try std.testing.expectError(error.BadRequest, parse(raw[0..findHeadEnd(raw, 0).?], 128));
}

test "lowercase version token rejected" {
    const raw = "GET / http/1.1\r\n\r\n";
    try std.testing.expectError(error.BadRequest, parse(raw[0..findHeadEnd(raw, 0).?], 128));
}

test "extra space before version makes empty target slot" {
    // METHOD SP TARGET SP <empty> ... third token would be empty version token
    const raw = "GET /a  HTTP/1.1\r\n\r\n";
    // rest after first space is "/a  HTTP/1.1"; sp2 splits target "/a", version token " HTTP/1.1" -> not matched
    try std.testing.expectError(error.BadRequest, parse(raw[0..findHeadEnd(raw, 0).?], 128));
}

// Target / path / query splitting

test "path without query has empty query" {
    const raw = "GET /a/b/c HTTP/1.1\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqualStrings("/a/b/c", h.path);
    try std.testing.expectEqualStrings("", h.query);
}

test "query split at first question mark" {
    const raw = "GET /search?q=a?b=c HTTP/1.1\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqualStrings("/search", h.path);
    try std.testing.expectEqualStrings("q=a?b=c", h.query);
}

test "trailing question mark yields empty query" {
    const raw = "GET /x? HTTP/1.1\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqualStrings("/x", h.path);
    try std.testing.expectEqualStrings("", h.query);
}

test "leading question mark yields empty path" {
    const raw = "GET ?only=q HTTP/1.1\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqualStrings("", h.path);
    try std.testing.expectEqualStrings("only=q", h.query);
}

test "asterisk target preserved" {
    const raw = "OPTIONS * HTTP/1.1\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqualStrings("OPTIONS", h.method);
    try std.testing.expectEqualStrings("*", h.path);
    try std.testing.expectEqualStrings("", h.query);
}

test "absolute uri target preserved as path" {
    const raw = "GET http://h/p?x=1 HTTP/1.1\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqualStrings("http://h/p", h.path);
    try std.testing.expectEqualStrings("x=1", h.query);
}

// Headers: counting, blank lines, raw_headers slice

test "many headers under limit all parsed" {
    const raw = "GET / HTTP/1.1\r\nA: 1\r\nB: 2\r\nC: 3\r\nD: 4\r\nE: 5\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqualStrings("A: 1\r\nB: 2\r\nC: 3\r\nD: 4\r\nE: 5\r\n", h.raw_headers);
}

test "header count exactly at limit accepted" {
    const raw = "GET / HTTP/1.1\r\nA: 1\r\nB: 2\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 2);
    try std.testing.expectEqualStrings("A: 1\r\nB: 2\r\n", h.raw_headers);
}

test "header count one over limit rejected" {
    const raw = "GET / HTTP/1.1\r\nA: 1\r\nB: 2\r\nC: 3\r\n\r\n";
    try std.testing.expectError(error.TooManyHeaders, parse(raw[0..findHeadEnd(raw, 0).?], 2));
}

test "zero max_headers rejects first header" {
    const raw = "GET / HTTP/1.1\r\nA: 1\r\n\r\n";
    try std.testing.expectError(error.TooManyHeaders, parse(raw[0..findHeadEnd(raw, 0).?], 0));
}

test "zero max_headers ok when no headers" {
    const raw = "GET / HTTP/1.1\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 0);
    try std.testing.expectEqualStrings("", h.raw_headers);
}

test "header missing colon rejected" {
    const raw = "GET / HTTP/1.1\r\nBadHeaderNoColon\r\n\r\n";
    try std.testing.expectError(error.BadRequest, parse(raw[0..findHeadEnd(raw, 0).?], 128));
}

test "header with empty value accepted" {
    const raw = "GET / HTTP/1.1\r\nX-Empty:\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqualStrings("X-Empty:\r\n", h.raw_headers);
}

test "header empty name before colon accepted" {
    const raw = "GET / HTTP/1.1\r\n: value\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqualStrings(": value\r\n", h.raw_headers);
}

// Content-Length: parsing, boundaries, malformed

test "content length positive parsed" {
    const raw = "POST / HTTP/1.1\r\nContent-Length: 1234\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqual(@as(usize, 1234), h.content_length);
}

test "content length name is case insensitive" {
    const raw = "POST / HTTP/1.1\r\ncOnTeNt-LeNgTh: 7\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqual(@as(usize, 7), h.content_length);
}

test "content length trims surrounding whitespace and tabs" {
    const raw = "POST / HTTP/1.1\r\nContent-Length: \t 42 \t\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqual(@as(usize, 42), h.content_length);
}

test "content length zero is valid" {
    const raw = "POST / HTTP/1.1\r\nContent-Length: 0\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqual(@as(usize, 0), h.content_length);
}

test "content length non numeric rejected" {
    const raw = "POST / HTTP/1.1\r\nContent-Length: abc\r\n\r\n";
    try std.testing.expectError(error.BadRequest, parse(raw[0..findHeadEnd(raw, 0).?], 128));
}

test "content length empty value rejected" {
    const raw = "POST / HTTP/1.1\r\nContent-Length:\r\n\r\n";
    try std.testing.expectError(error.BadRequest, parse(raw[0..findHeadEnd(raw, 0).?], 128));
}

test "content length negative rejected" {
    const raw = "POST / HTTP/1.1\r\nContent-Length: -5\r\n\r\n";
    try std.testing.expectError(error.BadRequest, parse(raw[0..findHeadEnd(raw, 0).?], 128));
}

test "content length overflow rejected" {
    const raw = "POST / HTTP/1.1\r\nContent-Length: 99999999999999999999999999999999\r\n\r\n";
    try std.testing.expectError(error.BadRequest, parse(raw[0..findHeadEnd(raw, 0).?], 128));
}

test "content length max usize parsed" {
    const max_str = std.fmt.comptimePrint("{d}", .{std.math.maxInt(usize)});
    const raw = "POST / HTTP/1.1\r\nContent-Length: " ++ max_str ++ "\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqual(@as(usize, std.math.maxInt(usize)), h.content_length);
}

// Connection / keep-alive semantics

test "connection keep-alive on 1.1 stays alive" {
    const raw = "GET / HTTP/1.1\r\nConnection: keep-alive\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expect(h.keep_alive);
}

test "connection close case insensitive value" {
    const raw = "GET / HTTP/1.1\r\nConnection: CLOSE\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expect(!h.keep_alive);
}

test "connection header name case insensitive" {
    const raw = "GET / HTTP/1.1\r\ncOnNeCtIoN: close\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expect(!h.keep_alive);
}

test "connection comma list close wins" {
    const raw = "GET / HTTP/1.0\r\nConnection: keep-alive, close\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expect(!h.keep_alive);
}

test "connection comma list keep-alive enables on 1.0" {
    const raw = "GET / HTTP/1.0\r\nConnection: keep-alive, foo\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expect(h.keep_alive);
}

test "connection unknown token leaves default 1.1" {
    const raw = "GET / HTTP/1.1\r\nConnection: upgrade\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expect(h.keep_alive);
}

test "connection unknown token leaves default 1.0 closed" {
    const raw = "GET / HTTP/1.0\r\nConnection: upgrade\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expect(!h.keep_alive);
}

test "connection token padded with spaces matched" {
    const raw = "GET / HTTP/1.1\r\nConnection:   close  \r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expect(!h.keep_alive);
}

// Accept-Encoding / If-None-Match

test "accept encoding captured trimmed" {
    const raw = "GET / HTTP/1.1\r\nAccept-Encoding:  gzip, br \r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expect(h.accept_encoding != null);
    try std.testing.expectEqualStrings("gzip, br", h.accept_encoding.?);
}

test "accept encoding name case insensitive" {
    const raw = "GET / HTTP/1.1\r\nACCEPT-ENCODING: identity\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqualStrings("identity", h.accept_encoding.?);
}

test "if none match captured with quotes" {
    const raw = "GET / HTTP/1.1\r\nIf-None-Match: \"abc123\"\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expect(h.if_none_match != null);
    try std.testing.expectEqualStrings("\"abc123\"", h.if_none_match.?);
}

test "if none match name case insensitive" {
    const raw = "GET / HTTP/1.1\r\nif-none-match: W/\"v2\"\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqualStrings("W/\"v2\"", h.if_none_match.?);
}

test "absent conditional headers are null" {
    const raw = "GET / HTTP/1.1\r\nHost: x\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expect(h.if_none_match == null);
    try std.testing.expect(h.accept_encoding == null);
}

// Combined / realistic & whitespace oddities

test "full realistic request all fields" {
    const raw =
        "POST /api/v1/items?sort=desc HTTP/1.1\r\n" ++
        "Host: example.com\r\n" ++
        "Content-Length: 27\r\n" ++
        "Connection: keep-alive\r\n" ++
        "Accept-Encoding: gzip, deflate, br\r\n" ++
        "If-None-Match: \"etag-xyz\"\r\n" ++
        "User-Agent: test/1.0\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqualStrings("POST", h.method);
    try std.testing.expectEqualStrings("/api/v1/items", h.path);
    try std.testing.expectEqualStrings("sort=desc", h.query);
    try std.testing.expectEqual(@as(u8, 1), h.version);
    try std.testing.expectEqual(@as(usize, 27), h.content_length);
    try std.testing.expect(h.keep_alive);
    try std.testing.expectEqualStrings("gzip, deflate, br", h.accept_encoding.?);
    try std.testing.expectEqualStrings("\"etag-xyz\"", h.if_none_match.?);
    try std.testing.expectEqual(@as(usize, raw.len), h.head_end);
}

test "header value with internal spaces preserved after trim" {
    const raw = "GET / HTTP/1.1\r\nAccept-Encoding:gzip ,  br\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqualStrings("gzip ,  br", h.accept_encoding.?);
}

test "header value with only spaces trims to empty" {
    const raw = "GET / HTTP/1.1\r\nAccept-Encoding:    \r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqualStrings("", h.accept_encoding.?);
}

test "colon in header value not a delimiter" {
    const raw = "GET / HTTP/1.1\r\nIf-None-Match: a:b:c\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqualStrings("a:b:c", h.if_none_match.?);
}

test "conflicting Content-Length headers are rejected (smuggling)" {
    // RFC 9112 §6.3: two differing Content-Length values must be a hard error
    const raw = "POST / HTTP/1.1\r\nContent-Length: 0\r\nContent-Length: 13\r\n\r\n";
    try std.testing.expectError(error.BadRequest, parse(raw[0..findHeadEnd(raw, 0).?], 128));
}

test "identical duplicate Content-Length is accepted" {
    const raw = "POST / HTTP/1.1\r\nContent-Length: 7\r\nContent-Length: 7\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], 128);
    try std.testing.expectEqual(@as(usize, 7), h.content_length);
}

// parse: structural / truncation failures the parser must survive

test "parse empty slice rejected" {
    try std.testing.expectError(error.BadRequest, parse("", 128));
}

test "parse no CRLF anywhere rejected" {
    try std.testing.expectError(error.BadRequest, parse("GET / HTTP/1.1", 128));
}

test "parse request line without trailing headers section rejected" {
    // buf "GET / HTTP/1.1\r\n" : headers_start past end-2 check fails
    try std.testing.expectError(error.BadRequest, parse("GET / HTTP/1.1\r\n", 128));
}

test "parse bare terminator only rejected" {
    // "\r\n\r\n" -> line is empty, no space in line
    try std.testing.expectError(error.BadRequest, parse("\r\n\r\n", 128));
}

test "parse round trips with findHeadEnd slice" {
    const raw = "GET /p HTTP/1.1\r\nHost: h\r\n\r\n";
    const end = findHeadEnd(raw, 0).?;
    const h = try parse(raw[0..end], 128);
    try std.testing.expectEqual(end, h.head_end);
    try std.testing.expectEqualStrings("/p", h.path);
}

test "high max_headers does not overflow" {
    const raw = "GET / HTTP/1.1\r\nA: 1\r\n\r\n";
    const h = try parse(raw[0..findHeadEnd(raw, 0).?], std.math.maxInt(usize));
    try std.testing.expectEqualStrings("A: 1\r\n", h.raw_headers);
}

test "transfer-encoding is rejected (no chunked framing as body, no TE/CL smuggling)" {
    const raw = "POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n";
    try std.testing.expectError(error.BadRequest, parse(raw[0..findHeadEnd(raw, 0).?], 128));
}

// Allocation-backed input: ensure no aliasing/leak assumptions with allocator

test "parse over heap buffer slices stay valid" {
    const raw = "GET /alloc?x=1 HTTP/1.1\r\nContent-Length: 3\r\nConnection: close\r\n\r\n";
    const buf = try std.testing.allocator.dupe(u8, raw);
    defer std.testing.allocator.free(buf);
    const end = findHeadEnd(buf, 0).?;
    const h = try parse(buf[0..end], 128);
    try std.testing.expectEqualStrings("GET", h.method);
    try std.testing.expectEqualStrings("/alloc", h.path);
    try std.testing.expectEqualStrings("x=1", h.query);
    try std.testing.expectEqual(@as(usize, 3), h.content_length);
    try std.testing.expect(!h.keep_alive);
    // slices must point inside buf
    try std.testing.expect(@intFromPtr(h.method.ptr) >= @intFromPtr(buf.ptr));
    try std.testing.expect(@intFromPtr(h.method.ptr) < @intFromPtr(buf.ptr) + buf.len);
}

test "parse many headers over heap buffer no leak" {
    var list: std.ArrayList(u8) = .empty;
    defer list.deinit(std.testing.allocator);
    try list.appendSlice(std.testing.allocator, "GET / HTTP/1.1\r\n");
    var i: usize = 0;
    while (i < 50) : (i += 1) {
        try list.appendSlice(std.testing.allocator, "X-H: v\r\n");
    }
    try list.appendSlice(std.testing.allocator, "\r\n");
    const end = findHeadEnd(list.items, 0).?;
    const h = try parse(list.items[0..end], 128);
    try std.testing.expectEqualStrings("GET", h.method);
    try std.testing.expectEqual(@as(u8, 1), h.version);
}
