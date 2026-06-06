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
): Headers {
  const headers = new Headers();
  const stripSet = new Set((strip ?? []).map((h) => h.toLowerCase()));
  for (const [name, value] of req.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || stripSet.has(lower)) continue;
    headers.set(name, value);
  }

  const forwardedFor = req.headers.get("x-forwarded-for");
  headers.set("x-forwarded-for", forwardedFor ? `${forwardedFor}, ${req.ip}` : req.ip);
  headers.set("x-forwarded-host", req.headers.get("host") ?? "");
  headers.set("x-forwarded-proto", req.protocol);

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
