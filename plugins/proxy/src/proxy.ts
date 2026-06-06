import { reply } from "@usetoki/toki";
import type { Handler, HandlerResult } from "@usetoki/toki";
import { requestHeaders, responseHeaders } from "./headers.js";

export interface ProxyOptions {
  /** Upstream base URL, e.g. `"http://localhost:9000"`. */
  upstream: string;
  /** Map the incoming path to the upstream path. Default: forward unchanged. */
  rewritePath?: (path: string) => string;
  /** Headers added to every forwarded request. */
  headers?: Record<string, string>;
  /** Request headers to drop before forwarding. */
  stripHeaders?: string[];
  /** Trust an inbound `X-Forwarded-For` and append to it. Off by default: the header is
   *  overwritten with the real peer, so a client can't forge the forwarded chain. */
  trustProxy?: boolean;
  /** Abort the upstream call after this many ms. */
  timeoutMs?: number;
  /** Injectable `fetch` (for a custom agent or tests). Default: global `fetch`. */
  fetch?: typeof fetch;
}

const BODYLESS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * A reverse-proxy handler. Forwards the request to `upstream` (hop-by-hop headers
 * stripped, `X-Forwarded-*` extended) and streams the response straight back, so a large
 * upstream body is never buffered in the gateway. An upstream that's unreachable or times
 * out becomes a `502`. Mount it on a route or a catch-all:
 *
 * ```ts
 * app.get("/api/*", proxy({ upstream: "http://internal:9000", rewritePath: (p) => p.slice(4) }));
 * ```
 */
export function proxy(options: ProxyOptions): Handler {
  const doFetch = options.fetch ?? fetch;
  const upstreamUrl = new URL(options.upstream);

  return async (req): Promise<HandlerResult> => {
    const path = options.rewritePath ? options.rewritePath(req.path) : req.path;
    const target = new URL(path, upstreamUrl);
    // a crafted path ("//evil.com/x", "http://evil") must not redirect the proxy off the upstream
    if (target.origin !== upstreamUrl.origin) return reply.text("Bad Gateway", 502);
    const query = req.query.toString();
    if (query) target.search = query;

    const controller = new AbortController();
    const timer = options.timeoutMs
      ? setTimeout(() => controller.abort(), options.timeoutMs)
      : undefined;
    timer?.unref?.();

    let upstream: Response;
    try {
      const init: RequestInit = {
        method: req.method,
        headers: requestHeaders(
          req,
          options.headers,
          options.stripHeaders,
          options.trustProxy === true,
        ),
        signal: controller.signal,
        redirect: "manual",
      };
      if (!BODYLESS.has(req.method) && req.body) init.body = req.body;
      upstream = await doFetch(target, init);
    } catch {
      if (timer) clearTimeout(timer);
      return reply.text("Bad Gateway", 502);
    }

    for (const [name, value] of responseHeaders(upstream.headers)) {
      req.appendResponseHeader(name, value);
    }
    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";

    if (upstream.body === null) {
      if (timer) clearTimeout(timer);
      return reply.bytes(
        new Uint8Array(await upstream.arrayBuffer()),
        contentType,
        upstream.status,
      );
    }
    return reply.stream(passThrough(upstream.body, timer), {
      status: upstream.status,
      contentType,
    });
  };
}

async function* passThrough(
  body: ReadableStream<Uint8Array>,
  timer: ReturnType<typeof setTimeout> | undefined,
): AsyncGenerator<Uint8Array> {
  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) yield chunk;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
