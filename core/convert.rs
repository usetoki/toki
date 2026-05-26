//! Plain objects exchanged with JavaScript, plus response serialization for the
//! JS handler path. The native fast-path never touches these — it writes a buffer
//! pre-rendered at registration time (see [`crate::server::NativeRoute`]).

use napi::bindgen_prelude::{Buffer, Either};
use napi_derive::napi;

use crate::compress::{self, Encoding};
use crate::server::ResponseDefaults;

/// One HTTP header. Headers travel as an ordered list, not a map, so repeated
/// fields (`Set-Cookie`, `Vary`, ...) survive the round trip.
#[napi(object)]
#[derive(Clone)]
pub struct HttpHeader {
    pub name: String,
    pub value: String,
}

/// A non-file form field (a text part of a urlencoded or multipart body).
#[napi(object)]
pub struct FormField {
    pub name: String,
    pub value: String,
}

/// An uploaded file part of a `multipart/form-data` body. Exactly one of `data` /
/// `path` is populated depending on whether an `upload_dir` was configured.
#[napi(object)]
pub struct FormFile {
    pub field: String,
    pub filename: Option<String>,
    pub content_type: Option<String>,
    pub size: u32,
    pub data: Option<Buffer>,
    pub path: Option<String>,
}

/// A request body parsed natively into form data.
#[napi(object)]
pub struct ParsedForm {
    pub fields: Vec<FormField>,
    pub files: Vec<FormFile>,
}

/// A dynamic route registered from JavaScript and matched natively in Rust.
/// `pattern` uses Toki's path syntax (`:name`, trailing `*`); `method` is matched
/// exactly as received on the wire.
#[napi(object)]
pub struct DynamicRoute {
    pub method: String,
    pub pattern: String,
}

/// A name/value pair extracted natively from a request: a path parameter, a
/// query-string pair, or a cookie. Repeated names stay as separate entries.
#[napi(object)]
pub struct Param {
    pub name: String,
    pub value: String,
}

/// The request handed to a JavaScript handler.
#[napi(object)]
pub struct HttpRequest {
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: Vec<HttpHeader>,
    pub body: Option<Buffer>,
    /// Natively parsed form data, present only when form parsing is enabled and
    /// the request carried a recognized form `Content-Type`.
    pub form: Option<ParsedForm>,
    /// Index of the matched dynamic route in the `dynamicRoutes` array. Always
    /// `>= 0` when a handler runs.
    pub route_index: i32,
    /// Path parameters from the matched route, in declaration order, percent-decoded.
    pub params: Vec<Param>,
    /// Query-string pairs, in order, percent-decoded with `+` as space.
    pub query_pairs: Vec<Param>,
    /// Cookies from the `Cookie` header, in order, percent-decoded.
    pub cookies: Vec<Param>,
    /// A random 128-bit per-request id, hex-encoded, for correlation and logging.
    pub request_id: String,
}

/// The response a JavaScript handler resolves with.
#[napi(object)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<HttpHeader>,
    pub body: Option<Either<String, Buffer>>,
}

/// Serialize a handler response into raw HTTP/1.1 bytes.
///
/// Default headers are injected unless the handler set one of the same name. When
/// compression is enabled and the body is large enough with a compressible type,
/// it is encoded and `Content-Encoding` / `Vary: Accept-Encoding` added.
/// `Content-Length` is always recomputed so framing matches the bytes sent.
pub fn serialize_response(
    response: HttpResponse,
    encoding: Encoding,
    defaults: &ResponseDefaults,
) -> Vec<u8> {
    let mut body: Vec<u8> = match response.body {
        Some(Either::A(text)) => text.into_bytes(),
        Some(Either::B(buffer)) => buffer.to_vec(),
        None => Vec::new(),
    };

    let content_type = response
        .headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case("content-type"))
        .map(|h| h.value.as_str());

    let mut applied_encoding: Option<&'static str> = None;
    if defaults.compression
        && encoding != Encoding::Identity
        && body.len() >= defaults.compression_min_size
    {
        let compressible = content_type.is_some_and(compress::is_compressible);
        let already_encoded = response
            .headers
            .iter()
            .any(|h| h.name.eq_ignore_ascii_case("content-encoding"));
        if compressible && !already_encoded {
            if let Some(compressed) =
                compress::compress(&body, encoding, defaults.compression_levels)
            {
                body = compressed;
                applied_encoding = encoding.token();
            }
        }
    }

    let mut out = Vec::with_capacity(128 + body.len());
    out.extend_from_slice(b"HTTP/1.1 ");
    out.extend_from_slice(response.status.to_string().as_bytes());
    out.push(b' ');
    out.extend_from_slice(reason_phrase(response.status).as_bytes());
    out.extend_from_slice(b"\r\n");

    let mut has_vary = false;
    for header in &response.headers {
        // Content-Length is recomputed from the (possibly compressed) body below.
        if header.name.eq_ignore_ascii_case("content-length") {
            continue;
        }
        if header.name.eq_ignore_ascii_case("vary") {
            has_vary = true;
        }
        out.extend_from_slice(header.name.as_bytes());
        out.extend_from_slice(b": ");
        out.extend_from_slice(header.value.as_bytes());
        out.extend_from_slice(b"\r\n");
    }

    for default in &defaults.default_headers {
        if default.name.eq_ignore_ascii_case("content-length") {
            continue;
        }
        let present = response
            .headers
            .iter()
            .any(|h| h.name.eq_ignore_ascii_case(&default.name));
        if !present {
            if default.name.eq_ignore_ascii_case("vary") {
                has_vary = true;
            }
            out.extend_from_slice(default.name.as_bytes());
            out.extend_from_slice(b": ");
            out.extend_from_slice(default.value.as_bytes());
            out.extend_from_slice(b"\r\n");
        }
    }

    if let Some(token) = applied_encoding {
        out.extend_from_slice(b"Content-Encoding: ");
        out.extend_from_slice(token.as_bytes());
        out.extend_from_slice(b"\r\n");
        if !has_vary {
            out.extend_from_slice(b"Vary: Accept-Encoding\r\n");
        }
    }

    out.extend_from_slice(b"Content-Length: ");
    out.extend_from_slice(body.len().to_string().as_bytes());
    out.extend_from_slice(b"\r\n\r\n");
    out.extend_from_slice(&body);
    out
}

/// A native error response. Kept as a kind (not bytes) so default headers are
/// injected at write time, like the success paths. `405` carries its `Allow` list.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ErrorResponse {
    BadRequest,
    NotFound,
    /// `Allow` lists the methods the matched path accepts.
    MethodNotAllowed(Vec<String>),
    PayloadTooLarge,
    UnsupportedMediaType,
    InternalError,
}

/// Plain-text bodies are also the reason phrases, so each is defined once.
const PLAIN_TEXT: &str = "text/plain; charset=utf-8";

impl ErrorResponse {
    fn status(&self) -> u16 {
        match self {
            ErrorResponse::BadRequest => 400,
            ErrorResponse::NotFound => 404,
            ErrorResponse::MethodNotAllowed(_) => 405,
            ErrorResponse::PayloadTooLarge => 413,
            ErrorResponse::UnsupportedMediaType => 415,
            ErrorResponse::InternalError => 500,
        }
    }

    fn body(&self) -> &'static [u8] {
        match self {
            ErrorResponse::BadRequest => b"Bad Request",
            ErrorResponse::NotFound => b"Not Found",
            ErrorResponse::MethodNotAllowed(_) => b"Method Not Allowed",
            ErrorResponse::PayloadTooLarge => b"Payload Too Large",
            ErrorResponse::UnsupportedMediaType => b"Unsupported Media Type",
            ErrorResponse::InternalError => b"Internal Server Error",
        }
    }

    /// Render full HTTP/1.1 bytes, appending each resolved default header not
    /// already emitted (case-insensitive). The emitted set is `Content-Type`, the
    /// `405` `Allow`, then defaults, then `Content-Length` — so a default may not
    /// clobber `Content-Type`/`Allow` and never overrides `Content-Length` (which
    /// is computed from the fixed body). Mirrors the success-path skip-if-present
    /// rule so `X-Powered-By` and user `defaultHeaders` reach error responses too.
    pub fn render(&self, defaults: &ResponseDefaults) -> Vec<u8> {
        let status = self.status();
        let body = self.body();
        let allow = match self {
            ErrorResponse::MethodNotAllowed(methods) => Some(methods.join(", ")),
            _ => None,
        };

        let mut out = Vec::with_capacity(160 + body.len());
        out.extend_from_slice(b"HTTP/1.1 ");
        out.extend_from_slice(status.to_string().as_bytes());
        out.push(b' ');
        out.extend_from_slice(reason_phrase(status).as_bytes());
        out.extend_from_slice(b"\r\nContent-Type: ");
        out.extend_from_slice(PLAIN_TEXT.as_bytes());
        if let Some(allow) = allow.as_deref() {
            out.extend_from_slice(b"\r\nAllow: ");
            out.extend_from_slice(allow.as_bytes());
        }

        for default in &defaults.default_headers {
            let name = default.name.as_str();
            // Content-Length is computed below; Content-Type/Allow are already
            // emitted — never let a default duplicate or override them.
            if name.eq_ignore_ascii_case("content-length")
                || name.eq_ignore_ascii_case("content-type")
                || (allow.is_some() && name.eq_ignore_ascii_case("allow"))
            {
                continue;
            }
            out.extend_from_slice(b"\r\n");
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(b": ");
            out.extend_from_slice(default.value.as_bytes());
        }

        out.extend_from_slice(b"\r\nContent-Length: ");
        out.extend_from_slice(body.len().to_string().as_bytes());
        out.extend_from_slice(b"\r\n\r\n");
        out.extend_from_slice(body);
        out
    }
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compress::CompressionLevels;

    fn header(name: &str, value: &str) -> HttpHeader {
        HttpHeader {
            name: name.to_owned(),
            value: value.to_owned(),
        }
    }

    fn no_compression() -> ResponseDefaults {
        ResponseDefaults {
            compression: false,
            compression_min_size: 1024,
            default_headers: Vec::new(),
            compression_levels: CompressionLevels::default(),
        }
    }

    fn parse_head(bytes: &[u8]) -> (String, Vec<(String, String)>) {
        let text = String::from_utf8_lossy(bytes);
        let head = text.split("\r\n\r\n").next().unwrap();
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

    fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
        headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn serializes_status_line_and_reason() {
        let response = HttpResponse {
            status: 201,
            headers: vec![header("Content-Type", "text/plain")],
            body: Some(Either::A("created".to_owned())),
        };
        let bytes = serialize_response(response, Encoding::Identity, &no_compression());
        let (status, _) = parse_head(&bytes);
        assert_eq!(status, "HTTP/1.1 201 Created");
        assert!(bytes.ends_with(b"\r\n\r\ncreated"));
    }

    #[test]
    fn unknown_status_uses_generic_reason() {
        let response = HttpResponse {
            status: 599,
            headers: Vec::new(),
            body: None,
        };
        let bytes = serialize_response(response, Encoding::Identity, &no_compression());
        let (status, _) = parse_head(&bytes);
        assert_eq!(status, "HTTP/1.1 599 Status");
    }

    #[test]
    fn content_length_matches_body_and_drops_handler_value() {
        let response = HttpResponse {
            status: 200,
            headers: vec![header("Content-Length", "999")],
            body: Some(Either::A("hello".to_owned())),
        };
        let bytes = serialize_response(response, Encoding::Identity, &no_compression());
        let (_, headers) = parse_head(&bytes);
        assert_eq!(header_value(&headers, "Content-Length"), Some("5"));
        assert_eq!(
            headers
                .iter()
                .filter(|(n, _)| n.eq_ignore_ascii_case("content-length"))
                .count(),
            1
        );
    }

    #[test]
    fn empty_body_yields_zero_content_length() {
        let response = HttpResponse {
            status: 204,
            headers: Vec::new(),
            body: None,
        };
        let bytes = serialize_response(response, Encoding::Identity, &no_compression());
        let (_, headers) = parse_head(&bytes);
        assert_eq!(header_value(&headers, "Content-Length"), Some("0"));
    }

    #[test]
    fn buffer_body_is_serialized_verbatim() {
        let response = HttpResponse {
            status: 200,
            headers: Vec::new(),
            body: Some(Either::B(vec![1u8, 2, 3, 4].into())),
        };
        let bytes = serialize_response(response, Encoding::Identity, &no_compression());
        assert!(bytes.ends_with(&[1, 2, 3, 4]));
        let (_, headers) = parse_head(&bytes);
        assert_eq!(header_value(&headers, "Content-Length"), Some("4"));
    }

    #[test]
    fn default_headers_injected_only_when_absent() {
        let mut defaults = no_compression();
        defaults.default_headers = vec![
            header("X-Frame-Options", "DENY"),
            header("Content-Type", "application/json"),
        ];
        let response = HttpResponse {
            status: 200,
            headers: vec![header("Content-Type", "text/html")],
            body: None,
        };
        let bytes = serialize_response(response, Encoding::Identity, &defaults);
        let (_, headers) = parse_head(&bytes);
        assert_eq!(header_value(&headers, "X-Frame-Options"), Some("DENY"));
        // Handler's content-type wins; the default is not injected.
        assert_eq!(header_value(&headers, "Content-Type"), Some("text/html"));
        assert_eq!(
            headers
                .iter()
                .filter(|(n, _)| n.eq_ignore_ascii_case("content-type"))
                .count(),
            1
        );
    }

    #[test]
    fn default_content_length_header_is_never_injected() {
        let mut defaults = no_compression();
        defaults.default_headers = vec![header("Content-Length", "42")];
        let response = HttpResponse {
            status: 200,
            headers: Vec::new(),
            body: Some(Either::A("abc".to_owned())),
        };
        let bytes = serialize_response(response, Encoding::Identity, &defaults);
        let (_, headers) = parse_head(&bytes);
        assert_eq!(header_value(&headers, "Content-Length"), Some("3"));
    }

    #[test]
    fn repeated_headers_are_all_emitted() {
        let response = HttpResponse {
            status: 200,
            headers: vec![header("Set-Cookie", "a=1"), header("Set-Cookie", "b=2")],
            body: None,
        };
        let bytes = serialize_response(response, Encoding::Identity, &no_compression());
        let (_, headers) = parse_head(&bytes);
        assert_eq!(
            headers
                .iter()
                .filter(|(n, _)| n.eq_ignore_ascii_case("set-cookie"))
                .count(),
            2
        );
    }

    #[test]
    fn compresses_large_compressible_body() {
        let mut defaults = no_compression();
        defaults.compression = true;
        defaults.compression_min_size = 32;
        let body = "x".repeat(2048);
        let response = HttpResponse {
            status: 200,
            headers: vec![header("Content-Type", "text/plain")],
            body: Some(Either::A(body.clone())),
        };
        let bytes = serialize_response(response, Encoding::Gzip, &defaults);
        let (_, headers) = parse_head(&bytes);
        assert_eq!(header_value(&headers, "Content-Encoding"), Some("gzip"));
        assert_eq!(header_value(&headers, "Vary"), Some("Accept-Encoding"));
        let len: usize = header_value(&headers, "Content-Length")
            .unwrap()
            .parse()
            .unwrap();
        assert!(len < body.len());
    }

    #[test]
    fn skips_compression_below_min_size() {
        let mut defaults = no_compression();
        defaults.compression = true;
        defaults.compression_min_size = 4096;
        let response = HttpResponse {
            status: 200,
            headers: vec![header("Content-Type", "text/plain")],
            body: Some(Either::A("small".to_owned())),
        };
        let bytes = serialize_response(response, Encoding::Gzip, &defaults);
        let (_, headers) = parse_head(&bytes);
        assert_eq!(header_value(&headers, "Content-Encoding"), None);
    }

    #[test]
    fn skips_compression_for_incompressible_type() {
        let mut defaults = no_compression();
        defaults.compression = true;
        defaults.compression_min_size = 8;
        let response = HttpResponse {
            status: 200,
            headers: vec![header("Content-Type", "image/png")],
            body: Some(Either::B(vec![0u8; 2048].into())),
        };
        let bytes = serialize_response(response, Encoding::Gzip, &defaults);
        let (_, headers) = parse_head(&bytes);
        assert_eq!(header_value(&headers, "Content-Encoding"), None);
    }

    #[test]
    fn does_not_double_encode_already_encoded_body() {
        let mut defaults = no_compression();
        defaults.compression = true;
        defaults.compression_min_size = 8;
        let response = HttpResponse {
            status: 200,
            headers: vec![
                header("Content-Type", "text/plain"),
                header("Content-Encoding", "gzip"),
            ],
            body: Some(Either::A("x".repeat(2048))),
        };
        let bytes = serialize_response(response, Encoding::Gzip, &defaults);
        let (_, headers) = parse_head(&bytes);
        assert_eq!(
            headers
                .iter()
                .filter(|(n, _)| n.eq_ignore_ascii_case("content-encoding"))
                .count(),
            1
        );
    }

    #[test]
    fn identity_encoding_never_compresses() {
        let mut defaults = no_compression();
        defaults.compression = true;
        defaults.compression_min_size = 8;
        let response = HttpResponse {
            status: 200,
            headers: vec![header("Content-Type", "text/plain")],
            body: Some(Either::A("x".repeat(2048))),
        };
        let bytes = serialize_response(response, Encoding::Identity, &defaults);
        let (_, headers) = parse_head(&bytes);
        assert_eq!(header_value(&headers, "Content-Encoding"), None);
    }

    #[test]
    fn keeps_handler_vary_when_compressing() {
        let mut defaults = no_compression();
        defaults.compression = true;
        defaults.compression_min_size = 8;
        let response = HttpResponse {
            status: 200,
            headers: vec![
                header("Content-Type", "text/plain"),
                header("Vary", "Origin"),
            ],
            body: Some(Either::A("x".repeat(2048))),
        };
        let bytes = serialize_response(response, Encoding::Gzip, &defaults);
        let (_, headers) = parse_head(&bytes);
        // The handler already set Vary, so no extra Vary: Accept-Encoding is added.
        assert_eq!(
            headers
                .iter()
                .filter(|(n, _)| n.eq_ignore_ascii_case("vary"))
                .count(),
            1
        );
        assert_eq!(header_value(&headers, "Vary"), Some("Origin"));
    }

    #[test]
    fn method_not_allowed_lists_allowed_methods() {
        let error = ErrorResponse::MethodNotAllowed(vec!["GET".to_owned(), "POST".to_owned()]);
        let bytes = error.render(&no_compression());
        let (status, headers) = parse_head(&bytes);
        assert_eq!(status, "HTTP/1.1 405 Method Not Allowed");
        assert_eq!(header_value(&headers, "Allow"), Some("GET, POST"));
        assert_eq!(header_value(&headers, "Content-Length"), Some("18"));
        assert!(bytes.ends_with(b"Method Not Allowed"));
    }

    /// Every error kind renders a well-formed status line and a `Content-Length`
    /// matching its body, even with no default headers.
    #[test]
    fn fixed_error_responses_are_well_formed() {
        let defaults = no_compression();
        for error in [
            ErrorResponse::InternalError,
            ErrorResponse::BadRequest,
            ErrorResponse::NotFound,
            ErrorResponse::PayloadTooLarge,
            ErrorResponse::UnsupportedMediaType,
            ErrorResponse::MethodNotAllowed(vec!["GET".to_owned()]),
        ] {
            let resp = error.render(&defaults);
            let (status, headers) = parse_head(&resp);
            assert!(status.starts_with("HTTP/1.1 "));
            let declared: usize = header_value(&headers, "Content-Length")
                .unwrap()
                .parse()
                .unwrap();
            let body_start = resp.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
            assert_eq!(resp.len() - body_start, declared);
        }
    }

    /// Resolved default headers (X-Powered-By among them) ride along on error
    /// responses, mirroring the success paths.
    #[test]
    fn error_responses_carry_default_headers() {
        let mut defaults = no_compression();
        defaults.default_headers = vec![
            header("X-Powered-By", "Toki"),
            header("X-Frame-Options", "DENY"),
        ];
        for error in [
            ErrorResponse::NotFound,
            ErrorResponse::PayloadTooLarge,
            ErrorResponse::MethodNotAllowed(vec!["GET".to_owned()]),
        ] {
            let resp = error.render(&defaults);
            let (_, headers) = parse_head(&resp);
            assert_eq!(header_value(&headers, "X-Powered-By"), Some("Toki"));
            assert_eq!(header_value(&headers, "X-Frame-Options"), Some("DENY"));
        }
    }

    /// A default header may never duplicate or override the error's own
    /// `Content-Type`, `Content-Length`, or (on 405) `Allow`.
    #[test]
    fn error_response_defaults_never_override_framing_headers() {
        let mut defaults = no_compression();
        defaults.default_headers = vec![
            header("Content-Type", "application/json"),
            header("Content-Length", "999"),
            header("Allow", "DELETE"),
        ];
        let resp = ErrorResponse::MethodNotAllowed(vec!["GET".to_owned(), "POST".to_owned()])
            .render(&defaults);
        let (_, headers) = parse_head(&resp);
        // The error's own values stand; the body length is recomputed.
        assert_eq!(
            header_value(&headers, "Content-Type"),
            Some("text/plain; charset=utf-8")
        );
        assert_eq!(header_value(&headers, "Content-Length"), Some("18"));
        assert_eq!(header_value(&headers, "Allow"), Some("GET, POST"));
        for name in ["Content-Type", "Content-Length", "Allow"] {
            assert_eq!(
                headers
                    .iter()
                    .filter(|(n, _)| n.eq_ignore_ascii_case(name))
                    .count(),
                1,
                "{name} must appear exactly once"
            );
        }
    }
}
