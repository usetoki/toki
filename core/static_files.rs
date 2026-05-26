//! Native static-file serving for `GET`/`HEAD` under a configured URL prefix.
//! Fully handled in Rust — checked after the exact route table and before the
//! dynamic router (see [`crate::http`]); a static hit never crosses into JS. Path
//! resolution is traversal-safe: the remainder is sanitized and the canonicalized
//! file is verified to stay within the canonicalized mount directory.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use percent_encoding::percent_decode_str;

use crate::compress::{self, Encoding};
use crate::server::ResponseDefaults;

/// A resolved static mount: a URL prefix mapped to a filesystem directory, built
/// once at `listen` time and shared read-only.
pub struct StaticMountResolved {
    pub url_prefix: String,
    /// Canonicalized base directory; resolved files must stay within it. `None`
    /// when the directory was missing at startup, which disables the mount.
    pub canonical_dir: Option<PathBuf>,
    pub index_file: Option<String>,
    pub cache_control: String,
}

const DEFAULT_CACHE_CONTROL: &str = "public, max-age=3600";

impl StaticMountResolved {
    /// Resolve a [`crate::server::StaticMount`] into internal form, canonicalizing
    /// the directory once. A directory that cannot be canonicalized yields
    /// `canonical_dir: None` (serves nothing) rather than failing `listen`.
    pub fn resolve(mount: crate::server::StaticMount) -> Self {
        let canonical_dir = std::fs::canonicalize(&mount.dir).ok();
        let cache_control = mount
            .cache_control
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_CACHE_CONTROL.to_owned());
        Self {
            url_prefix: mount.url_prefix,
            canonical_dir,
            index_file: mount.index_file,
            cache_control,
        }
    }

    /// Whether `path` falls under this mount's prefix. The next character must be
    /// `/` (or the path equals the prefix), so `/static` does not match
    /// `/static-assets`. A cheap, filesystem-free test used by the router.
    pub fn matches_path(&self, path: &str) -> bool {
        let Some(rest) = path.strip_prefix(&self.url_prefix) else {
            return false;
        };
        rest.is_empty() || rest.starts_with('/')
    }
}

pub enum StaticOutcome {
    /// A complete HTTP/1.1 response (200/206/304/404/405/416); write it.
    Response(Vec<u8>),
    /// No mount matched; fall through to the dynamic router.
    NotMounted,
}

/// Try to serve `path` from the configured mounts.
///
/// Only `GET`/`HEAD` are served; a matched mount under any other method yields a
/// native `405`. A path matching no mount returns [`StaticOutcome::NotMounted`].
/// `encoding` is the negotiated `Accept-Encoding`; compressible files are
/// compressed per request when `defaults.compression` is on.
pub async fn serve(
    method: &str,
    path: &str,
    if_none_match: Option<&str>,
    range: Option<&str>,
    encoding: Encoding,
    mounts: &[StaticMountResolved],
    defaults: &ResponseDefaults,
) -> StaticOutcome {
    let Some(mount) = mounts.iter().find(|m| m.matches_path(path)) else {
        return StaticOutcome::NotMounted;
    };

    // A non-GET/HEAD method against a matched mount is a native 405, never a
    // fall-through, so static URLs never reach the dynamic router.
    let is_head = method == "HEAD";
    if method != "GET" && !is_head {
        return StaticOutcome::Response(method_not_allowed(defaults));
    }

    let Some(base) = mount.canonical_dir.as_ref() else {
        return StaticOutcome::Response(not_found(defaults));
    };

    let remainder = &path[mount.url_prefix.len()..];
    let Some(relative) = sanitize_relative(remainder) else {
        return StaticOutcome::Response(not_found(defaults));
    };
    let candidate = base.join(&relative);

    let resolved = match resolve_file(base, &candidate, mount.index_file.as_deref()).await {
        Some(resolved) => resolved,
        None => return StaticOutcome::Response(not_found(defaults)),
    };

    let metadata = match tokio::fs::metadata(&resolved).await {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => return StaticOutcome::Response(not_found(defaults)),
    };

    let file_len = metadata.len();
    let etag = compute_etag(file_len, metadata.modified().ok());

    if let Some(inm) = if_none_match {
        if etag_matches(inm, &etag) {
            return StaticOutcome::Response(not_modified(&etag, &mount.cache_control, defaults));
        }
    }

    let content_type = mime_for(&resolved);

    if let Some(range) = range {
        match parse_single_range(range, file_len) {
            RangeResult::Satisfiable { start, end } => {
                return serve_range(
                    &resolved,
                    start,
                    end,
                    file_len,
                    &content_type,
                    &etag,
                    &mount.cache_control,
                    is_head,
                    defaults,
                )
                .await;
            }
            RangeResult::Unsatisfiable => {
                return StaticOutcome::Response(range_not_satisfiable(file_len, defaults));
            }
            RangeResult::Ignore => {}
        }
    }

    // HEAD reads nothing; GET reads via tokio::fs (no in-memory cache).
    let body = if is_head {
        Vec::new()
    } else {
        match tokio::fs::read(&resolved).await {
            Ok(body) => body,
            Err(_) => return StaticOutcome::Response(not_found(defaults)),
        }
    };

    StaticOutcome::Response(build_ok(
        &content_type,
        &etag,
        &mount.cache_control,
        body,
        file_len,
        is_head,
        encoding,
        defaults,
    ))
}

/// Sanitize the URL remainder into a relative path that cannot escape the mount.
/// Each segment is percent-decoded then validated: empty and `.` are dropped,
/// `..` is rejected, and a separator or NUL after decoding is rejected. Returns
/// `None` (caller responds `404`) on any rejection.
///
/// This is the first traversal defense; [`resolve_file`] adds a canonical-prefix
/// check that also catches symlink escapes.
fn sanitize_relative(remainder: &str) -> Option<PathBuf> {
    let trimmed = remainder.strip_prefix('/').unwrap_or(remainder);

    let mut out = PathBuf::new();
    for raw_segment in trimmed.split('/') {
        if raw_segment.is_empty() {
            continue;
        }
        // Decode per segment so an encoded separator (`%2f`) cannot smuggle in a
        // new path component.
        let decoded = percent_decode_str(raw_segment).decode_utf8_lossy();
        let segment = decoded.as_ref();
        if segment == "." {
            continue;
        }
        if segment == ".." {
            return None;
        }
        if segment.contains('/') || segment.contains('\\') || segment.contains('\0') {
            return None;
        }
        out.push(segment);
    }
    Some(out)
}

/// Resolve `candidate` to a concrete file within `base`. Returns `None` (caller
/// responds `404`) when the file is missing, the canonical path escapes `base`
/// (symlink escape), or the candidate is a directory with no usable index file.
async fn resolve_file(base: &Path, candidate: &Path, index_file: Option<&str>) -> Option<PathBuf> {
    let canonical = tokio::fs::canonicalize(candidate).await.ok()?;
    if !canonical.starts_with(base) {
        return None;
    }

    let metadata = tokio::fs::metadata(&canonical).await.ok()?;
    if metadata.is_dir() {
        let index = index_file?;
        if index.contains('/') || index.contains('\\') || index == ".." {
            return None;
        }
        let index_path = canonical.join(index);
        let index_canonical = tokio::fs::canonicalize(&index_path).await.ok()?;
        if !index_canonical.starts_with(base) {
            return None;
        }
        let index_meta = tokio::fs::metadata(&index_canonical).await.ok()?;
        if !index_meta.is_file() {
            return None;
        }
        return Some(index_canonical);
    }

    Some(canonical)
}

/// Guess a `Content-Type` from the extension, defaulting to
/// `application/octet-stream`. A `charset=utf-8` is appended for text-like types
/// so browsers render them correctly.
fn mime_for(path: &Path) -> String {
    let guess = mime_guess::from_path(path).first_or_octet_stream();
    let essence = guess.essence_str();
    if essence.starts_with("text/")
        || essence == "application/json"
        || essence == "application/javascript"
        || essence == "image/svg+xml"
    {
        format!("{essence}; charset=utf-8")
    } else {
        essence.to_owned()
    }
}

/// A strong `ETag` from file length and mtime, so any size/mtime change
/// invalidates caches. Only the length is used when the mtime is unavailable.
fn compute_etag(len: u64, modified: Option<SystemTime>) -> String {
    let mtime = modified
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("\"{len:x}-{mtime:x}\"")
}

/// Whether an `If-None-Match` value matches our `ETag`. Handles `*`,
/// comma-separated lists, and a `W/` weak-validator prefix (our tag is
/// content-derived, so compared by the opaque tag).
fn etag_matches(if_none_match: &str, etag: &str) -> bool {
    let strong = etag.trim();
    if_none_match.split(',').any(|candidate| {
        let candidate = candidate.trim();
        candidate == "*" || candidate.strip_prefix("W/").unwrap_or(candidate) == strong
    })
}

enum RangeResult {
    Satisfiable {
        start: u64,
        end: u64,
    },
    /// A valid byte range entirely beyond the file — answer `416`.
    Unsatisfiable,
    /// Not a single `bytes=` range we handle; serve the full file.
    Ignore,
}

/// Parse a single-range `Range: bytes=` header. Supports `bytes=a-b`, `bytes=a-`,
/// and `bytes=-n`. Multi-range, other units, and malformed syntax yield `Ignore`;
/// a well-formed range at or past the end is `Unsatisfiable`.
fn parse_single_range(header: &str, file_len: u64) -> RangeResult {
    let Some(spec) = header.trim().strip_prefix("bytes=") else {
        return RangeResult::Ignore;
    };
    let spec = spec.trim();
    if spec.contains(',') {
        return RangeResult::Ignore;
    }
    let Some((start_str, end_str)) = spec.split_once('-') else {
        return RangeResult::Ignore;
    };
    let start_str = start_str.trim();
    let end_str = end_str.trim();

    if file_len == 0 {
        return RangeResult::Unsatisfiable;
    }

    match (start_str.is_empty(), end_str.is_empty()) {
        // `bytes=-n`: the final n bytes.
        (true, false) => {
            let Ok(n) = end_str.parse::<u64>() else {
                return RangeResult::Ignore;
            };
            if n == 0 {
                return RangeResult::Unsatisfiable;
            }
            let n = n.min(file_len);
            RangeResult::Satisfiable {
                start: file_len - n,
                end: file_len - 1,
            }
        }
        // `bytes=a-`: from a to the end.
        (false, true) => {
            let Ok(start) = start_str.parse::<u64>() else {
                return RangeResult::Ignore;
            };
            if start >= file_len {
                return RangeResult::Unsatisfiable;
            }
            RangeResult::Satisfiable {
                start,
                end: file_len - 1,
            }
        }
        // `bytes=a-b`: a closed range, clamped to the file end.
        (false, false) => {
            let (Ok(start), Ok(end)) = (start_str.parse::<u64>(), end_str.parse::<u64>()) else {
                return RangeResult::Ignore;
            };
            if start > end || start >= file_len {
                return RangeResult::Unsatisfiable;
            }
            RangeResult::Satisfiable {
                start,
                end: end.min(file_len - 1),
            }
        }
        (true, true) => RangeResult::Ignore,
    }
}

/// Serve a single byte range as `206 Partial Content`. Compression is not applied
/// to ranged responses (the range is over the identity representation). A read
/// error treats the file as gone (`404`).
#[allow(clippy::too_many_arguments)]
async fn serve_range(
    path: &Path,
    start: u64,
    end: u64,
    file_len: u64,
    content_type: &str,
    etag: &str,
    cache_control: &str,
    is_head: bool,
    defaults: &ResponseDefaults,
) -> StaticOutcome {
    let length = end - start + 1;

    let body = if is_head {
        Vec::new()
    } else {
        match read_range(path, start, length).await {
            Ok(body) => body,
            Err(_) => return StaticOutcome::Response(not_found(defaults)),
        }
    };

    let content_range = format!("bytes {start}-{end}/{file_len}");
    let mut builder = ResponseBuilder::new(206, content_type);
    builder.header("ETag", etag);
    builder.header("Cache-Control", cache_control);
    builder.header("Accept-Ranges", "bytes");
    builder.header("Content-Range", &content_range);
    apply_defaults(&mut builder, defaults);
    StaticOutcome::Response(builder.finish(body, length as usize, is_head))
}

/// Read `length` bytes at byte `start`. A seek + bounded read avoids loading the
/// whole file for a range over a large file.
async fn read_range(path: &Path, start: u64, length: u64) -> std::io::Result<Vec<u8>> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};

    let mut file = tokio::fs::File::open(path).await?;
    file.seek(SeekFrom::Start(start)).await?;
    let mut buf = vec![0u8; length as usize];
    file.read_exact(&mut buf).await?;
    Ok(buf)
}

/// Build a `200 OK` full-body response, compressing when enabled and the type is
/// compressible. A compressed response carries `Content-Encoding` /
/// `Vary: Accept-Encoding` and drops range support (the range would apply to the
/// encoded bytes); otherwise the identity body is sent with `Accept-Ranges`.
#[allow(clippy::too_many_arguments)]
fn build_ok(
    content_type: &str,
    etag: &str,
    cache_control: &str,
    body: Vec<u8>,
    identity_len: u64,
    is_head: bool,
    encoding: Encoding,
    defaults: &ResponseDefaults,
) -> Vec<u8> {
    let mut builder = ResponseBuilder::new(200, content_type);
    builder.header("ETag", etag);
    builder.header("Cache-Control", cache_control);

    // HEAD has no body to compress; it advertises identity framing with the real
    // file length and keeps range support.
    let compressed = match encoding.token() {
        Some(token)
            if !is_head
                && defaults.compression
                && body.len() >= defaults.compression_min_size
                && compress::is_compressible(content_type) =>
        {
            compress::compress(&body, encoding, defaults.compression_levels).map(|out| (out, token))
        }
        _ => None,
    };

    match compressed {
        Some((compressed, token)) => {
            builder.header("Content-Encoding", token);
            builder.header("Vary", "Accept-Encoding");
            let len = compressed.len();
            apply_defaults(&mut builder, defaults);
            builder.finish(compressed, len, false)
        }
        None => {
            builder.header("Accept-Ranges", "bytes");
            // HEAD advertises the real file length though it sends no body.
            let len = if is_head {
                identity_len as usize
            } else {
                body.len()
            };
            apply_defaults(&mut builder, defaults);
            builder.finish(body, len, is_head)
        }
    }
}

/// A `304 Not Modified` carrying the validators a cache needs. No body.
fn not_modified(etag: &str, cache_control: &str, defaults: &ResponseDefaults) -> Vec<u8> {
    let mut builder = ResponseBuilder::new_bodyless(304);
    builder.header("ETag", etag);
    builder.header("Cache-Control", cache_control);
    apply_defaults(&mut builder, defaults);
    builder.finish(Vec::new(), 0, true)
}

fn not_found(defaults: &ResponseDefaults) -> Vec<u8> {
    const BODY: &[u8] = b"Not Found";
    let mut builder = ResponseBuilder::new(404, "text/plain; charset=utf-8");
    apply_defaults(&mut builder, defaults);
    builder.finish(BODY.to_vec(), BODY.len(), false)
}

fn method_not_allowed(defaults: &ResponseDefaults) -> Vec<u8> {
    const BODY: &[u8] = b"Method Not Allowed";
    let mut builder = ResponseBuilder::new(405, "text/plain; charset=utf-8");
    builder.header("Allow", "GET, HEAD");
    apply_defaults(&mut builder, defaults);
    builder.finish(BODY.to_vec(), BODY.len(), false)
}

/// A `416 Range Not Satisfiable`, advertising the full length via
/// `Content-Range: bytes */len` per RFC 7233.
fn range_not_satisfiable(file_len: u64, defaults: &ResponseDefaults) -> Vec<u8> {
    const BODY: &[u8] = b"Range Not Satisfiable";
    let content_range = format!("bytes */{file_len}");
    let mut builder = ResponseBuilder::new(416, "text/plain; charset=utf-8");
    builder.header("Content-Range", &content_range);
    builder.header("Accept-Ranges", "bytes");
    apply_defaults(&mut builder, defaults);
    builder.finish(BODY.to_vec(), BODY.len(), false)
}

/// Inject configured default headers, skipping any name already present (the
/// response's own headers win).
fn apply_defaults(builder: &mut ResponseBuilder, defaults: &ResponseDefaults) {
    for header in &defaults.default_headers {
        if !builder.has_header(&header.name) {
            builder.header(&header.name, &header.value);
        }
    }
}

/// Incrementally assembles an HTTP/1.1 response: status line, ordered headers,
/// then body with a computed `Content-Length`. Header names are tracked so
/// [`ResponseBuilder::has_header`] prevents duplicate default injection.
struct ResponseBuilder {
    head: Vec<u8>,
    names: Vec<String>,
    /// Whether this status carries a `Content-Length` line at all (304 does not).
    bodyless: bool,
}

impl ResponseBuilder {
    fn new(status: u16, content_type: &str) -> Self {
        let mut builder = Self::start(status);
        builder.header("Content-Type", content_type);
        builder
    }

    fn new_bodyless(status: u16) -> Self {
        let mut builder = Self::start(status);
        builder.bodyless = true;
        builder
    }

    fn start(status: u16) -> Self {
        let mut head = Vec::with_capacity(256);
        head.extend_from_slice(b"HTTP/1.1 ");
        head.extend_from_slice(status.to_string().as_bytes());
        head.push(b' ');
        head.extend_from_slice(reason(status).as_bytes());
        head.extend_from_slice(b"\r\n");
        Self {
            head,
            names: Vec::new(),
            bodyless: false,
        }
    }

    fn has_header(&self, name: &str) -> bool {
        let lower = name.to_ascii_lowercase();
        self.names.contains(&lower)
    }

    fn header(&mut self, name: &str, value: &str) {
        self.head.extend_from_slice(name.as_bytes());
        self.head.extend_from_slice(b": ");
        self.head.extend_from_slice(value.as_bytes());
        self.head.extend_from_slice(b"\r\n");
        self.names.push(name.to_ascii_lowercase());
    }

    /// Emit `Content-Length`, the blank line, and the body. `omit_body` (HEAD or a
    /// bodyless status) suppresses the body bytes but keeps `Content-Length`.
    fn finish(mut self, body: Vec<u8>, content_length: usize, omit_body: bool) -> Vec<u8> {
        if !self.bodyless {
            self.head.extend_from_slice(b"Content-Length: ");
            self.head
                .extend_from_slice(content_length.to_string().as_bytes());
            self.head.extend_from_slice(b"\r\n");
        }
        self.head.extend_from_slice(b"\r\n");
        if !omit_body {
            self.head.extend_from_slice(&body);
        }
        self.head
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        206 => "Partial Content",
        304 => "Not Modified",
        404 => "Not Found",
        405 => "Method Not Allowed",
        416 => "Range Not Satisfiable",
        _ => "Status",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compress::CompressionLevels;
    use crate::convert::HttpHeader;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn no_defaults() -> ResponseDefaults {
        ResponseDefaults {
            compression: false,
            compression_min_size: 1024,
            default_headers: Vec::new(),
            compression_levels: CompressionLevels::default(),
        }
    }

    fn parse_head(bytes: &[u8]) -> (String, Vec<(String, String)>) {
        let split = bytes.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&bytes[..split]);
        let mut lines = head.split("\r\n");
        let status = lines.next().unwrap().to_owned();
        let headers = lines
            .map(|line| {
                let (name, value) = line.split_once(": ").unwrap();
                (name.to_owned(), value.to_owned())
            })
            .collect();
        (status, headers)
    }

    fn body_of(bytes: &[u8]) -> Vec<u8> {
        let split = bytes.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        bytes[split..].to_vec()
    }

    fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
        headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            // A process-wide counter keeps parallel tests from colliding on the
            // same directory even within one nanosecond.
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let seq = SEQ.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("toki-static-{nanos}-{seq}"));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn write(&self, name: &str, contents: &[u8]) {
            std::fs::write(self.0.join(name), contents).unwrap();
        }

        fn mount(&self, prefix: &str) -> Vec<StaticMountResolved> {
            vec![StaticMountResolved {
                url_prefix: prefix.to_owned(),
                canonical_dir: Some(std::fs::canonicalize(&self.0).unwrap()),
                index_file: Some("index.html".to_owned()),
                cache_control: DEFAULT_CACHE_CONTROL.to_owned(),
            }]
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn into_response(outcome: StaticOutcome) -> Vec<u8> {
        match outcome {
            StaticOutcome::Response(bytes) => bytes,
            StaticOutcome::NotMounted => panic!("expected Response, got NotMounted"),
        }
    }

    #[test]
    fn matches_path_requires_segment_boundary() {
        let mount = StaticMountResolved {
            url_prefix: "/static".to_owned(),
            canonical_dir: None,
            index_file: None,
            cache_control: String::new(),
        };
        assert!(mount.matches_path("/static"));
        assert!(mount.matches_path("/static/app.css"));
        assert!(!mount.matches_path("/static-assets/x"));
        assert!(!mount.matches_path("/other"));
    }

    #[test]
    fn sanitize_rejects_dotdot_traversal() {
        assert!(sanitize_relative("/../etc/passwd").is_none());
        assert!(sanitize_relative("/a/../../b").is_none());
        assert!(sanitize_relative("/..").is_none());
    }

    #[test]
    fn sanitize_rejects_encoded_traversal() {
        assert!(sanitize_relative("/a/%2e%2e/b").is_none());
        // `%2f` decodes to `/` inside a segment; must not form a new component.
        assert!(sanitize_relative("/a%2f..%2fb").is_none());
    }

    #[test]
    fn sanitize_rejects_encoded_nul() {
        assert!(sanitize_relative("/a%00b").is_none());
    }

    #[test]
    fn sanitize_normalizes_dot_and_empty_segments() {
        assert_eq!(
            sanitize_relative("/css/app.css"),
            Some(PathBuf::from("css/app.css"))
        );
        assert_eq!(sanitize_relative("/./a//b/"), Some(PathBuf::from("a/b")));
        assert_eq!(sanitize_relative("/"), Some(PathBuf::new()));
    }

    #[test]
    fn etag_combines_length_and_mtime() {
        let etag = compute_etag(255, None);
        assert_eq!(etag, "\"ff-0\"");
    }

    #[test]
    fn etag_matches_strong_weak_wildcard_and_lists() {
        let etag = "\"a-b\"";
        assert!(etag_matches("\"a-b\"", etag));
        assert!(etag_matches("W/\"a-b\"", etag));
        assert!(etag_matches("*", etag));
        assert!(etag_matches("\"x\", \"a-b\"", etag));
        assert!(!etag_matches("\"x\"", etag));
        assert!(!etag_matches("\"a-c\"", etag));
    }

    #[test]
    fn mime_appends_charset_for_text_types() {
        assert_eq!(mime_for(Path::new("a.html")), "text/html; charset=utf-8");
        assert_eq!(mime_for(Path::new("a.css")), "text/css; charset=utf-8");
        assert_eq!(
            mime_for(Path::new("a.json")),
            "application/json; charset=utf-8"
        );
        assert_eq!(mime_for(Path::new("a.svg")), "image/svg+xml; charset=utf-8");
    }

    #[test]
    fn mime_leaves_binary_types_bare() {
        assert_eq!(mime_for(Path::new("a.png")), "image/png");
        assert_eq!(
            mime_for(Path::new("a.unknownext")),
            "application/octet-stream"
        );
    }

    #[test]
    fn range_parsing_covers_all_single_range_forms() {
        assert!(matches!(
            parse_single_range("bytes=0-99", 1000),
            RangeResult::Satisfiable { start: 0, end: 99 }
        ));
        assert!(matches!(
            parse_single_range("bytes=500-", 1000),
            RangeResult::Satisfiable {
                start: 500,
                end: 999
            }
        ));
        assert!(matches!(
            parse_single_range("bytes=-100", 1000),
            RangeResult::Satisfiable {
                start: 900,
                end: 999
            }
        ));
    }

    #[test]
    fn range_end_is_clamped_to_file_length() {
        assert!(matches!(
            parse_single_range("bytes=0-99999", 1000),
            RangeResult::Satisfiable { start: 0, end: 999 }
        ));
        assert!(matches!(
            parse_single_range("bytes=-99999", 1000),
            RangeResult::Satisfiable { start: 0, end: 999 }
        ));
    }

    #[test]
    fn range_unsatisfiable_when_beyond_end() {
        assert!(matches!(
            parse_single_range("bytes=2000-3000", 1000),
            RangeResult::Unsatisfiable
        ));
        assert!(matches!(
            parse_single_range("bytes=1000-", 1000),
            RangeResult::Unsatisfiable
        ));
        assert!(matches!(
            parse_single_range("bytes=-0", 1000),
            RangeResult::Unsatisfiable
        ));
        // Any range against an empty file is unsatisfiable.
        assert!(matches!(
            parse_single_range("bytes=0-0", 0),
            RangeResult::Unsatisfiable
        ));
    }

    #[test]
    fn range_ignored_when_not_a_single_byte_range() {
        assert!(matches!(
            parse_single_range("bytes=0-99,200-299", 1000),
            RangeResult::Ignore
        ));
        assert!(matches!(
            parse_single_range("items=0-99", 1000),
            RangeResult::Ignore
        ));
        assert!(matches!(
            parse_single_range("bytes=abc-def", 1000),
            RangeResult::Ignore
        ));
        assert!(matches!(
            parse_single_range("bytes=-", 1000),
            RangeResult::Ignore
        ));
    }

    #[tokio::test]
    async fn unmatched_path_is_not_mounted() {
        let dir = TempDir::new();
        let outcome = serve(
            "GET",
            "/other/file",
            None,
            None,
            Encoding::Identity,
            &dir.mount("/static"),
            &no_defaults(),
        )
        .await;
        assert!(matches!(outcome, StaticOutcome::NotMounted));
    }

    #[tokio::test]
    async fn serves_file_with_mime_etag_and_cache_control() {
        let dir = TempDir::new();
        dir.write("app.css", b"body{}");
        let bytes = into_response(
            serve(
                "GET",
                "/static/app.css",
                None,
                None,
                Encoding::Identity,
                &dir.mount("/static"),
                &no_defaults(),
            )
            .await,
        );
        let (status, headers) = parse_head(&bytes);
        assert_eq!(status, "HTTP/1.1 200 OK");
        assert_eq!(
            header_value(&headers, "Content-Type"),
            Some("text/css; charset=utf-8")
        );
        assert_eq!(
            header_value(&headers, "Cache-Control"),
            Some(DEFAULT_CACHE_CONTROL)
        );
        assert!(header_value(&headers, "ETag").is_some());
        assert_eq!(header_value(&headers, "Accept-Ranges"), Some("bytes"));
        assert_eq!(body_of(&bytes), b"body{}");
    }

    #[tokio::test]
    async fn head_request_sends_headers_without_body() {
        let dir = TempDir::new();
        dir.write("data.txt", b"0123456789");
        let bytes = into_response(
            serve(
                "HEAD",
                "/s/data.txt",
                None,
                None,
                Encoding::Identity,
                &dir.mount("/s"),
                &no_defaults(),
            )
            .await,
        );
        let (status, headers) = parse_head(&bytes);
        assert_eq!(status, "HTTP/1.1 200 OK");
        assert_eq!(header_value(&headers, "Content-Length"), Some("10"));
        assert!(body_of(&bytes).is_empty());
    }

    #[tokio::test]
    async fn non_get_head_method_yields_405() {
        let dir = TempDir::new();
        dir.write("x.txt", b"hi");
        let bytes = into_response(
            serve(
                "POST",
                "/s/x.txt",
                None,
                None,
                Encoding::Identity,
                &dir.mount("/s"),
                &no_defaults(),
            )
            .await,
        );
        let (status, headers) = parse_head(&bytes);
        assert_eq!(status, "HTTP/1.1 405 Method Not Allowed");
        assert_eq!(header_value(&headers, "Allow"), Some("GET, HEAD"));
    }

    #[tokio::test]
    async fn missing_file_yields_404() {
        let dir = TempDir::new();
        let bytes = into_response(
            serve(
                "GET",
                "/s/nope.txt",
                None,
                None,
                Encoding::Identity,
                &dir.mount("/s"),
                &no_defaults(),
            )
            .await,
        );
        let (status, _) = parse_head(&bytes);
        assert_eq!(status, "HTTP/1.1 404 Not Found");
    }

    #[tokio::test]
    async fn matching_if_none_match_yields_304() {
        let dir = TempDir::new();
        dir.write("c.txt", b"cached");
        let mount = dir.mount("/s");
        let first = into_response(
            serve(
                "GET",
                "/s/c.txt",
                None,
                None,
                Encoding::Identity,
                &mount,
                &no_defaults(),
            )
            .await,
        );
        let (_, headers) = parse_head(&first);
        let etag = header_value(&headers, "ETag").unwrap().to_owned();

        let bytes = into_response(
            serve(
                "GET",
                "/s/c.txt",
                Some(&etag),
                None,
                Encoding::Identity,
                &mount,
                &no_defaults(),
            )
            .await,
        );
        let (status, headers) = parse_head(&bytes);
        assert_eq!(status, "HTTP/1.1 304 Not Modified");
        assert_eq!(header_value(&headers, "ETag").unwrap(), etag);
        assert!(body_of(&bytes).is_empty());
    }

    #[tokio::test]
    async fn satisfiable_range_yields_206_partial() {
        let dir = TempDir::new();
        dir.write("r.txt", b"0123456789");
        let bytes = into_response(
            serve(
                "GET",
                "/s/r.txt",
                None,
                Some("bytes=2-5"),
                Encoding::Identity,
                &dir.mount("/s"),
                &no_defaults(),
            )
            .await,
        );
        let (status, headers) = parse_head(&bytes);
        assert_eq!(status, "HTTP/1.1 206 Partial Content");
        assert_eq!(
            header_value(&headers, "Content-Range"),
            Some("bytes 2-5/10")
        );
        assert_eq!(header_value(&headers, "Content-Length"), Some("4"));
        assert_eq!(body_of(&bytes), b"2345");
    }

    #[tokio::test]
    async fn unsatisfiable_range_yields_416() {
        let dir = TempDir::new();
        dir.write("r.txt", b"0123456789");
        let bytes = into_response(
            serve(
                "GET",
                "/s/r.txt",
                None,
                Some("bytes=100-200"),
                Encoding::Identity,
                &dir.mount("/s"),
                &no_defaults(),
            )
            .await,
        );
        let (status, headers) = parse_head(&bytes);
        assert_eq!(status, "HTTP/1.1 416 Range Not Satisfiable");
        assert_eq!(header_value(&headers, "Content-Range"), Some("bytes */10"));
    }

    #[tokio::test]
    async fn unhandled_range_serves_full_file() {
        let dir = TempDir::new();
        dir.write("r.txt", b"0123456789");
        let bytes = into_response(
            serve(
                "GET",
                "/s/r.txt",
                None,
                Some("bytes=0-1,4-5"),
                Encoding::Identity,
                &dir.mount("/s"),
                &no_defaults(),
            )
            .await,
        );
        let (status, _) = parse_head(&bytes);
        assert_eq!(status, "HTTP/1.1 200 OK");
        assert_eq!(body_of(&bytes), b"0123456789");
    }

    #[tokio::test]
    async fn directory_request_serves_index_file() {
        let dir = TempDir::new();
        dir.write("index.html", b"<h1>home</h1>");
        let bytes = into_response(
            serve(
                "GET",
                "/s",
                None,
                None,
                Encoding::Identity,
                &dir.mount("/s"),
                &no_defaults(),
            )
            .await,
        );
        let (status, headers) = parse_head(&bytes);
        assert_eq!(status, "HTTP/1.1 200 OK");
        assert_eq!(
            header_value(&headers, "Content-Type"),
            Some("text/html; charset=utf-8")
        );
        assert_eq!(body_of(&bytes), b"<h1>home</h1>");
    }

    #[tokio::test]
    async fn traversal_attempt_yields_404() {
        let dir = TempDir::new();
        dir.write("ok.txt", b"safe");
        let bytes = into_response(
            serve(
                "GET",
                "/s/../../../etc/passwd",
                None,
                None,
                Encoding::Identity,
                &dir.mount("/s"),
                &no_defaults(),
            )
            .await,
        );
        let (status, _) = parse_head(&bytes);
        assert_eq!(status, "HTTP/1.1 404 Not Found");
    }

    #[tokio::test]
    async fn missing_mount_directory_yields_404() {
        let mount = vec![StaticMountResolved {
            url_prefix: "/s".to_owned(),
            canonical_dir: None,
            index_file: None,
            cache_control: DEFAULT_CACHE_CONTROL.to_owned(),
        }];
        let bytes = into_response(
            serve(
                "GET",
                "/s/x.txt",
                None,
                None,
                Encoding::Identity,
                &mount,
                &no_defaults(),
            )
            .await,
        );
        let (status, _) = parse_head(&bytes);
        assert_eq!(status, "HTTP/1.1 404 Not Found");
    }

    #[tokio::test]
    async fn compresses_large_compressible_file() {
        let dir = TempDir::new();
        dir.write("big.txt", "x".repeat(4096).as_bytes());
        let mut defaults = no_defaults();
        defaults.compression = true;
        defaults.compression_min_size = 64;
        let bytes = into_response(
            serve(
                "GET",
                "/s/big.txt",
                None,
                None,
                Encoding::Gzip,
                &dir.mount("/s"),
                &defaults,
            )
            .await,
        );
        let (_, headers) = parse_head(&bytes);
        assert_eq!(header_value(&headers, "Content-Encoding"), Some("gzip"));
        assert_eq!(header_value(&headers, "Vary"), Some("Accept-Encoding"));
        // Compressed responses do not advertise range support.
        assert_eq!(header_value(&headers, "Accept-Ranges"), None);
    }

    #[tokio::test]
    async fn default_headers_reach_static_responses() {
        let dir = TempDir::new();
        dir.write("a.txt", b"hi");
        let mut defaults = no_defaults();
        defaults.default_headers = vec![HttpHeader {
            name: "X-Content-Type-Options".to_owned(),
            value: "nosniff".to_owned(),
        }];
        let bytes = into_response(
            serve(
                "GET",
                "/s/a.txt",
                None,
                None,
                Encoding::Identity,
                &dir.mount("/s"),
                &defaults,
            )
            .await,
        );
        let (_, headers) = parse_head(&bytes);
        assert_eq!(
            header_value(&headers, "X-Content-Type-Options"),
            Some("nosniff")
        );
    }

    #[tokio::test]
    async fn default_headers_reach_error_responses() {
        let dir = TempDir::new();
        let mut defaults = no_defaults();
        defaults.default_headers = vec![HttpHeader {
            name: "X-Frame-Options".to_owned(),
            value: "DENY".to_owned(),
        }];
        let bytes = into_response(
            serve(
                "GET",
                "/s/missing.txt",
                None,
                None,
                Encoding::Identity,
                &dir.mount("/s"),
                &defaults,
            )
            .await,
        );
        let (status, headers) = parse_head(&bytes);
        assert_eq!(status, "HTTP/1.1 404 Not Found");
        assert_eq!(header_value(&headers, "X-Frame-Options"), Some("DENY"));
    }
}
