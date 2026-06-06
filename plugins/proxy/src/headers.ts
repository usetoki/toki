import type { TokiRequest } from "@usetoki/toki";

// Hop-by-hop headers (RFC 7230 §6.1) plus the framing ones the upstream client manages
// itself — never forwarded on either leg.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/** Headers to forward to the upstream, with the X-Forwarded-* chain extended. */
export function requestHeaders(
  req: TokiRequest,
  add: Record<string, string> | undefined,
  strip: string[] | undefined,
  trustProxy: boolean,
): Headers {
  const headers = new Headers();
  const stripSet = new Set((strip ?? []).map((h) => h.toLowerCase()));
  // RFC 7230 §6.1: any header named in Connection is itself hop-by-hop — drop it too
  for (const token of (req.headers.get("connection") ?? "").split(",")) {
    const name = token.trim().toLowerCase();
    if (name) stripSet.add(name);
  }
  for (const [name, value] of req.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || stripSet.has(lower)) continue;
    headers.set(name, value);
  }

  // When this gateway is the edge, a client-supplied X-Forwarded-For is spoofed input —
  // overwrite it with the real peer. Only extend the chain when sitting behind a proxy we trust.
  const forwardedFor = req.headers.get("x-forwarded-for");
  headers.set(
    "x-forwarded-for",
    trustProxy && forwardedFor ? `${forwardedFor}, ${req.ip}` : req.ip,
  );
  headers.set("x-forwarded-host", req.headers.get("host") ?? "");
  // req.protocol trusts an inbound X-Forwarded-Proto; at the edge that's spoofable, so
  // only honor it behind a trusted proxy, otherwise report plain http
  headers.set("x-forwarded-proto", trustProxy ? req.protocol : "http");

  if (add) for (const [name, value] of Object.entries(add)) headers.set(name, value);
  return headers;
}

// Content-Type is carried separately on the response; framing headers are re-derived.
const SKIP_RESPONSE = new Set([
  "content-type",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

/** The upstream response headers to replay downstream, Set-Cookie preserved per-value. */
export function responseHeaders(headers: Headers): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const cookie of headers.getSetCookie?.() ?? []) out.push(["set-cookie", cookie]);
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (lower === "set-cookie" || SKIP_RESPONSE.has(lower)) continue;
    out.push([name, value]);
  }
  return out;
}
