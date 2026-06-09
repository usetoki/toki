import { reply } from "@usetoki/toki";
import type { TokiInstance, TokiRequest, TokiResponse } from "@usetoki/toki";
import { defaultKey } from "./key.js";
import { type CacheStore, MemoryStore } from "./store.js";

const encoder = new TextEncoder();
// marks a request whose response was served from cache, so onSend doesn't re-store it
const fromCache = new WeakSet<TokiRequest>();

export interface CacheOptions {
  /** Time to live, in seconds. */
  ttl: number;
  /** Where to keep entries. Default: a per-limiter in-process {@link MemoryStore}. */
  store?: CacheStore;
  /** Request methods worth caching. Default `["GET", "HEAD"]`. */
  methods?: string[];
  /** Response statuses worth caching. Default `[200]`. */
  statuses?: number[];
  /** Request headers that partition the cache (and are echoed as `Vary`). */
  vary?: string[];
  /** Build the cache key. Default: method + path + query (+ `vary` values). */
  key?: (req: TokiRequest) => string;
  /** Emit a `Cache-Control: public, max-age=…` header. Default `true`. */
  cacheControl?: boolean;
}

/**
 * Cache whole responses per route. On a hit the stored response is replayed from the
 * `preHandler`, skipping the handler entirely; on a miss the response is captured in
 * `onSend`. Only safe methods and `200`s are cached by default. A request asking for
 * `Cache-Control: no-cache`/`no-store` bypasses the cache both ways.
 */
export function cache(instance: TokiInstance, options: CacheOptions): void {
  const ttlMs = options.ttl * 1000;
  const store = options.store ?? new MemoryStore();
  const methods = new Set((options.methods ?? ["GET", "HEAD"]).map((m) => m.toUpperCase()));
  const statuses = new Set(options.statuses ?? [200]);
  const vary = options.vary ?? [];
  const varyHeader = vary.length > 0 ? vary.join(", ") : undefined;
  const keyOf = options.key ?? ((req) => defaultKey(req, vary));
  const cacheControl = options.cacheControl !== false;

  instance.addHook("preHandler", async (req) => {
    if (!methods.has(req.method) || bypass(req)) return undefined;

    const hit = await store.get(keyOf(req));
    if (hit === null) return undefined;

    fromCache.add(req);
    if (hit.headers) for (const [name, value] of hit.headers) req.setResponseHeader(name, value);
    req.setResponseHeader("X-Cache", "HIT");
    req.setResponseHeader(
      "Age",
      String(Math.max(0, Math.floor((Date.now() - hit.storedAt) / 1000))),
    );
    if (hit.vary !== undefined) req.setResponseHeader("Vary", hit.vary);
    if (cacheControl) {
      const remaining = Math.max(0, Math.floor((hit.expiresAt - Date.now()) / 1000));
      req.setResponseHeader("Cache-Control", `public, max-age=${remaining}`);
    }
    return reply.bytes(hit.body, hit.contentType, hit.status);
  });

  instance.addHook("onSend", async (req, res) => {
    if (fromCache.has(req)) return undefined; // already a cache hit, don't re-store
    if (!methods.has(req.method) || !statuses.has(res.status) || bypass(req)) return undefined;
    if (privateResponse(req, res)) return undefined; // the handler marked it private/uncacheable

    // include handler-staged headers (req.setResponseHeader) — the plugin's own X-Cache/Age
    // are staged only after this store call, so they aren't captured here.
    const headers = [...req.stagedResponseHeaders, ...res.headers].filter(
      ([name]) => !SKIP_ON_CACHE.has(name.toLowerCase()),
    );
    const now = Date.now();
    try {
      await store.set(
        keyOf(req),
        {
          status: res.status,
          contentType: res.contentType,
          body: typeof res.body === "string" ? encoder.encode(res.body) : res.body,
          storedAt: now,
          expiresAt: now + ttlMs,
          ...(headers.length > 0 ? { headers } : {}),
          ...(varyHeader !== undefined ? { vary: varyHeader } : {}),
        },
        ttlMs,
      );
    } catch (error) {
      // caching is best-effort. A store hiccup must not abort an otherwise-good response.
      req.log.error("cache store failed", { error: String(error) });
      return undefined;
    }

    req.setResponseHeader("X-Cache", "MISS");
    if (varyHeader !== undefined) req.setResponseHeader("Vary", varyHeader);
    if (cacheControl) req.setResponseHeader("Cache-Control", `public, max-age=${options.ttl}`);
    return undefined;
  });
}

// response headers that must never be shared from a cache
const SKIP_ON_CACHE = new Set(["set-cookie"]);

// honor a client that explicitly opts out of caching for this request
function bypass(req: TokiRequest): boolean {
  const control = req.headers.get("cache-control");
  if (control !== null && /\bno-(cache|store)\b/i.test(control)) return true;
  const pragma = req.headers.get("pragma"); // HTTP/1.0 clients
  return pragma !== null && /\bno-cache\b/i.test(pragma);
}

// a response the handler marked private/uncacheable must not enter a shared cache. The
// Cache-Control may be staged (req.setResponseHeader) or baked into the response, so check both.
function privateResponse(req: TokiRequest, res: TokiResponse): boolean {
  const isPrivate = (list: ReadonlyArray<readonly [string, string]>): boolean =>
    list.some(
      ([name, value]) =>
        name.toLowerCase() === "cache-control" && /\b(private|no-store|no-cache)\b/i.test(value),
    );
  return isPrivate(req.stagedResponseHeaders) || isPrivate(res.headers);
}
