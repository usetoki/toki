import { reply } from "@usetoki/toki";
import type { Handler, HandlerResult, TokiRequest } from "@usetoki/toki";
import { Breaker } from "./breaker.js";

export interface CircuitBreakerOptions {
  /** Failure fraction (0–1) over the window that trips the breaker. Default `0.5`. */
  failureThreshold?: number;
  /** Minimum calls in the window before it can trip. Default `10`. */
  minimumRequests?: number;
  /** Rolling window for the failure rate, ms. Default `10000`. */
  windowMs?: number;
  /** Time to stay open before a probe, ms. Default `30000`. */
  resetTimeoutMs?: number;
  /** Treat a handler slower than this as a failure, ms. `0` disables. Default `0`. */
  timeoutMs?: number;
  /** Status for a fast-failed request. Default `503`. */
  statusCode?: number;
  /** Response to serve when the breaker is open or the call fails, instead of erroring. */
  fallback?: (req: TokiRequest) => HandlerResult | Promise<HandlerResult>;
  onOpen?: () => void;
  onClose?: () => void;
  onHalfOpen?: () => void;
}

class TimeoutError extends Error {}

/**
 * Wrap a handler in a per-route circuit breaker. While the downstream is healthy the
 * handler runs normally; once its failure rate trips the breaker, calls fast-fail with
 * `503` (and `Retry-After`) until a probe finds it recovered. A thrown error — or a
 * handler that overruns `timeoutMs` — counts as a failure; a `fallback` lets you serve a
 * degraded response instead of an error.
 *
 * ```ts
 * app.get("/quote", circuitBreaker((req) => upstream.quote(req.query.get("sym")), {
 *   timeoutMs: 2000,
 *   fallback: () => reply.json({ cached: true }),
 * }));
 * ```
 */
export function circuitBreaker(handler: Handler, options: CircuitBreakerOptions = {}): Handler {
  const breaker = new Breaker({
    failureThreshold: options.failureThreshold ?? 0.5,
    minimumRequests: options.minimumRequests ?? 10,
    windowMs: options.windowMs ?? 10_000,
    resetTimeoutMs: options.resetTimeoutMs ?? 30_000,
    now: Date.now,
    onOpen: options.onOpen,
    onClose: options.onClose,
    onHalfOpen: options.onHalfOpen,
  });
  const timeoutMs = options.timeoutMs ?? 0;
  const status = options.statusCode ?? 503;
  const fallback = options.fallback;

  return async (req) => {
    if (!breaker.allow()) {
      if (fallback) return fallback(req);
      req.setResponseHeader("Retry-After", String(breaker.cooldownSeconds()));
      return reply.text("Service Unavailable", status);
    }
    try {
      const result =
        timeoutMs > 0 ? await raceTimeout(handler(req), timeoutMs) : await handler(req);
      breaker.success();
      return result;
    } catch (error) {
      breaker.failure();
      if (fallback) return fallback(req);
      throw error;
    }
  };
}

// the handler keeps running after a timeout (it can't be cancelled), but the breaker has
// already moved on and counted the call as failed
function raceTimeout<T>(value: Promise<T> | T, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`handler exceeded ${ms}ms`)), ms);
    timer.unref?.();
    Promise.resolve(value).then(
      (resolved) => {
        clearTimeout(timer);
        resolve(resolved);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
