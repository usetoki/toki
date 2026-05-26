//! Native request-metadata parsing for the dynamic path: query strings, cookies,
//! per-request ids, and the dynamic router itself. None of this runs on the
//! fast-path — a route-table hit is answered from pre-rendered bytes.

use std::collections::HashMap;

use percent_encoding::percent_decode_str;

use crate::convert::{DynamicRoute, Param};

/// Per-method dynamic router. Each method maps to a radix-tree router whose values
/// are indices into the original `dynamicRoutes` array. Built once and shared
/// read-only across worker threads.
pub struct DynamicRouter {
    by_method: HashMap<String, matchit::Router<usize>>,
}

pub enum RouteMatch {
    Matched {
        index: usize,
        params: Vec<Param>,
    },
    NotFound,
    /// The path matched under other methods only; answer `405` with these
    /// (sorted, deduplicated) in the `Allow` header.
    MethodNotAllowed {
        allow: Vec<String>,
    },
}

impl DynamicRouter {
    pub fn build(routes: Vec<DynamicRoute>) -> Self {
        let mut by_method: HashMap<String, matchit::Router<usize>> = HashMap::new();
        for (index, route) in routes.into_iter().enumerate() {
            let translated = translate_pattern(&route.pattern);
            let router = by_method.entry(route.method).or_default();
            // A duplicate or invalid pattern is dropped rather than failing the
            // whole `listen`; the first registration for a method+pattern wins.
            let _ = router.insert(translated, index);
        }
        Self { by_method }
    }

    /// Resolve `method` + `path`, assuming the exact route table already missed.
    pub fn resolve(&self, method: &str, path: &str) -> RouteMatch {
        if let Some(router) = self.by_method.get(method) {
            if let Ok(matched) = router.at(path) {
                let params = matched
                    .params
                    .iter()
                    .map(|(name, value)| Param {
                        name: name.to_owned(),
                        value: percent_decode(value),
                    })
                    .collect();
                return RouteMatch::Matched {
                    index: *matched.value,
                    params,
                };
            }
        }

        // The method missed; probe the others to tell a 404 from a 405.
        let mut allow: Vec<String> = self
            .by_method
            .iter()
            .filter(|(other, router)| *other != method && router.at(path).is_ok())
            .map(|(other, _)| other.clone())
            .collect();

        if allow.is_empty() {
            RouteMatch::NotFound
        } else {
            allow.sort();
            allow.dedup();
            RouteMatch::MethodNotAllowed { allow }
        }
    }
}

/// Translate Toki's pattern syntax into matchit's: `:name` segments become
/// `{name}` and a trailing `*` becomes `{*wildcard}`. The split is segment-based,
/// so a `:` or `*` mid-segment is a literal.
fn translate_pattern(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len() + 8);
    let mut first = true;
    for segment in pattern.split('/') {
        if first {
            first = false;
        } else {
            out.push('/');
        }
        if let Some(name) = segment.strip_prefix(':') {
            out.push('{');
            out.push_str(name);
            out.push('}');
        } else if segment == "*" {
            out.push_str("{*wildcard}");
        } else {
            out.push_str(segment);
        }
    }
    out
}

/// Parse a query string into ordered pairs. Names and values are percent-decoded
/// and `+` is treated as a space, matching browser form encoding. A key with no
/// `=` yields an empty value.
pub fn parse_query(query: &str) -> Vec<Param> {
    if query.is_empty() {
        return Vec::new();
    }
    form_urlencoded::parse(query.as_bytes())
        .map(|(name, value)| Param {
            name: name.into_owned(),
            value: value.into_owned(),
        })
        .collect()
}

/// Parse a `Cookie` header into ordered pairs. Cookies split on `;`, each on its
/// first `=`; whitespace is trimmed and one layer of surrounding double quotes is
/// stripped before percent-decoding. A cookie with no `=` yields an empty value.
pub fn parse_cookies(header: &str) -> Vec<Param> {
    let mut cookies = Vec::new();
    for part in header.split(';') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (name, value) = match part.split_once('=') {
            Some((name, value)) => (name.trim(), value.trim()),
            None => (part, ""),
        };
        if name.is_empty() {
            continue;
        }
        // RFC 6265 quoted cookie-value form.
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .unwrap_or(value);
        cookies.push(Param {
            name: name.to_owned(),
            value: percent_decode(value),
        });
    }
    cookies
}

/// Percent-decode lossily. `+` is left as-is — cookie and path-parameter values,
/// unlike form fields, do not use `+` for space.
fn percent_decode(value: &str) -> String {
    percent_decode_str(value).decode_utf8_lossy().into_owned()
}

/// A per-request id: 16 CSPRNG bytes, lowercase hex-encoded into 32 chars. Falls
/// back to all-zero bytes if the OS entropy source fails, rather than failing the
/// request.
pub fn generate_request_id() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        bytes = [0u8; 16];
    }
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut id = String::with_capacity(32);
    for byte in bytes {
        id.push(HEX[(byte >> 4) as usize] as char);
        id.push(HEX[(byte & 0x0f) as usize] as char);
    }
    id
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(method: &str, pattern: &str) -> DynamicRoute {
        DynamicRoute {
            method: method.to_owned(),
            pattern: pattern.to_owned(),
        }
    }

    #[test]
    fn translates_named_params() {
        assert_eq!(translate_pattern("/users/:id"), "/users/{id}");
        assert_eq!(translate_pattern("/a/:b/c/:d"), "/a/{b}/c/{d}");
    }

    #[test]
    fn translates_trailing_wildcard() {
        assert_eq!(translate_pattern("/files/*"), "/files/{*wildcard}");
    }

    #[test]
    fn translates_literal_segments_unchanged() {
        assert_eq!(translate_pattern("/static"), "/static");
        assert_eq!(translate_pattern("/"), "/");
    }

    #[test]
    fn colon_mid_segment_is_literal() {
        assert_eq!(translate_pattern("/a:b"), "/a:b");
        assert_eq!(translate_pattern("/x/y*z"), "/x/y*z");
    }

    #[test]
    fn resolves_matched_route_with_decoded_params() {
        let router = DynamicRouter::build(vec![route("GET", "/users/:id")]);
        match router.resolve("GET", "/users/42") {
            RouteMatch::Matched { index, params } => {
                assert_eq!(index, 0);
                assert_eq!(params.len(), 1);
                assert_eq!(params[0].name, "id");
                assert_eq!(params[0].value, "42");
            }
            _ => panic!("expected match"),
        }
    }

    #[test]
    fn decodes_percent_encoded_path_param() {
        let router = DynamicRouter::build(vec![route("GET", "/items/:name")]);
        match router.resolve("GET", "/items/a%20b") {
            RouteMatch::Matched { params, .. } => assert_eq!(params[0].value, "a b"),
            _ => panic!("expected match"),
        }
    }

    #[test]
    fn route_index_reflects_registration_order() {
        let router = DynamicRouter::build(vec![
            route("GET", "/a"),
            route("GET", "/b"),
            route("GET", "/c"),
        ]);
        match router.resolve("GET", "/c") {
            RouteMatch::Matched { index, .. } => assert_eq!(index, 2),
            _ => panic!("expected match"),
        }
    }

    #[test]
    fn unmatched_path_is_not_found() {
        let router = DynamicRouter::build(vec![route("GET", "/users/:id")]);
        assert!(matches!(
            router.resolve("GET", "/nope"),
            RouteMatch::NotFound
        ));
    }

    #[test]
    fn wrong_method_on_known_path_is_method_not_allowed() {
        let router = DynamicRouter::build(vec![
            route("GET", "/users/:id"),
            route("POST", "/users/:id"),
        ]);
        match router.resolve("DELETE", "/users/42") {
            RouteMatch::MethodNotAllowed { allow } => assert_eq!(allow, vec!["GET", "POST"]),
            _ => panic!("expected 405"),
        }
    }

    #[test]
    fn allow_list_is_sorted_and_deduplicated() {
        let router = DynamicRouter::build(vec![
            route("PUT", "/r"),
            route("DELETE", "/r"),
            route("PATCH", "/r"),
        ]);
        match router.resolve("GET", "/r") {
            RouteMatch::MethodNotAllowed { allow } => {
                assert_eq!(allow, vec!["DELETE", "PATCH", "PUT"]);
            }
            _ => panic!("expected 405"),
        }
    }

    #[test]
    fn unknown_method_with_no_routes_is_not_found() {
        let router = DynamicRouter::build(vec![route("GET", "/a")]);
        assert!(matches!(router.resolve("GET", "/b"), RouteMatch::NotFound));
    }

    #[test]
    fn catch_all_captures_remaining_segments() {
        let router = DynamicRouter::build(vec![route("GET", "/files/*")]);
        match router.resolve("GET", "/files/a/b/c.txt") {
            RouteMatch::Matched { params, .. } => {
                assert_eq!(params[0].name, "wildcard");
                assert_eq!(params[0].value, "a/b/c.txt");
            }
            _ => panic!("expected match"),
        }
    }

    #[test]
    fn invalid_pattern_is_skipped_without_breaking_others() {
        // matchit rejects a wildcard that is not the final segment; the other
        // route must still resolve.
        let router = DynamicRouter::build(vec![
            route("GET", "/bad/{*mid}/tail"),
            route("GET", "/good/:id"),
        ]);
        assert!(matches!(
            router.resolve("GET", "/good/7"),
            RouteMatch::Matched { .. }
        ));
    }

    #[test]
    fn empty_query_yields_no_pairs() {
        assert!(parse_query("").is_empty());
    }

    #[test]
    fn query_pairs_decoded_with_plus_as_space() {
        let pairs = parse_query("a=1&b=hello+world&c");
        assert_eq!(pairs.len(), 3);
        assert_eq!(
            (pairs[0].name.as_str(), pairs[0].value.as_str()),
            ("a", "1")
        );
        assert_eq!(pairs[1].value, "hello world");
        assert_eq!((pairs[2].name.as_str(), pairs[2].value.as_str()), ("c", ""));
    }

    #[test]
    fn query_decodes_percent_escapes() {
        let pairs = parse_query("path=%2Fhome%2Fuser");
        assert_eq!(pairs[0].value, "/home/user");
    }

    #[test]
    fn query_preserves_repeated_keys_in_order() {
        let pairs = parse_query("k=1&k=2&k=3");
        assert_eq!(pairs.len(), 3);
        assert_eq!(
            pairs.iter().map(|p| p.value.as_str()).collect::<Vec<_>>(),
            ["1", "2", "3"]
        );
    }

    #[test]
    fn cookies_parsed_trimmed_and_decoded() {
        let cookies = parse_cookies("a=1; b=%20x; c=\"quoted\"; ; d");
        assert_eq!(cookies.len(), 4);
        assert_eq!(
            (cookies[0].name.as_str(), cookies[0].value.as_str()),
            ("a", "1")
        );
        assert_eq!(cookies[1].value, " x");
        assert_eq!(cookies[2].value, "quoted");
        assert_eq!(
            (cookies[3].name.as_str(), cookies[3].value.as_str()),
            ("d", "")
        );
    }

    #[test]
    fn cookie_plus_is_not_space() {
        let cookies = parse_cookies("token=a+b");
        assert_eq!(cookies[0].value, "a+b");
    }

    #[test]
    fn cookie_with_empty_name_is_skipped() {
        let cookies = parse_cookies("=orphan; real=1");
        assert_eq!(cookies.len(), 1);
        assert_eq!(cookies[0].name, "real");
    }

    #[test]
    fn cookie_only_strips_one_quote_layer() {
        let cookies = parse_cookies("a=\"\"inner\"\"");
        assert_eq!(cookies[0].value, "\"inner\"");
    }

    #[test]
    fn empty_cookie_header_yields_nothing() {
        assert!(parse_cookies("").is_empty());
        assert!(parse_cookies("   ;  ; ").is_empty());
    }

    #[test]
    fn request_id_is_32_lowercase_hex_chars() {
        let id = generate_request_id();
        assert_eq!(id.len(), 32);
        assert!(id.bytes().all(|b| b.is_ascii_hexdigit()));
        assert!(!id.bytes().any(|b| b.is_ascii_uppercase()));
    }

    #[test]
    fn request_ids_are_distinct() {
        assert_ne!(generate_request_id(), generate_request_id());
    }
}
