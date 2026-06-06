import { reply } from "@usetoki/toki";
import type { HandlerResult, Middleware, TokiRequest } from "@usetoki/toki";
import { MemoryStore, type Store, type StoreHit } from "./store.js";

/** The limit state for the current request, handed to a custom `message`. */
export interface RateLimitInfo {
  readonly limit: number;
  readonly remaining: number;
  /** Window reset, epoch ms. */
  readonly resetAt: number;
  /** Seconds until the window resets (the `Retry-After` value). */
  readonly retryAfter: number;
}

export interface RateLimitOptions {
  /** Requests allowed per window, per key. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Bucket key for a request. Default: the client IP (`req.ip`). */
  keyGenerator?: (req: TokiRequest) => string;
  /** Return `true` to skip limiting for this request. */
  skip?: (req: TokiRequest) => boolean;
  /** Status for a blocked request. Default `429`. */
  statusCode?: number;
  /** Body for a blocked request: a fixed message, or a builder from the limit info. */
  message?: string | ((req: TokiRequest, info: RateLimitInfo) => HandlerResult);
  /** Emit draft `RateLimit-*` headers. Default `true`. */
  standardHeaders?: boolean;
  /** Emit legacy `X-RateLimit-*` headers. Default `false`. */
  legacyHeaders?: boolean;
  /** Counter store. Default: a fresh in-memory fixed window for this limiter. */
  store?: Store;
  /**
   * What to do when the store throws (e.g. Redis/memcached unreachable).
   * `"open"` lets the request through (availability first, the default);
   * `"closed"` blocks it like an over-limit hit (abuse-prevention first).
   */
  onStoreError?: "open" | "closed";
}

const byIp = (req: TokiRequest): string => req.ip;

/**
 * Per-route, per-key rate limiting as a plain middleware. Mount it on a route's
 * `preHandler` to limit that route per client IP, give a `keyGenerator` to key on
 * something else (a user id, an API key, IP + path), or `app.use` it to cover a scope.
 *
 * Each call owns its own {@link MemoryStore} unless you pass `store`, so separate
 * routes keep separate budgets. Share one `store` across limiters for a global pool.
 */
export function rateLimit(options: RateLimitOptions): Middleware {
  const { max, windowMs } = options;
  const keyOf = options.keyGenerator ?? byIp;
  const skip = options.skip;
  const status = options.statusCode ?? 429;
  const standard = options.standardHeaders !== false;
  const legacy = options.legacyHeaders === true;
  const message = options.message;
  const store = options.store ?? new MemoryStore();
  const failClosed = options.onStoreError === "closed";

  // a blocked response: Retry-After + the custom builder (or default body). The builder
  // falling back to undefined would read as "pass" downstream, so guard it.
  const block = (req: TokiRequest, info: RateLimitInfo): HandlerResult => {
    req.setResponseHeader("Retry-After", String(info.retryAfter));
    if (typeof message === "function") {
      const built = message(req, info);
      if (built != null) return built;
    }
    return reply.json(
      {
        statusCode: status,
        error: "Too Many Requests",
        message: typeof message === "string" ? message : "rate limit exceeded",
      },
      status,
    );
  };

  return async (req) => {
    if (skip?.(req)) return undefined;

    let hit: StoreHit;
    try {
      hit = await store.hit(keyOf(req), windowMs);
    } catch {
      // store is down. fail open (default) or closed, per policy.
      if (!failClosed) return undefined;
      const retryAfter = Math.ceil(windowMs / 1000);
      return block(req, { limit: max, remaining: 0, resetAt: Date.now() + windowMs, retryAfter });
    }

    const remaining = Math.max(0, max - hit.count);
    const retryAfter = Math.max(0, Math.ceil((hit.resetAt - Date.now()) / 1000));

    if (standard) {
      req.setResponseHeader("RateLimit-Limit", String(max));
      req.setResponseHeader("RateLimit-Remaining", String(remaining));
      req.setResponseHeader("RateLimit-Reset", String(retryAfter));
    }
    if (legacy) {
      req.setResponseHeader("X-RateLimit-Limit", String(max));
      req.setResponseHeader("X-RateLimit-Remaining", String(remaining));
      req.setResponseHeader("X-RateLimit-Reset", String(Math.ceil(hit.resetAt / 1000)));
    }

    if (hit.count > max) {
      return block(req, { limit: max, remaining: 0, resetAt: hit.resetAt, retryAfter });
    }
    return undefined;
  };
}
