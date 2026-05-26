//! `Accept-Encoding` negotiation and the gzip/brotli encoders.
//!
//! Native routes are compressed once at registration ([`PrecompressedRoute`]);
//! static and dynamic responses are compressed per request. Brotli wins over
//! gzip when a client accepts both.

use std::io::Write;

use bytes::Bytes;
use flate2::write::GzEncoder;
use flate2::Compression;

use crate::convert::HttpHeader;
use crate::server::render_with_encoding;

/// gzip level for native pre-compression: paid once, so use the max ratio.
const GZIP_STATIC_LEVEL: u32 = 9;

pub const DEFAULT_GZIP_LEVEL: u32 = 6;
pub const DEFAULT_BROTLI_QUALITY: u32 = 5;
pub const DEFAULT_BROTLI_WINDOW: u32 = 22;
pub const DEFAULT_BROTLI_QUALITY_STATIC: u32 = 11;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Encoding {
    Identity,
    Gzip,
    Brotli,
}

impl Encoding {
    /// The `Content-Encoding` token, or `None` for identity (no header).
    pub fn token(self) -> Option<&'static str> {
        match self {
            Encoding::Identity => None,
            Encoding::Gzip => Some("gzip"),
            Encoding::Brotli => Some("br"),
        }
    }
}

/// Range-clamped compression tuning, resolved from `ServerOptions`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompressionLevels {
    pub gzip_level: u32,
    pub brotli_quality: u32,
    pub brotli_window: u32,
    pub brotli_quality_static: u32,
}

impl Default for CompressionLevels {
    fn default() -> Self {
        Self {
            gzip_level: DEFAULT_GZIP_LEVEL,
            brotli_quality: DEFAULT_BROTLI_QUALITY,
            brotli_window: DEFAULT_BROTLI_WINDOW,
            brotli_quality_static: DEFAULT_BROTLI_QUALITY_STATIC,
        }
    }
}

/// Pick the best supported coding, preferring brotli. `q=0` rejects a coding;
/// `*` lets the server choose. An absent header yields identity.
pub fn negotiate(accept_encoding: Option<&str>) -> Encoding {
    let Some(header) = accept_encoding else {
        return Encoding::Identity;
    };

    let (mut brotli, mut gzip, mut wildcard) = (false, false, false);
    for entry in header.split(',') {
        let (token, params) = match entry.split_once(';') {
            Some((token, params)) => (token.trim(), params),
            None => (entry.trim(), ""),
        };
        if token.is_empty() || quality(params) <= 0.0 {
            continue;
        }
        if token.eq_ignore_ascii_case("br") {
            brotli = true;
        } else if token.eq_ignore_ascii_case("gzip") {
            gzip = true;
        } else if token == "*" {
            wildcard = true;
        }
    }

    if brotli {
        Encoding::Brotli
    } else if gzip {
        Encoding::Gzip
    } else if wildcard {
        Encoding::Brotli
    } else {
        Encoding::Identity
    }
}

/// `q` weight of an entry's parameters; absent or unparsable counts as 1.0, so
/// only an explicit `q=0` rejects a coding.
fn quality(params: &str) -> f32 {
    for param in params.split(';') {
        let param = param.trim();
        if let Some(q) = param
            .strip_prefix("q=")
            .or_else(|| param.strip_prefix("Q="))
        {
            return q.trim().parse().unwrap_or(1.0);
        }
    }
    1.0
}

/// Whether a `Content-Type` is worth compressing: text, JSON/XML and their
/// `+json`/`+xml` suffixes, and a few structured `application/*` types.
pub fn is_compressible(content_type: &str) -> bool {
    let media = match content_type.split_once(';') {
        Some((media, _)) => media.trim(),
        None => content_type.trim(),
    };
    starts_with_ci(media, "text/")
        || ends_with_ci(media, "+json")
        || ends_with_ci(media, "+xml")
        || STRUCTURED_TEXT
            .iter()
            .any(|t| media.eq_ignore_ascii_case(t))
}

const STRUCTURED_TEXT: &[&str] = &[
    "application/json",
    "application/javascript",
    "application/x-javascript",
    "application/ecmascript",
    "application/xml",
    "application/graphql",
    "application/wasm",
    "image/svg+xml",
    "image/x-icon",
    "font/ttf",
    "font/otf",
];

fn starts_with_ci(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix)
}

fn ends_with_ci(s: &str, suffix: &str) -> bool {
    s.len() >= suffix.len() && s[s.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
}

/// Compress `data` for `encoding`. `None` means "send it unchanged": either
/// identity was negotiated or the encoder failed and the caller should fall back.
pub fn compress(data: &[u8], encoding: Encoding, levels: CompressionLevels) -> Option<Vec<u8>> {
    match encoding {
        Encoding::Identity => None,
        Encoding::Gzip => gzip(data, levels.gzip_level),
        Encoding::Brotli => brotli(data, levels.brotli_quality, levels.brotli_window),
    }
}

fn gzip(data: &[u8], level: u32) -> Option<Vec<u8>> {
    let mut encoder = GzEncoder::new(
        Vec::with_capacity(data.len() / 2 + 64),
        Compression::new(level),
    );
    encoder.write_all(data).ok()?;
    encoder.finish().ok()
}

fn brotli(data: &[u8], quality: u32, window: u32) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(data.len() / 2 + 64);
    let mut input = data;
    brotli::BrotliCompress(
        &mut input,
        &mut out,
        &brotli::enc::BrotliEncoderParams {
            quality: quality as i32,
            lgwin: window as i32,
            ..Default::default()
        },
    )
    .ok()?;
    Some(out)
}

/// gzip and brotli variants of a native route's full wire bytes, built once.
/// Each holds the complete response (headers with `Content-Encoding`/`Vary` and
/// the corrected `Content-Length`, then the compressed body), so a hit is one
/// borrowed write. A variant is absent when compressing wouldn't help.
#[derive(Default)]
pub struct PrecompressedRoute {
    pub gzip: Option<Bytes>,
    pub brotli: Option<Bytes>,
}

impl PrecompressedRoute {
    pub fn variant(&self, encoding: Encoding) -> Option<&Bytes> {
        match encoding {
            Encoding::Identity => None,
            Encoding::Gzip => self.gzip.as_ref(),
            Encoding::Brotli => self.brotli.as_ref(),
        }
    }

    pub fn build(
        status: u16,
        content_type: &str,
        headers: &[HttpHeader],
        body: &[u8],
        min_size: usize,
        levels: CompressionLevels,
    ) -> Self {
        if body.len() < min_size || !is_compressible(content_type) {
            return Self::default();
        }
        let render = |compressed: &[u8], token| {
            render_with_encoding(status, content_type, headers, compressed, token)
        };
        Self {
            gzip: gzip(body, GZIP_STATIC_LEVEL).map(|body| render(&body, "gzip")),
            brotli: brotli(body, levels.brotli_quality_static, levels.brotli_window)
                .map(|body| render(&body, "br")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::GzDecoder;
    use std::io::Read;

    fn sample() -> Vec<u8> {
        b"the quick brown fox jumps over the lazy dog. ".repeat(40)
    }

    #[test]
    fn token_maps_to_header_value() {
        assert_eq!(Encoding::Identity.token(), None);
        assert_eq!(Encoding::Gzip.token(), Some("gzip"));
        assert_eq!(Encoding::Brotli.token(), Some("br"));
    }

    #[test]
    fn prefers_brotli_then_gzip_then_identity() {
        assert_eq!(negotiate(Some("gzip, deflate, br")), Encoding::Brotli);
        assert_eq!(negotiate(Some("gzip, deflate")), Encoding::Gzip);
        assert_eq!(negotiate(Some("deflate, compress")), Encoding::Identity);
    }

    #[test]
    fn identity_when_header_absent_or_empty() {
        assert_eq!(negotiate(None), Encoding::Identity);
        assert_eq!(negotiate(Some("")), Encoding::Identity);
        assert_eq!(negotiate(Some("   ,  , ")), Encoding::Identity);
    }

    #[test]
    fn negotiation_ignores_whitespace_and_case() {
        assert_eq!(negotiate(Some("  GZIP  ")), Encoding::Gzip);
        assert_eq!(negotiate(Some("Br ; q=1.0")), Encoding::Brotli);
    }

    #[test]
    fn zero_quality_rejects_a_coding() {
        assert_eq!(negotiate(Some("br;q=0, gzip")), Encoding::Gzip);
        assert_eq!(negotiate(Some("br;q=0, gzip;q=0")), Encoding::Identity);
        assert_eq!(negotiate(Some("br;q=0.001, gzip")), Encoding::Brotli);
    }

    #[test]
    fn wildcard_is_served_brotli_but_yields_to_named_gzip() {
        assert_eq!(negotiate(Some("*")), Encoding::Brotli);
        assert_eq!(negotiate(Some("gzip, *")), Encoding::Gzip);
        assert_eq!(negotiate(Some("br, *")), Encoding::Brotli);
    }

    #[test]
    fn compressible_covers_text_and_structured_types() {
        assert!(is_compressible("text/html; charset=utf-8"));
        assert!(is_compressible("TEXT/PLAIN"));
        assert!(is_compressible("application/json"));
        assert!(is_compressible("image/svg+xml"));
        assert!(is_compressible("application/vnd.api+json"));
        assert!(is_compressible("application/custom+xml"));
    }

    #[test]
    fn incompressible_binary_and_edge_strings() {
        assert!(!is_compressible("image/png"));
        assert!(!is_compressible("video/mp4"));
        assert!(!is_compressible("application/octet-stream"));
        assert!(!is_compressible(""));
        assert!(!is_compressible("te"));
        assert!(!is_compressible("application/json-but-not-really"));
    }

    #[test]
    fn identity_compression_is_a_no_op() {
        assert_eq!(
            compress(
                b"anything",
                Encoding::Identity,
                CompressionLevels::default()
            ),
            None
        );
    }

    #[test]
    fn gzip_round_trips_and_shrinks() {
        let data = sample();
        let encoded =
            compress(&data, Encoding::Gzip, CompressionLevels::default()).expect("encoded");
        assert!(encoded.len() < data.len());

        let mut decoded = Vec::new();
        GzDecoder::new(&encoded[..])
            .read_to_end(&mut decoded)
            .expect("decoded");
        assert_eq!(decoded, data);
    }

    #[test]
    fn brotli_shrinks_repetitive_input() {
        let data = sample();
        let encoded =
            compress(&data, Encoding::Brotli, CompressionLevels::default()).expect("encoded");
        assert!(encoded.len() < data.len());
    }

    #[test]
    fn precompress_skips_small_or_binary_bodies() {
        let levels = CompressionLevels::default();
        let big_text = sample();
        let route = PrecompressedRoute::build(200, "text/plain", &[], &big_text, 64, levels);
        assert!(route.variant(Encoding::Gzip).is_some());
        assert!(route.variant(Encoding::Brotli).is_some());
        assert!(route.variant(Encoding::Identity).is_none());

        let too_small = PrecompressedRoute::build(200, "text/plain", &[], b"hi", 64, levels);
        assert!(too_small.variant(Encoding::Gzip).is_none());

        let binary = PrecompressedRoute::build(200, "image/png", &[], &big_text, 64, levels);
        assert!(binary.variant(Encoding::Brotli).is_none());
    }
}
