//! A minimal HTTP/1.1 server tuned for the native fast-path. Connections are
//! parsed with `httparse` (no per-request header allocation); a native route is
//! answered by writing its pre-rendered buffer straight to the socket. Only
//! routes without a native responder allocate and cross into JavaScript.
//!
//! [`serve_connection`] is generic over the byte stream, so plain TCP, TLS, and
//! Unix streams share one path; the accept loop and per-listener setup live in
//! [`crate::server`].

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::{Buf, Bytes, BytesMut};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::convert::{self, ErrorResponse, HttpHeader, HttpRequest, Param, ParsedForm};
use crate::meta::{self, RouteMatch};
use crate::server::{Dispatch, ServerState};

/// Compile-time ceiling on headers parsed per request, sizing the on-stack
/// `httparse` array. The runtime `max_headers` limit is enforced within this.
pub const HEADER_SLOTS: usize = 128;

const HEAD_TERMINATOR: &[u8; 4] = b"\r\n\r\n";

/// RAII guard over the shared live-connection counter. Increments at construction
/// and decrements at drop, so the count stays correct even if a connection task
/// panics or returns early; reaching zero is what graceful shutdown waits on.
pub struct ConnGuard {
    count: Arc<AtomicUsize>,
}

impl ConnGuard {
    pub fn new(count: Arc<AtomicUsize>) -> Self {
        count.fetch_add(1, Ordering::AcqRel);
        Self { count }
    }
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.count.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Drive a single keep-alive connection over any byte stream: parse a request,
/// answer it, repeat until the peer closes or asks to, an error occurs, or a read
/// times out. The native fast-path writes a pre-rendered response borrowed from
/// [`ServerState`] with no per-request allocation.
pub async fn serve_connection<S>(mut stream: S, state: Arc<ServerState>) -> std::io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let limits = state.limits();
    let mut buf = BytesMut::with_capacity(limits.read_buffer_bytes);

    loop {
        // Resume offset for the end-of-head scan. Carrying it across the reads
        // that assemble one head keeps detection linear in bytes read. Reset per
        // request: pipelined bytes belong to the next head and are unscanned.
        let mut scan_from = 0usize;

        // The in-loop size check bounds a head that never terminates. It cannot
        // catch a head that arrives complete in one read (the terminator is found
        // and the loop breaks first), so the size is re-checked below once the
        // terminated head's length is known.
        let head_end = loop {
            if let Some(pos) = find_head_end(&buf, &mut scan_from) {
                break pos;
            }
            if buf.len() > limits.max_header_bytes {
                let _ = write_error(&mut stream, ErrorResponse::BadRequest, &state).await;
                return Ok(());
            }
            if read_with_timeout(&mut stream, &mut buf, limits.read_timeout).await? == 0 {
                return Ok(()); // clean EOF between requests, or a truncated head
            }
        };

        if head_end > limits.max_header_bytes {
            let _ = write_error(&mut stream, ErrorResponse::BadRequest, &state).await;
            return Ok(());
        }

        // Scoped so the parse's borrow on `buf` ends before the body read needs
        // `&mut buf`. A native hit borrows its response and allocates nothing.
        let routed = match route(&buf[..head_end], &state, limits.max_headers) {
            Some(routed) => routed,
            None => {
                let _ = write_error(&mut stream, ErrorResponse::BadRequest, &state).await;
                return Ok(());
            }
        };

        let content_length = routed.content_length();
        let keep_alive = routed.keep_alive();
        if content_length > limits.max_body_bytes {
            // 413 (not 400) for an over-limit body, matching the multipart
            // size-rejection path. Header-count/byte overflows stay 400.
            let _ = write_error(&mut stream, ErrorResponse::PayloadTooLarge, &state).await;
            return Ok(());
        }
        let total = head_end + content_length;

        // Buffer the full body, required for keep-alive framing even on the native
        // path where the body is then discarded.
        while buf.len() < total {
            if read_with_timeout(&mut stream, &mut buf, limits.read_timeout).await? == 0 {
                return Ok(());
            }
        }

        match routed {
            Routed::Native { response, .. } => {
                stream.write_all(response).await?;
            }
            Routed::Static {
                method,
                path,
                if_none_match,
                range,
                encoding,
                ..
            } => {
                let outcome = crate::static_files::serve(
                    &method,
                    &path,
                    if_none_match.as_deref(),
                    range.as_deref(),
                    encoding,
                    state.static_mounts(),
                    state.response_defaults(),
                )
                .await;
                match outcome {
                    crate::static_files::StaticOutcome::Response(bytes) => {
                        stream.write_all(&bytes).await?;
                    }
                    // A matched prefix but unresolvable file already yields a 404
                    // inside `serve`; routing only produces `Static` on a prefix
                    // match, so `NotMounted` cannot occur here.
                    crate::static_files::StaticOutcome::NotMounted => {
                        write_error(&mut stream, ErrorResponse::NotFound, &state).await?;
                    }
                }
            }
            Routed::NotFound { .. } => {
                write_error(&mut stream, ErrorResponse::NotFound, &state).await?;
            }
            Routed::MethodNotAllowed { allow, .. } => {
                write_error(&mut stream, ErrorResponse::MethodNotAllowed(allow), &state).await?;
            }
            Routed::Dynamic { head, encoding, .. } => {
                // The only place the body is allocated.
                let body = if content_length > 0 {
                    Some(Bytes::copy_from_slice(&buf[head_end..total]))
                } else {
                    None
                };

                let mut form = None;
                if let (Some(config), Some(body)) = (state.form_config(), body.as_ref()) {
                    if let Some(content_type) = head.content_type.as_deref() {
                        match crate::forms::parse(content_type, body, config).await {
                            crate::forms::FormOutcome::Parsed(parsed) => form = Some(parsed),
                            crate::forms::FormOutcome::NotForm => {}
                            // A rejection (400/413/415/500) is answered natively,
                            // rendered here with the response defaults so it too
                            // carries X-Powered-By and any user default headers.
                            crate::forms::FormOutcome::Reject(error) => {
                                write_error(&mut stream, error, &state).await?;
                                buf.advance(total);
                                if !keep_alive {
                                    return Ok(());
                                }
                                continue;
                            }
                        }
                    }
                }

                let bytes = dispatch_to_js(
                    state.dispatch(),
                    head,
                    body,
                    form,
                    encoding,
                    state.response_defaults(),
                )
                .await;
                stream.write_all(&bytes).await?;
            }
        }

        buf.advance(total);

        if !keep_alive {
            return Ok(());
        }
    }
}

/// Write a native error response with the server's default headers applied.
async fn write_error<S>(
    stream: &mut S,
    error: ErrorResponse,
    state: &ServerState,
) -> std::io::Result<()>
where
    S: AsyncWrite + Unpin,
{
    let bytes = error.render(state.response_defaults());
    stream.write_all(&bytes).await
}

/// Read more bytes into `buf`. A non-zero `read_timeout` bounds the read so a
/// stall fails the connection, guarding against slow-loris and idle-fd
/// exhaustion. Returns the number of bytes read (0 on EOF).
async fn read_with_timeout<S>(
    stream: &mut S,
    buf: &mut BytesMut,
    read_timeout: Duration,
) -> std::io::Result<usize>
where
    S: AsyncRead + Unpin,
{
    if read_timeout.is_zero() {
        return stream.read_buf(buf).await;
    }
    match tokio::time::timeout(read_timeout, stream.read_buf(buf)).await {
        Ok(result) => result,
        Err(_elapsed) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "read timed out",
        )),
    }
}

/// Call the JavaScript handler and serialize its response. Never fails the
/// connection — a crossing error becomes a 500. The raw `body` is passed through
/// alongside any parsed `form` so handlers that ignore `form` see it unchanged.
async fn dispatch_to_js(
    dispatch: &Dispatch,
    head: OwnedHead,
    body: Option<Bytes>,
    form: Option<ParsedForm>,
    encoding: crate::compress::Encoding,
    defaults: &crate::server::ResponseDefaults,
) -> Vec<u8> {
    let request = HttpRequest {
        method: head.method,
        path: head.path,
        query: head.query,
        headers: head.headers,
        body: body.map(|bytes| bytes.to_vec().into()),
        form,
        route_index: head.route_index,
        params: head.params,
        query_pairs: head.query_pairs,
        cookies: head.cookies,
        // Generated at the dispatch boundary, so the fast path and natively
        // answered misses never pay for it.
        request_id: meta::generate_request_id(),
    };

    // A crossing or handler error becomes a 500 carrying the response defaults,
    // so even the failure path emits X-Powered-By and any user default headers.
    match dispatch.call_async(Ok(request)).await {
        Ok(pending) => match pending.await {
            Ok(response) => convert::serialize_response(response, encoding, defaults),
            Err(_) => ErrorResponse::InternalError.render(defaults),
        },
        Err(_) => ErrorResponse::InternalError.render(defaults),
    }
}

/// The owned head of a request bound for a JavaScript handler, enriched with the
/// metadata parsed natively during routing.
struct OwnedHead {
    method: String,
    path: String,
    query: String,
    headers: Vec<HttpHeader>,
    /// `Content-Type` value, captured during routing so the dynamic path can
    /// decide whether to attempt form parsing without rescanning headers.
    content_type: Option<String>,
    route_index: i32,
    params: Vec<Param>,
    query_pairs: Vec<Param>,
    cookies: Vec<Param>,
}

/// The outcome of routing a parsed head. Every variant carries the framing facts
/// (`content_length`, `keep_alive`) the loop needs to consume the body and honor
/// keep-alive, even when the response is fixed and the body is discarded.
enum Routed<'a> {
    /// An exact route-table hit, answered from pre-rendered bytes borrowed from
    /// shared state — the fast path, allocation-free.
    Native {
        response: &'a Bytes,
        content_length: usize,
        keep_alive: bool,
    },
    /// A path matching a static mount's prefix. The file read and response
    /// assembly happen in the loop, off the `buf` borrow.
    Static {
        method: String,
        path: String,
        if_none_match: Option<String>,
        range: Option<String>,
        encoding: crate::compress::Encoding,
        content_length: usize,
        keep_alive: bool,
    },
    NotFound {
        content_length: usize,
        keep_alive: bool,
    },
    MethodNotAllowed {
        allow: Vec<String>,
        content_length: usize,
        keep_alive: bool,
    },
    /// A dynamic-router match, with an owned head destined for the JS handler.
    Dynamic {
        head: OwnedHead,
        encoding: crate::compress::Encoding,
        content_length: usize,
        keep_alive: bool,
    },
}

impl Routed<'_> {
    fn content_length(&self) -> usize {
        match self {
            Routed::Native { content_length, .. }
            | Routed::Static { content_length, .. }
            | Routed::NotFound { content_length, .. }
            | Routed::MethodNotAllowed { content_length, .. }
            | Routed::Dynamic { content_length, .. } => *content_length,
        }
    }

    fn keep_alive(&self) -> bool {
        match self {
            Routed::Native { keep_alive, .. }
            | Routed::Static { keep_alive, .. }
            | Routed::NotFound { keep_alive, .. }
            | Routed::MethodNotAllowed { keep_alive, .. }
            | Routed::Dynamic { keep_alive, .. } => *keep_alive,
        }
    }
}

/// Parse the head and decide how to answer it. Owned data is built only for the
/// dynamic (JavaScript) path; native hits stay allocation-free. A request with
/// more than `max_headers` headers is rejected (`None`).
fn route<'a>(head: &[u8], state: &'a ServerState, max_headers: usize) -> Option<Routed<'a>> {
    let mut headers = [httparse::EMPTY_HEADER; HEADER_SLOTS];
    let mut request = httparse::Request::new(&mut headers);
    if request.parse(head).ok()?.is_partial() {
        return None;
    }
    if request.headers.len() > max_headers {
        return None;
    }

    let method = request.method?;
    let target = request.path?;
    let version = request.version?; // 0 => HTTP/1.0, 1 => HTTP/1.1
    let (path, query) = target.split_once('?').unwrap_or((target, ""));

    let mut content_length = 0usize;
    let mut conn_close = false;
    let mut conn_keep_alive = false;
    // All borrowed from the parse; converted to owned only on the static/dynamic
    // paths that need them, so the fast path never allocates here.
    let mut content_type: Option<&[u8]> = None;
    let mut cookie_header: Option<&[u8]> = None;
    let mut accept_encoding: Option<&[u8]> = None;
    let mut if_none_match: Option<&[u8]> = None;
    let mut range_header: Option<&[u8]> = None;
    for header in request.headers.iter() {
        if header.name.eq_ignore_ascii_case("content-length") {
            content_length = std::str::from_utf8(header.value)
                .ok()
                .and_then(|value| value.trim().parse().ok())
                .unwrap_or(0);
        } else if header.name.eq_ignore_ascii_case("connection") {
            if header.value.eq_ignore_ascii_case(b"close") {
                conn_close = true;
            } else if header.value.eq_ignore_ascii_case(b"keep-alive") {
                conn_keep_alive = true;
            }
        } else if header.name.eq_ignore_ascii_case("content-type") {
            content_type = Some(header.value);
        } else if header.name.eq_ignore_ascii_case("cookie") {
            cookie_header = Some(header.value);
        } else if header.name.eq_ignore_ascii_case("accept-encoding") {
            accept_encoding = Some(header.value);
        } else if header.name.eq_ignore_ascii_case("if-none-match") {
            if_none_match = Some(header.value);
        } else if header.name.eq_ignore_ascii_case("range") {
            range_header = Some(header.value);
        }
    }
    let encoding = if state.response_defaults().compression {
        crate::compress::negotiate(accept_encoding.map(String::from_utf8_lossy).as_deref())
    } else {
        crate::compress::Encoding::Identity
    };
    // HTTP/1.1 keeps alive unless told to close; HTTP/1.0 is the reverse and only
    // persists when the peer opts in.
    let keep_alive = if version == 1 {
        !conn_close
    } else {
        conn_keep_alive
    };

    // Fast path: an exact hit serves pre-rendered bytes with no allocation,
    // preferring a pre-compressed variant for the negotiated encoding if one
    // exists (still a borrowed write).
    if let Some(response) = state.lookup(method, path) {
        let response = state
            .lookup_compressed(method, path, encoding)
            .unwrap_or(response);
        return Some(Routed::Native {
            response,
            content_length,
            keep_alive,
        });
    }

    // Static mounts, checked before the dynamic router via a cheap prefix test
    // (no filesystem access). Owned data is built only on a prefix match.
    if !state.static_mounts().is_empty()
        && state
            .static_mounts()
            .iter()
            .any(|mount| mount.matches_path(path))
    {
        return Some(Routed::Static {
            method: method.to_owned(),
            path: path.to_owned(),
            if_none_match: if_none_match.map(|v| String::from_utf8_lossy(v).into_owned()),
            range: range_header.map(|v| String::from_utf8_lossy(v).into_owned()),
            encoding,
            content_length,
            keep_alive,
        });
    }

    let (route_index, params) = match state.dynamic_router().resolve(method, path) {
        RouteMatch::Matched { index, params } => (index, params),
        RouteMatch::NotFound => {
            return Some(Routed::NotFound {
                content_length,
                keep_alive,
            });
        }
        RouteMatch::MethodNotAllowed { allow } => {
            return Some(Routed::MethodNotAllowed {
                allow,
                content_length,
                keep_alive,
            });
        }
    };

    // Only now, on a confirmed dynamic match, is owned data built.
    let mut collected = Vec::with_capacity(request.headers.len());
    for header in request.headers.iter() {
        collected.push(HttpHeader {
            name: header.name.to_owned(),
            value: String::from_utf8_lossy(header.value).into_owned(),
        });
    }

    let query_pairs = meta::parse_query(query);
    let cookies = cookie_header
        .map(|value| meta::parse_cookies(&String::from_utf8_lossy(value)))
        .unwrap_or_default();

    Some(Routed::Dynamic {
        head: OwnedHead {
            method: method.to_owned(),
            path: path.to_owned(),
            query: query.to_owned(),
            headers: collected,
            content_type: content_type.map(|value| String::from_utf8_lossy(value).into_owned()),
            // matchit indices fit in i32 for any realistic route count; the
            // saturating cast keeps a pathological count from wrapping negative.
            route_index: route_index.min(i32::MAX as usize) as i32,
            params,
            query_pairs,
            cookies,
        },
        encoding,
        content_length,
        keep_alive,
    })
}

/// Find the byte index just past the `\r\n\r\n` that ends the request head,
/// scanning only bytes added since the last call. `scan_from` is the resume
/// offset; the scan starts three bytes earlier to catch a terminator straddling a
/// read boundary, and is advanced to the last position that could not yet have
/// completed a terminator, keeping repeated calls linear in total bytes.
fn find_head_end(buf: &[u8], scan_from: &mut usize) -> Option<usize> {
    let start = scan_from.saturating_sub(HEAD_TERMINATOR.len() - 1);
    if let Some(rel) = buf[start..]
        .windows(HEAD_TERMINATOR.len())
        .position(|window| window == HEAD_TERMINATOR)
    {
        return Some(start + rel + HEAD_TERMINATOR.len());
    }
    *scan_from = buf.len();
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_terminator_in_a_single_buffer() {
        let buf = b"GET / HTTP/1.1\r\nHost: x\r\n\r\n";
        let mut scan_from = 0;
        assert_eq!(find_head_end(buf, &mut scan_from), Some(buf.len()));
    }

    #[test]
    fn returns_none_until_terminator_arrives() {
        let mut scan_from = 0;
        assert_eq!(find_head_end(b"GET / HTTP/1.1\r\n", &mut scan_from), None);
        // The resume offset advanced past the scanned bytes.
        assert!(scan_from > 0);
    }

    #[test]
    fn detects_terminator_split_across_reads() {
        // The terminator straddles the boundary between two reads: the first read
        // ends with "\r\n\r" and the next byte completes it.
        let mut buf = BytesMut::from(&b"HEAD /x HTTP/1.1\r\nA: b\r\n\r"[..]);
        let mut scan_from = 0;
        assert_eq!(find_head_end(&buf, &mut scan_from), None);
        let scanned = scan_from;
        buf.extend_from_slice(b"\n");
        assert_eq!(find_head_end(&buf, &mut scan_from), Some(buf.len()));
        // Backing up before the resume offset is what catches the split marker.
        assert!(scanned >= buf.len() - HEAD_TERMINATOR.len());
    }

    #[test]
    fn reports_position_just_past_terminator_with_trailing_body() {
        let buf = b"POST / HTTP/1.1\r\n\r\nBODYBODY";
        let head_end = find_head_end(buf, &mut 0).unwrap();
        assert_eq!(&buf[head_end..], b"BODYBODY");
        assert_eq!(&buf[head_end - 4..head_end], b"\r\n\r\n");
    }

    #[test]
    fn finds_first_terminator_when_body_contains_another() {
        // A blank line inside the body must not be mistaken for the head end.
        let buf = b"POST / HTTP/1.1\r\n\r\nline1\r\n\r\nline2";
        let head_end = find_head_end(buf, &mut 0).unwrap();
        assert_eq!(&buf[..head_end], b"POST / HTTP/1.1\r\n\r\n");
    }

    #[test]
    fn conn_guard_tracks_live_count() {
        let count = Arc::new(AtomicUsize::new(0));
        {
            let _g1 = ConnGuard::new(Arc::clone(&count));
            assert_eq!(count.load(Ordering::Acquire), 1);
            let _g2 = ConnGuard::new(Arc::clone(&count));
            assert_eq!(count.load(Ordering::Acquire), 2);
        }
        assert_eq!(count.load(Ordering::Acquire), 0);
    }
}
