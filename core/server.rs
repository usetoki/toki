//! The native surface exposed to JavaScript: `listen`, a shutdown handle, and the
//! shared server state. A server binds a TCP socket (optionally TLS-wrapped) or a
//! Unix-domain socket and serves every connection through
//! [`crate::http::serve_connection`]. Shutdown is graceful: the accept loop stops,
//! then in-flight connections drain (bounded by a configurable timeout).

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use napi::bindgen_prelude::{Buffer, Either, Promise};
use napi::threadsafe_function::ThreadsafeFunction;
use napi::{Error, Result, Status};
use napi_derive::napi;
use tokio::net::TcpListener;
use tokio::runtime::Builder;
use tokio::sync::watch;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::TlsAcceptor;

use crate::compress::{Encoding, PrecompressedRoute};
use crate::convert::{DynamicRoute, HttpHeader, HttpRequest, HttpResponse};
use crate::http::{ConnGuard, HEADER_SLOTS};
use crate::meta::DynamicRouter;
use crate::static_files::StaticMountResolved;

/// The JavaScript handler, viewed from Rust. Used only for routes without a
/// native responder.
pub type Dispatch = ThreadsafeFunction<HttpRequest, Promise<HttpResponse>>;

/// A route resolved entirely in Rust, pre-rendered at registration and served
/// without crossing into JavaScript.
#[napi(object)]
pub struct NativeRoute {
    pub method: String,
    pub path: String,
    pub status: u16,
    pub content_type: String,
    pub body: Either<String, Buffer>,
    /// Extra response headers baked into the pre-rendered bytes. Do not include
    /// `Content-Type` or `Content-Length` — those are emitted automatically.
    pub headers: Option<Vec<HttpHeader>>,
}

/// A static-file mount: a URL prefix served from a filesystem directory entirely
/// in Rust. Checked after the native-route table and before the dynamic router,
/// in registration order; the first matching prefix wins.
#[napi(object)]
pub struct StaticMount {
    /// URL path prefix this mount answers, e.g. `/static`. A match requires the
    /// path to equal the prefix or be followed by `/`.
    pub url_prefix: String,
    /// Directory files are read from, canonicalized once at startup; a missing
    /// directory disables the mount.
    pub dir: String,
    /// File served when the resolved path is a directory, e.g. `index.html`. When
    /// unset, a directory resolves to `404`.
    pub index_file: Option<String>,
    /// `Cache-Control` value for this mount's files. Defaults to
    /// `public, max-age=3600`.
    pub cache_control: Option<String>,
}

/// Runtime size and per-connection limits. Every field is optional; omitted
/// fields use the documented default. napi maps each snake_case field to
/// camelCase in TypeScript.
#[napi(object)]
pub struct ServerOptions {
    /// Tokio worker threads. `1` runs single-threaded; omit for one per CPU core.
    pub worker_threads: Option<u32>,
    /// Max request head (line + headers) size in bytes. Default 65536.
    pub max_header_bytes: Option<u32>,
    /// Max request body size for JS-handled routes in bytes. Default 16 MiB.
    pub max_body_bytes: Option<u32>,
    /// Max headers per request, clamped to a ceiling of 128. Default 64.
    pub max_headers: Option<u32>,
    /// Initial per-connection read buffer in bytes; grows on demand. Default 2048.
    pub read_buffer_bytes: Option<u32>,
    /// How long a single read may stall before the connection drops, in ms. `0`
    /// disables the timeout. Default 30000.
    pub read_timeout_ms: Option<u32>,
    /// How long graceful shutdown waits for connections to drain, in ms. `0`
    /// waits forever. Default 10000.
    pub shutdown_timeout_ms: Option<u32>,
    /// Bind a Unix-domain socket here instead of TCP. When set, `host`/`port` are
    /// ignored, the handle reports port `0`, and TLS does not apply.
    pub unix_path: Option<String>,
    /// PEM certificate chain. With `tls_key`, TCP connections are TLS-wrapped.
    pub tls_cert: Option<String>,
    /// PEM private key matching `tls_cert`. Required to enable TLS.
    pub tls_key: Option<String>,
    /// Set `TCP_NODELAY` on accepted TCP connections. No effect on Unix sockets.
    /// Default `true`.
    pub tcp_nodelay: Option<bool>,
    /// Parse `application/x-www-form-urlencoded` and `multipart/form-data` bodies
    /// natively on dynamic routes, delivered as `HttpRequest.form`. The fast-path
    /// is never affected. Default `false`.
    pub parse_forms: Option<bool>,
    /// Max size of a single uploaded file in bytes; over-limit parts are rejected
    /// with `413`. `None`/`0` means unlimited. Only used when `parse_forms` is on.
    pub max_file_size: Option<u32>,
    /// Allowed upload extensions, lowercase and dot-less (e.g. `["png", "jpg"]`).
    /// Others are rejected with `415`. `None` allows all. Only used with `parse_forms`.
    pub allowed_file_extensions: Option<Vec<String>>,
    /// Directory for uploaded files; each is written there and its path reported
    /// in `FormFile.path`. When unset, bytes are returned inline in `FormFile.data`.
    /// Only used when `parse_forms` is on.
    pub upload_dir: Option<String>,
    /// Static-file mounts served natively. Checked after the native-route table
    /// and before the dynamic router. `None`/empty disables static serving.
    pub static_mounts: Option<Vec<StaticMount>>,
    /// Enable response compression, negotiated against `Accept-Encoding`
    /// (preferring `br`, then `gzip`) for compressible bodies at least
    /// `compression_min_size` bytes. Default `false`.
    pub compression: Option<bool>,
    /// Minimum body size in bytes before compression is attempted. Only used when
    /// `compression` is on. Default 1024.
    pub compression_min_size: Option<u32>,
    /// Headers injected into every response unless already present. Use for fixed
    /// security or CORS headers. `None` injects nothing.
    pub default_headers: Option<Vec<HttpHeader>>,
    /// `X-Powered-By` value. `None` sends "Toki"; `""` disables it; an
    /// `x-powered-by` in `default_headers` wins.
    pub powered_by: Option<String>,
    /// gzip level for per-request responses, clamped to 0-9. Default 6.
    pub gzip_level: Option<u32>,
    /// brotli quality for per-request responses, clamped to 0-11. Default 5.
    pub brotli_quality: Option<u32>,
    /// brotli window (log2) for every brotli encode, clamped to 10-24. Default 22.
    pub brotli_window: Option<u32>,
    /// brotli quality for one-time native-route pre-compression, clamped to 0-11.
    /// Default 11.
    pub brotli_quality_static: Option<u32>,
}

/// Resolved per-connection limits used on the hot path. `Copy` so they are read
/// from [`ServerState`] without indirection.
#[derive(Clone, Copy)]
pub struct Limits {
    pub max_header_bytes: usize,
    pub max_body_bytes: usize,
    pub max_headers: usize,
    pub read_buffer_bytes: usize,
    pub read_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_header_bytes: 64 * 1024,
            max_body_bytes: 16 * 1024 * 1024,
            max_headers: 64,
            read_buffer_bytes: 2 * 1024,
            read_timeout: Duration::from_secs(30),
        }
    }
}

/// Cross-cutting response config for static and dynamic responses. Native routes
/// do not consult this at request time — their default headers are baked in and
/// their compressed variants pre-computed — so the fast path stays free of
/// per-request header or compression work.
pub struct ResponseDefaults {
    pub compression: bool,
    pub compression_min_size: usize,
    pub default_headers: Vec<HttpHeader>,
    pub compression_levels: crate::compress::CompressionLevels,
}

const DEFAULT_COMPRESSION_MIN_SIZE: usize = 1024;

/// Resolved form-parsing config, present only when `parse_forms` was enabled. Its
/// absence keeps every non-form and fast-path request allocation-free.
pub struct FormConfig {
    /// `None` means unlimited.
    pub max_file_size: Option<usize>,
    /// Lowercase, dot-less allow-list; `None` allows everything.
    pub allowed_file_extensions: Option<Vec<String>>,
    /// `None` returns bytes inline instead of streaming to disk.
    pub upload_dir: Option<String>,
}

/// Listener- and lifecycle-level config the runtime thread needs, resolved once
/// from [`ServerOptions`]. Per-connection limits live in [`ServerState`].
struct ResolvedConfig {
    threads: usize,
    limits: Limits,
    /// `None` waits forever for in-flight connections to drain.
    shutdown_timeout: Option<Duration>,
    unix_path: Option<String>,
    /// Applied only to the TCP path.
    tls: Option<TlsAcceptor>,
    tcp_nodelay: bool,
    form_config: Option<FormConfig>,
    static_mounts: Vec<StaticMountResolved>,
    response_defaults: ResponseDefaults,
}

/// Shared, read-only state for every connection task: a method -> path ->
/// pre-rendered response table. Built once in [`listen`] and never mutated, so it
/// is shared across worker threads behind an [`Arc`] without locking.
pub struct ServerState {
    routes: HashMap<String, HashMap<String, Bytes>>,
    /// Pre-compressed variants of each native route, keyed identically to
    /// `routes`. Empty unless compression is enabled.
    precompressed: HashMap<String, HashMap<String, PrecompressedRoute>>,
    dynamic_router: DynamicRouter,
    dispatch: Dispatch,
    limits: Limits,
    form_config: Option<FormConfig>,
    static_mounts: Vec<StaticMountResolved>,
    response_defaults: ResponseDefaults,
}

impl ServerState {
    /// The pre-rendered response for `method` + `path`. Borrowed, so the hot path
    /// writes it with no allocation or refcount churn.
    pub fn lookup(&self, method: &str, path: &str) -> Option<&Bytes> {
        self.routes.get(method).and_then(|paths| paths.get(path))
    }

    pub fn dynamic_router(&self) -> &DynamicRouter {
        &self.dynamic_router
    }

    pub fn dispatch(&self) -> &Dispatch {
        &self.dispatch
    }

    pub fn limits(&self) -> Limits {
        self.limits
    }

    /// `None` when `parse_forms` was not enabled; its presence gates form parsing.
    pub fn form_config(&self) -> Option<&FormConfig> {
        self.form_config.as_ref()
    }

    /// The pre-compressed variant for `encoding`, or `None` (compression off, no
    /// variant, or identity) — in which case the caller serves [`Self::lookup`].
    pub fn lookup_compressed(
        &self,
        method: &str,
        path: &str,
        encoding: Encoding,
    ) -> Option<&Bytes> {
        self.precompressed
            .get(method)
            .and_then(|paths| paths.get(path))
            .and_then(|route| route.variant(encoding))
    }

    /// Empty when no static serving was configured; the loop then skips it.
    pub fn static_mounts(&self) -> &[StaticMountResolved] {
        &self.static_mounts
    }

    pub fn response_defaults(&self) -> &ResponseDefaults {
        &self.response_defaults
    }
}

fn native_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "Status",
    }
}

/// Render a native route into full HTTP/1.1 bytes once at registration, then
/// written verbatim on every hit.
fn render(status: u16, content_type: &str, headers: &[HttpHeader], body: &[u8]) -> Bytes {
    let mut out = Vec::with_capacity(96 + body.len());
    out.extend_from_slice(b"HTTP/1.1 ");
    out.extend_from_slice(status.to_string().as_bytes());
    out.push(b' ');
    out.extend_from_slice(native_reason(status).as_bytes());
    out.extend_from_slice(b"\r\nContent-Type: ");
    out.extend_from_slice(content_type.as_bytes());
    for header in headers {
        out.extend_from_slice(b"\r\n");
        out.extend_from_slice(header.name.as_bytes());
        out.extend_from_slice(b": ");
        out.extend_from_slice(header.value.as_bytes());
    }
    out.extend_from_slice(b"\r\nContent-Length: ");
    out.extend_from_slice(body.len().to_string().as_bytes());
    out.extend_from_slice(b"\r\n\r\n");
    out.extend_from_slice(body);
    Bytes::from(out)
}

/// Render a native route's pre-compressed variant into full HTTP/1.1 bytes,
/// adding `Content-Encoding` / `Vary: Accept-Encoding` and the compressed-body
/// `Content-Length`. Called once per variant at registration.
pub fn render_with_encoding(
    status: u16,
    content_type: &str,
    headers: &[HttpHeader],
    compressed_body: &[u8],
    encoding_token: &str,
) -> Bytes {
    let mut out = Vec::with_capacity(128 + compressed_body.len());
    out.extend_from_slice(b"HTTP/1.1 ");
    out.extend_from_slice(status.to_string().as_bytes());
    out.push(b' ');
    out.extend_from_slice(native_reason(status).as_bytes());
    out.extend_from_slice(b"\r\nContent-Type: ");
    out.extend_from_slice(content_type.as_bytes());
    for header in headers {
        out.extend_from_slice(b"\r\n");
        out.extend_from_slice(header.name.as_bytes());
        out.extend_from_slice(b": ");
        out.extend_from_slice(header.value.as_bytes());
    }
    out.extend_from_slice(b"\r\nContent-Encoding: ");
    out.extend_from_slice(encoding_token.as_bytes());
    out.extend_from_slice(b"\r\nVary: Accept-Encoding");
    out.extend_from_slice(b"\r\nContent-Length: ");
    out.extend_from_slice(compressed_body.len().to_string().as_bytes());
    out.extend_from_slice(b"\r\n\r\n");
    out.extend_from_slice(compressed_body);
    Bytes::from(out)
}

/// The rendered native route table: identity wire bytes plus, when compression is
/// enabled, the parallel pre-compressed variants.
struct BuiltRoutes {
    identity: HashMap<String, HashMap<String, Bytes>>,
    precompressed: HashMap<String, HashMap<String, PrecompressedRoute>>,
}

/// Pre-render every native route into wire bytes, indexed by method then path
/// (later duplicates overwrite earlier). Default headers are baked in here and,
/// when `defaults.compression` is set, gzip/brotli variants are pre-compressed
/// once. A synthesized `HEAD` is then added for every `GET` lacking one.
fn build_routes(routes: Vec<NativeRoute>, defaults: &ResponseDefaults) -> BuiltRoutes {
    let mut identity: HashMap<String, HashMap<String, Bytes>> = HashMap::new();
    let mut precompressed: HashMap<String, HashMap<String, PrecompressedRoute>> = HashMap::new();

    for route in routes {
        let body: Vec<u8> = match route.body {
            Either::A(text) => text.into_bytes(),
            Either::B(buffer) => buffer.to_vec(),
        };
        let mut headers = route.headers.unwrap_or_default();
        merge_default_headers(&mut headers, &defaults.default_headers);

        let rendered = render(route.status, &route.content_type, &headers, &body);

        if defaults.compression {
            let variants = PrecompressedRoute::build(
                route.status,
                &route.content_type,
                &headers,
                &body,
                defaults.compression_min_size,
                defaults.compression_levels,
            );
            precompressed
                .entry(route.method.clone())
                .or_default()
                .insert(route.path.clone(), variants);
        }

        identity
            .entry(route.method)
            .or_default()
            .insert(route.path, rendered);
    }

    synthesize_head_routes(&mut identity);

    BuiltRoutes {
        identity,
        precompressed,
    }
}

/// For every `GET` route without an explicit `HEAD` at the same path, insert a
/// synthesized `HEAD`: the `GET`'s identity bytes truncated at the body start, so
/// the `Content-Length` still reflects the `GET` body but no body is sent (HTTP
/// `HEAD` semantics). No compressed variants are made — a `HEAD` carries no body,
/// so the head slice is served regardless of `Accept-Encoding`.
fn synthesize_head_routes(identity: &mut HashMap<String, HashMap<String, Bytes>>) {
    let Some(get_routes) = identity.get("GET") else {
        return;
    };

    // Collect first so we are not borrowing `identity` while inserting. The whole
    // buffer is used if the marker is somehow absent (it carries no body then).
    let head_entries: Vec<(String, Bytes)> = get_routes
        .iter()
        .map(|(path, rendered)| {
            let head_len = find_head_terminator_end(rendered).unwrap_or(rendered.len());
            (path.clone(), rendered.slice(..head_len))
        })
        .collect();

    let head_routes = identity.entry("HEAD".to_owned()).or_default();
    for (path, head_bytes) in head_entries {
        // Never override an explicitly-registered HEAD route.
        head_routes.entry(path).or_insert(head_bytes);
    }
}

fn find_head_terminator_end(rendered: &[u8]) -> Option<usize> {
    rendered
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|pos| pos + 4)
}

/// Append any default header not already present (case-insensitive) onto a native
/// route's baked-in headers. `Content-Type`/`Content-Length` are emitted by
/// [`render`], so a default named either is skipped.
fn merge_default_headers(headers: &mut Vec<HttpHeader>, defaults: &[HttpHeader]) {
    for default in defaults {
        let name = default.name.as_str();
        if name.eq_ignore_ascii_case("content-type") || name.eq_ignore_ascii_case("content-length")
        {
            continue;
        }
        let present = headers
            .iter()
            .any(|existing| existing.name.eq_ignore_ascii_case(name));
        if !present {
            headers.push(default.clone());
        }
    }
}

const POWERED_BY_HEADER: &str = "X-Powered-By";
const DEFAULT_POWERED_BY: &str = "Toki";

/// User `default_headers` plus `X-Powered-By` ("Toki" by default). A user
/// `x-powered-by` wins; `Some("")` disables it.
fn resolve_default_headers(
    mut headers: Vec<HttpHeader>,
    powered_by: Option<String>,
) -> Vec<HttpHeader> {
    if headers
        .iter()
        .any(|h| h.name.eq_ignore_ascii_case(POWERED_BY_HEADER))
    {
        return headers;
    }
    match powered_by {
        Some(value) if value.is_empty() => headers,
        other => {
            headers.push(HttpHeader {
                name: POWERED_BY_HEADER.to_owned(),
                value: other.unwrap_or_else(|| DEFAULT_POWERED_BY.to_owned()),
            });
            headers
        }
    }
}

fn default_worker_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
}

/// Build a `tokio-rustls` acceptor from PEM cert-chain and key. A malformed or
/// empty blob fails `listen` rather than every later handshake.
fn build_tls_acceptor(cert_pem: &str, key_pem: &str) -> Result<TlsAcceptor> {
    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut cert_pem.as_bytes())
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|err| {
            Error::new(
                Status::InvalidArg,
                format!("failed to parse TLS certificate: {err}"),
            )
        })?;
    if certs.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "TLS certificate PEM contained no certificates",
        ));
    }

    let key: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut key_pem.as_bytes())
        .map_err(|err| {
            Error::new(
                Status::InvalidArg,
                format!("failed to parse TLS private key: {err}"),
            )
        })?
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                "TLS private key PEM contained no private key",
            )
        })?;

    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|err| {
            Error::new(
                Status::InvalidArg,
                format!("invalid TLS certificate/key pair: {err}"),
            )
        })?;

    Ok(TlsAcceptor::from(Arc::new(config)))
}

/// Resolve [`ServerOptions`] into a [`ResolvedConfig`], applying defaults and
/// clamping. TLS material is parsed eagerly so config errors surface from `listen`.
fn resolve_options(options: Option<ServerOptions>) -> Result<ResolvedConfig> {
    let defaults = Limits::default();
    let Some(options) = options else {
        return Ok(ResolvedConfig {
            threads: default_worker_threads(),
            limits: defaults,
            shutdown_timeout: Some(Duration::from_millis(10_000)),
            unix_path: None,
            tls: None,
            tcp_nodelay: true,
            form_config: None,
            static_mounts: Vec::new(),
            response_defaults: ResponseDefaults {
                compression: false,
                compression_min_size: DEFAULT_COMPRESSION_MIN_SIZE,
                // No user options means the default banner still applies.
                default_headers: resolve_default_headers(Vec::new(), None),
                compression_levels: crate::compress::CompressionLevels::default(),
            },
        });
    };

    let threads = match options.worker_threads {
        Some(n) if n >= 1 => n as usize,
        _ => default_worker_threads(),
    };

    let limits = Limits {
        max_header_bytes: options
            .max_header_bytes
            .map(|v| v as usize)
            .unwrap_or(defaults.max_header_bytes),
        max_body_bytes: options
            .max_body_bytes
            .map(|v| v as usize)
            .unwrap_or(defaults.max_body_bytes),
        max_headers: options
            .max_headers
            .map(|v| (v as usize).clamp(1, HEADER_SLOTS))
            .unwrap_or(defaults.max_headers),
        read_buffer_bytes: options
            .read_buffer_bytes
            .map(|v| (v as usize).max(64))
            .unwrap_or(defaults.read_buffer_bytes),
        read_timeout: options
            .read_timeout_ms
            .map(|v| Duration::from_millis(v as u64))
            .unwrap_or(defaults.read_timeout),
    };

    // 0 means "wait forever"; omitted means the 10s default.
    let shutdown_timeout = match options.shutdown_timeout_ms {
        Some(0) => None,
        Some(v) => Some(Duration::from_millis(v as u64)),
        None => Some(Duration::from_millis(10_000)),
    };

    let tls = match (options.tls_cert.as_deref(), options.tls_key.as_deref()) {
        (Some(cert), Some(key)) => Some(build_tls_acceptor(cert, key)?),
        // A cert without a key (or vice versa) is a misconfiguration.
        (Some(_), None) | (None, Some(_)) => {
            return Err(Error::new(
                Status::InvalidArg,
                "TLS requires both tlsCert and tlsKey",
            ));
        }
        (None, None) => None,
    };

    // Built only when parsing is enabled; its absence keeps non-opt-in servers
    // free of form work.
    let form_config = if options.parse_forms.unwrap_or(false) {
        Some(FormConfig {
            // 0 is treated as omitted: unlimited.
            max_file_size: match options.max_file_size {
                Some(0) | None => None,
                Some(v) => Some(v as usize),
            },
            allowed_file_extensions: options.allowed_file_extensions.map(|exts| {
                exts.into_iter()
                    .map(|ext| ext.trim().trim_start_matches('.').to_ascii_lowercase())
                    .collect()
            }),
            upload_dir: options.upload_dir,
        })
    } else {
        None
    };

    // A mount whose directory is missing resolves to `canonical_dir: None` and
    // serves nothing, rather than failing `listen`.
    let static_mounts = options
        .static_mounts
        .unwrap_or_default()
        .into_iter()
        .map(StaticMountResolved::resolve)
        .collect();

    // Each level defaults when omitted and is clamped to the encoder's range, so
    // an out-of-range value is corrected rather than rejected.
    let compression_levels = crate::compress::CompressionLevels {
        gzip_level: options
            .gzip_level
            .unwrap_or(crate::compress::DEFAULT_GZIP_LEVEL)
            .clamp(0, 9),
        brotli_quality: options
            .brotli_quality
            .unwrap_or(crate::compress::DEFAULT_BROTLI_QUALITY)
            .clamp(0, 11),
        brotli_window: options
            .brotli_window
            .unwrap_or(crate::compress::DEFAULT_BROTLI_WINDOW)
            .clamp(10, 24),
        brotli_quality_static: options
            .brotli_quality_static
            .unwrap_or(crate::compress::DEFAULT_BROTLI_QUALITY_STATIC)
            .clamp(0, 11),
    };

    let response_defaults = ResponseDefaults {
        compression: options.compression.unwrap_or(false),
        compression_min_size: options
            .compression_min_size
            .map(|v| v as usize)
            .unwrap_or(DEFAULT_COMPRESSION_MIN_SIZE),
        default_headers: resolve_default_headers(
            options.default_headers.unwrap_or_default(),
            options.powered_by,
        ),
        compression_levels,
    };

    Ok(ResolvedConfig {
        threads,
        limits,
        shutdown_timeout,
        unix_path: options.unix_path,
        tls,
        tcp_nodelay: options.tcp_nodelay.unwrap_or(true),
        form_config,
        static_mounts,
        response_defaults,
    })
}

/// Bind a socket and start serving on a dedicated Tokio runtime, returning once
/// bound. Binds a Unix socket when `unix_path` is set, HTTPS when both `tls_cert`
/// and `tls_key` are set, otherwise plain TCP (port `0` lets the OS choose).
///
/// `routes` are exact-match native routes; `dynamic_routes` are `:param`/`*`
/// patterns whose match crosses into `dispatch` with the route index and decoded
/// params, while a path miss is a native `404` and a method miss a native `405`.
#[napi]
pub fn listen(
    host: String,
    port: u16,
    routes: Vec<NativeRoute>,
    dynamic_routes: Vec<DynamicRoute>,
    dispatch: ThreadsafeFunction<HttpRequest, Promise<HttpResponse>>,
    options: Option<ServerOptions>,
) -> Result<ServerHandle> {
    let mut config = resolve_options(options)?;
    // Built after options resolve so native routes bake in the default headers
    // and any pre-compressed variants.
    let built = build_routes(routes, &config.response_defaults);
    let dynamic_router = DynamicRouter::build(dynamic_routes);

    let (shutdown, signal) = watch::channel(false);
    // The owned fields below are moved into shared state; `config` keeps only its
    // listener/lifecycle fields from here on.
    let state = Arc::new(ServerState {
        routes: built.identity,
        precompressed: built.precompressed,
        dynamic_router,
        dispatch,
        limits: config.limits,
        form_config: config.form_config.take(),
        static_mounts: std::mem::take(&mut config.static_mounts),
        response_defaults: std::mem::replace(
            &mut config.response_defaults,
            ResponseDefaults {
                compression: false,
                compression_min_size: DEFAULT_COMPRESSION_MIN_SIZE,
                default_headers: Vec::new(),
                compression_levels: crate::compress::CompressionLevels::default(),
            },
        ),
    });
    // Reaches zero once all in-flight connections finish — what shutdown waits on.
    let active = Arc::new(AtomicUsize::new(0));

    if let Some(unix_path) = config.unix_path.clone() {
        #[cfg(unix)]
        return spawn_unix(unix_path, config, state, signal, shutdown, active);
        #[cfg(not(unix))]
        return Err(Error::new(
            Status::GenericFailure,
            format!("Unix-domain sockets are not supported on this platform: {unix_path}"),
        ));
    }

    // Bind TCP synchronously so the port and any bind error are known before
    // returning to JavaScript.
    let ip: IpAddr = host
        .parse()
        .map_err(|_| Error::new(Status::InvalidArg, format!("invalid host address: {host}")))?;
    let addr = SocketAddr::new(ip, port);

    let std_listener = std::net::TcpListener::bind(addr).map_err(|err| {
        Error::new(
            Status::GenericFailure,
            format!("failed to bind {addr}: {err}"),
        )
    })?;
    std_listener
        .set_nonblocking(true)
        .map_err(|err| Error::new(Status::GenericFailure, err.to_string()))?;
    let bound_port = std_listener
        .local_addr()
        .map_err(|err| Error::new(Status::GenericFailure, err.to_string()))?
        .port();

    spawn_runtime(config.threads, move || async move {
        let listener = match TcpListener::from_std(std_listener) {
            Ok(listener) => listener,
            Err(_) => return,
        };
        accept_tcp(
            listener,
            state,
            signal,
            active,
            config.tcp_nodelay,
            config.tls,
            config.shutdown_timeout,
        )
        .await;
    })?;

    Ok(ServerHandle {
        shutdown,
        port: bound_port,
    })
}

/// Spawn the runtime thread for a Unix-domain socket, bound inside the runtime;
/// the handle reports port `0`.
#[cfg(unix)]
fn spawn_unix(
    unix_path: String,
    config: ResolvedConfig,
    state: Arc<ServerState>,
    signal: watch::Receiver<bool>,
    shutdown: watch::Sender<bool>,
    active: Arc<AtomicUsize>,
) -> Result<ServerHandle> {
    // Remove a stale socket file so re-binding the same path succeeds; a genuine
    // bind error is reported from inside the runtime.
    let _ = std::fs::remove_file(&unix_path);
    let shutdown_timeout = config.shutdown_timeout;

    spawn_runtime(config.threads, move || async move {
        let listener = match tokio::net::UnixListener::bind(&unix_path) {
            Ok(listener) => listener,
            Err(_) => return,
        };
        accept_unix(listener, state, signal, active, shutdown_timeout).await;
    })?;

    Ok(ServerHandle { shutdown, port: 0 })
}

/// Build the dedicated Tokio runtime on a named std thread and block on `serve`,
/// centralizing the runtime sizing shared by every transport.
fn spawn_runtime<F, Fut>(threads: usize, serve: F) -> Result<()>
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()>,
{
    std::thread::Builder::new()
        .name("toki-runtime".into())
        .stack_size(512 * 1024)
        .spawn(move || {
            let mut builder = if threads <= 1 {
                Builder::new_current_thread()
            } else {
                let mut b = Builder::new_multi_thread();
                b.worker_threads(threads);
                b.thread_stack_size(512 * 1024);
                b
            };
            let runtime = builder
                .enable_all()
                .build()
                .expect("failed to build Tokio runtime");
            runtime.block_on(serve());
        })
        .map_err(|err| Error::new(Status::GenericFailure, err.to_string()))?;
    Ok(())
}

/// Wait for in-flight connections to drain after the accept loop stops, returning
/// once `active` reaches zero or `timeout` elapses (`None` waits forever). The
/// poll runs only during shutdown, so its interval adds no steady-state overhead.
async fn drain(active: Arc<AtomicUsize>, timeout: Option<Duration>) {
    if active.load(Ordering::Acquire) == 0 {
        return;
    }
    let poll = Duration::from_millis(10);
    let deadline = timeout.map(|t| tokio::time::Instant::now() + t);
    loop {
        if active.load(Ordering::Acquire) == 0 {
            return;
        }
        if let Some(deadline) = deadline {
            if tokio::time::Instant::now() >= deadline {
                return;
            }
        }
        tokio::time::sleep(poll).await;
    }
}

/// Accept TCP connections until shutdown, optionally TLS-wrapping each, then
/// drain. A TLS handshake failure drops only that connection.
async fn accept_tcp(
    listener: TcpListener,
    state: Arc<ServerState>,
    mut shutdown: watch::Receiver<bool>,
    active: Arc<AtomicUsize>,
    tcp_nodelay: bool,
    tls: Option<TlsAcceptor>,
    shutdown_timeout: Option<Duration>,
) {
    if *shutdown.borrow() {
        return;
    }

    loop {
        let stream = tokio::select! {
            _ = shutdown.changed() => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, _peer)) => stream,
                // Transient accept errors (e.g. fd exhaustion) shouldn't kill
                // the loop; retry on the next poll.
                Err(_) => continue,
            },
        };

        if tcp_nodelay {
            let _ = stream.set_nodelay(true);
        }

        let state = Arc::clone(&state);
        let guard = ConnGuard::new(Arc::clone(&active));

        match tls.clone() {
            Some(acceptor) => {
                tokio::spawn(async move {
                    // Hold the guard across the handshake so a slow handshake
                    // still blocks graceful shutdown; a failed one drops it here.
                    let _guard = guard;
                    if let Ok(tls_stream) = acceptor.accept(stream).await {
                        let _ = crate::http::serve_connection(tls_stream, state).await;
                    }
                });
            }
            None => {
                tokio::spawn(async move {
                    let _guard = guard;
                    let _ = crate::http::serve_connection(stream, state).await;
                });
            }
        }
    }

    drain(active, shutdown_timeout).await;
}

/// Accept Unix-domain connections until shutdown, then drain. Mirrors
/// [`accept_tcp`] without the TCP-only `TCP_NODELAY` and TLS.
#[cfg(unix)]
async fn accept_unix(
    listener: tokio::net::UnixListener,
    state: Arc<ServerState>,
    mut shutdown: watch::Receiver<bool>,
    active: Arc<AtomicUsize>,
    shutdown_timeout: Option<Duration>,
) {
    if *shutdown.borrow() {
        return;
    }

    loop {
        let stream = tokio::select! {
            _ = shutdown.changed() => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, _peer)) => stream,
                Err(_) => continue,
            },
        };

        let state = Arc::clone(&state);
        let guard = ConnGuard::new(Arc::clone(&active));
        tokio::spawn(async move {
            let _guard = guard;
            let _ = crate::http::serve_connection(stream, state).await;
        });
    }

    drain(active, shutdown_timeout).await;
}

/// A running server. Dropping the handle does not stop the server; call
/// [`ServerHandle::close`] to begin a graceful shutdown.
#[napi]
pub struct ServerHandle {
    shutdown: watch::Sender<bool>,
    port: u16,
}

#[napi]
impl ServerHandle {
    /// The port the server is listening on (the OS-chosen port when bound to `0`).
    /// Returns `0` for Unix-socket servers.
    #[napi(getter)]
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Begin a graceful shutdown: stop accepting, let in-flight requests finish,
    /// and drain (bounded by `shutdownTimeoutMs`). Idempotent.
    #[napi]
    pub fn close(&self) {
        let _ = self.shutdown.send(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(name: &str, value: &str) -> HttpHeader {
        HttpHeader {
            name: name.to_owned(),
            value: value.to_owned(),
        }
    }

    fn native_route(method: &str, path: &str, body: &str) -> NativeRoute {
        NativeRoute {
            method: method.to_owned(),
            path: path.to_owned(),
            status: 200,
            content_type: "text/plain".to_owned(),
            body: Either::A(body.to_owned()),
            headers: None,
        }
    }

    fn no_compression() -> ResponseDefaults {
        ResponseDefaults {
            compression: false,
            compression_min_size: DEFAULT_COMPRESSION_MIN_SIZE,
            default_headers: Vec::new(),
            compression_levels: crate::compress::CompressionLevels::default(),
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

    fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
        headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn render_emits_status_content_type_and_length() {
        let bytes = render(200, "text/html", &[], b"hi");
        let (status, headers) = parse_head(&bytes);
        assert_eq!(status, "HTTP/1.1 200 OK");
        assert_eq!(header_value(&headers, "Content-Type"), Some("text/html"));
        assert_eq!(header_value(&headers, "Content-Length"), Some("2"));
        assert!(bytes.ends_with(b"\r\n\r\nhi"));
    }

    #[test]
    fn render_includes_extra_headers() {
        let bytes = render(201, "text/plain", &[header("X-Custom", "v")], b"");
        let (status, headers) = parse_head(&bytes);
        assert_eq!(status, "HTTP/1.1 201 Created");
        assert_eq!(header_value(&headers, "X-Custom"), Some("v"));
    }

    #[test]
    fn native_reason_falls_back_for_unknown_status() {
        assert_eq!(native_reason(200), "OK");
        assert_eq!(native_reason(204), "No Content");
        assert_eq!(native_reason(418), "Status");
    }

    #[test]
    fn merge_default_headers_adds_absent_and_skips_present() {
        let mut headers = vec![header("X-A", "keep")];
        let defaults = vec![header("X-A", "override"), header("X-B", "add")];
        merge_default_headers(&mut headers, &defaults);
        assert_eq!(headers.iter().filter(|h| h.name == "X-A").count(), 1);
        assert_eq!(
            headers.iter().find(|h| h.name == "X-A").unwrap().value,
            "keep"
        );
        assert!(headers.iter().any(|h| h.name == "X-B" && h.value == "add"));
    }

    #[test]
    fn merge_default_headers_never_adds_content_type_or_length() {
        let mut headers = Vec::new();
        let defaults = vec![
            header("Content-Type", "x"),
            header("Content-Length", "9"),
            header("X-Keep", "1"),
        ];
        merge_default_headers(&mut headers, &defaults);
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0].name, "X-Keep");
    }

    #[test]
    fn build_routes_bakes_default_headers_into_native_bytes() {
        let mut defaults = no_compression();
        defaults.default_headers = vec![header("X-Frame-Options", "DENY")];
        let built = build_routes(vec![native_route("GET", "/", "ok")], &defaults);
        let bytes = built.identity.get("GET").unwrap().get("/").unwrap();
        let (_, headers) = parse_head(bytes);
        assert_eq!(header_value(&headers, "X-Frame-Options"), Some("DENY"));
    }

    #[test]
    fn build_routes_skips_precompression_when_disabled() {
        let built = build_routes(vec![native_route("GET", "/", "ok")], &no_compression());
        assert!(built.precompressed.is_empty());
    }

    #[test]
    fn build_routes_synthesizes_head_from_get() {
        let built = build_routes(
            vec![native_route("GET", "/page", "body-bytes")],
            &no_compression(),
        );
        let get = built.identity.get("GET").unwrap().get("/page").unwrap();
        let head = built.identity.get("HEAD").unwrap().get("/page").unwrap();

        // HEAD is the GET head with no body but the GET's Content-Length.
        let (_, head_headers) = parse_head(head);
        assert_eq!(header_value(&head_headers, "Content-Length"), Some("10"));
        let split = head.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        assert_eq!(head.len(), split);
        assert!(head.len() < get.len());
    }

    #[test]
    fn build_routes_does_not_override_explicit_head() {
        let routes = vec![
            native_route("GET", "/p", "get-body"),
            NativeRoute {
                method: "HEAD".to_owned(),
                path: "/p".to_owned(),
                status: 200,
                content_type: "text/plain".to_owned(),
                body: Either::A(String::new()),
                headers: Some(vec![header("X-Explicit", "yes")]),
            },
        ];
        let built = build_routes(routes, &no_compression());
        let head = built.identity.get("HEAD").unwrap().get("/p").unwrap();
        let (_, headers) = parse_head(head);
        assert_eq!(header_value(&headers, "X-Explicit"), Some("yes"));
    }

    #[test]
    fn render_with_encoding_sets_content_encoding_and_vary() {
        let bytes = render_with_encoding(200, "text/plain", &[], b"compressed", "br");
        let (status, headers) = parse_head(&bytes);
        assert_eq!(status, "HTTP/1.1 200 OK");
        assert_eq!(header_value(&headers, "Content-Encoding"), Some("br"));
        assert_eq!(header_value(&headers, "Vary"), Some("Accept-Encoding"));
        assert_eq!(header_value(&headers, "Content-Length"), Some("10"));
    }

    #[test]
    fn resolve_options_applies_defaults_when_none() {
        let config = resolve_options(None).unwrap();
        let limits = Limits::default();
        assert_eq!(config.limits.max_header_bytes, limits.max_header_bytes);
        assert_eq!(config.limits.max_headers, limits.max_headers);
        assert!(config.tls.is_none());
        assert!(config.form_config.is_none());
        assert!(config.tcp_nodelay);
        assert_eq!(config.shutdown_timeout, Some(Duration::from_millis(10_000)));
    }

    #[test]
    fn resolve_options_clamps_max_headers_to_ceiling() {
        let options = ServerOptions {
            max_headers: Some(10_000),
            ..empty_options()
        };
        let config = resolve_options(Some(options)).unwrap();
        assert_eq!(config.limits.max_headers, HEADER_SLOTS);
    }

    #[test]
    fn resolve_options_treats_zero_shutdown_as_forever() {
        let options = ServerOptions {
            shutdown_timeout_ms: Some(0),
            ..empty_options()
        };
        let config = resolve_options(Some(options)).unwrap();
        assert_eq!(config.shutdown_timeout, None);
    }

    #[test]
    fn resolve_options_zero_max_file_size_means_unlimited() {
        let options = ServerOptions {
            parse_forms: Some(true),
            max_file_size: Some(0),
            ..empty_options()
        };
        let config = resolve_options(Some(options)).unwrap();
        assert_eq!(config.form_config.unwrap().max_file_size, None);
    }

    #[test]
    fn resolve_options_normalizes_extension_allow_list() {
        let options = ServerOptions {
            parse_forms: Some(true),
            allowed_file_extensions: Some(vec![".PNG".to_owned(), "  jpg ".to_owned()]),
            ..empty_options()
        };
        let config = resolve_options(Some(options)).unwrap();
        let exts = config.form_config.unwrap().allowed_file_extensions.unwrap();
        assert_eq!(exts, vec!["png", "jpg"]);
    }

    #[test]
    fn resolve_options_rejects_tls_cert_without_key() {
        let options = ServerOptions {
            tls_cert: Some("cert".to_owned()),
            ..empty_options()
        };
        assert!(resolve_options(Some(options)).is_err());
    }

    #[test]
    fn resolve_options_clamps_compression_levels() {
        let options = ServerOptions {
            compression: Some(true),
            gzip_level: Some(99),
            brotli_quality: Some(99),
            brotli_window: Some(99),
            ..empty_options()
        };
        let config = resolve_options(Some(options)).unwrap();
        let levels = config.response_defaults.compression_levels;
        assert_eq!(levels.gzip_level, 9);
        assert_eq!(levels.brotli_quality, 11);
        assert_eq!(levels.brotli_window, 24);
    }

    /// The resolved default-header value for `name`, case-insensitive.
    fn resolved_header<'a>(config: &'a ResolvedConfig, name: &str) -> Option<&'a str> {
        config
            .response_defaults
            .default_headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case(name))
            .map(|h| h.value.as_str())
    }

    #[test]
    fn powered_by_defaults_to_toki_when_unset() {
        // Both the explicit-options path and the no-options path get the banner.
        let with_options = resolve_options(Some(empty_options())).unwrap();
        assert_eq!(resolved_header(&with_options, "X-Powered-By"), Some("Toki"));
        let no_options = resolve_options(None).unwrap();
        assert_eq!(resolved_header(&no_options, "X-Powered-By"), Some("Toki"));
    }

    #[test]
    fn powered_by_custom_value_replaces_toki() {
        let options = ServerOptions {
            powered_by: Some("Acme/2".to_owned()),
            ..empty_options()
        };
        let config = resolve_options(Some(options)).unwrap();
        assert_eq!(resolved_header(&config, "X-Powered-By"), Some("Acme/2"));
    }

    #[test]
    fn empty_powered_by_disables_the_banner() {
        let options = ServerOptions {
            powered_by: Some(String::new()),
            ..empty_options()
        };
        let config = resolve_options(Some(options)).unwrap();
        assert_eq!(resolved_header(&config, "X-Powered-By"), None);
    }

    #[test]
    fn explicit_default_header_overrides_powered_by() {
        // A user X-Powered-By wins outright, even against a custom powered_by.
        let options = ServerOptions {
            default_headers: Some(vec![header("X-Powered-By", "Custom")]),
            powered_by: Some("Ignored".to_owned()),
            ..empty_options()
        };
        let config = resolve_options(Some(options)).unwrap();
        assert_eq!(resolved_header(&config, "X-Powered-By"), Some("Custom"));
        // The override is the single source — the field adds no second entry.
        assert_eq!(
            config
                .response_defaults
                .default_headers
                .iter()
                .filter(|h| h.name.eq_ignore_ascii_case("x-powered-by"))
                .count(),
            1
        );
    }

    #[test]
    fn explicit_default_header_case_insensitive_match_disables_field() {
        // A differently-cased user header still counts as the override, so a
        // Some("") field does not re-disable an explicitly-set banner.
        let options = ServerOptions {
            default_headers: Some(vec![header("x-POWERED-by", "Custom")]),
            powered_by: Some(String::new()),
            ..empty_options()
        };
        let config = resolve_options(Some(options)).unwrap();
        assert_eq!(resolved_header(&config, "X-Powered-By"), Some("Custom"));
    }

    #[test]
    fn user_default_headers_are_preserved_alongside_powered_by() {
        let options = ServerOptions {
            default_headers: Some(vec![header("X-Frame-Options", "DENY")]),
            ..empty_options()
        };
        let config = resolve_options(Some(options)).unwrap();
        assert_eq!(resolved_header(&config, "X-Frame-Options"), Some("DENY"));
        assert_eq!(resolved_header(&config, "X-Powered-By"), Some("Toki"));
    }

    fn empty_options() -> ServerOptions {
        ServerOptions {
            worker_threads: None,
            max_header_bytes: None,
            max_body_bytes: None,
            max_headers: None,
            read_buffer_bytes: None,
            read_timeout_ms: None,
            shutdown_timeout_ms: None,
            unix_path: None,
            tls_cert: None,
            tls_key: None,
            tcp_nodelay: None,
            parse_forms: None,
            max_file_size: None,
            allowed_file_extensions: None,
            upload_dir: None,
            static_mounts: None,
            compression: None,
            compression_min_size: None,
            default_headers: None,
            powered_by: None,
            gzip_level: None,
            brotli_quality: None,
            brotli_window: None,
            brotli_quality_static: None,
        }
    }
}
