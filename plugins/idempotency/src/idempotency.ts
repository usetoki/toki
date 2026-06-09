import { reply } from "@usetoki/toki";
import type { TokiInstance, TokiRequest } from "@usetoki/toki";
import { fingerprint } from "./fingerprint.ts";
import { type IdempotencyStore, MemoryStore } from "./store.ts";

const encoder = new TextEncoder();
const SKIP_HEADERS = new Set(["set-cookie"]);

// a reservation this request owns and must finalize when its response is sent
const reserved = new WeakMap<TokiRequest, { key: string; fingerprint: string }>();

export interface IdempotencyOptions {
  store?: IdempotencyStore;
  /** Header carrying the key. Default `"idempotency-key"`. */
  header?: string;
  /** Methods that participate. Default `["POST", "PATCH", "PUT", "DELETE"]`. */
  methods?: string[];
  /** Reject those methods with `400` when the header is absent. Default `false`. */
  required?: boolean;
  /** How long a completed response stays replayable, seconds. Default `86400` (24h). */
  ttl?: number;
  /** How long one in-flight request holds the key, seconds. Default `60`. */
  lockTtl?: number;
}

/**
 * Stripe-style idempotency. A mutating request that carries an `Idempotency-Key` runs at
 * most once: the first execution's response is stored and every later retry with the same
 * key replays it (`Idempotent-Replayed: true`) instead of running the handler again. A
 * retry still in flight gets `409`; the same key reused with different parameters gets
 * `422`. Server errors aren't stored — they're left retryable.
 */
export function idempotency(instance: TokiInstance, options: IdempotencyOptions = {}): void {
  const store = options.store ?? new MemoryStore();
  const header = (options.header ?? "idempotency-key").toLowerCase();
  const methods = new Set(
    (options.methods ?? ["POST", "PATCH", "PUT", "DELETE"]).map((m) => m.toUpperCase()),
  );
  const required = options.required === true;
  const recordTtlMs = (options.ttl ?? 86_400) * 1000;
  const lockTtlMs = (options.lockTtl ?? 60) * 1000;

  instance.addHook("preHandler", async (req) => {
    if (!methods.has(req.method)) return undefined;

    const key = req.headers.get(header);
    if (key === null || key === "") {
      return required ? reply.text(`${header} header is required`, 400) : undefined;
    }

    const fp = fingerprint(req.method, req.path, req.query.toString(), req.body);
    const result = await store.begin(key, fp, lockTtlMs);
    switch (result.state) {
      case "new":
        reserved.set(req, { key, fingerprint: fp });
        return undefined;
      case "replay": {
        req.setResponseHeader("Idempotent-Replayed", "true");
        if (result.record.headers) {
          for (const [name, value] of result.record.headers) req.setResponseHeader(name, value);
        }
        return reply.bytes(result.record.body, result.record.contentType, result.record.status);
      }
      case "in-flight":
        return reply.text("A request with this Idempotency-Key is already in progress", 409);
      case "mismatch":
        return reply.text("This Idempotency-Key was already used with different parameters", 422);
    }
  });

  instance.addHook("onSend", async (req, res) => {
    const held = reserved.get(req);
    if (held === undefined) return undefined;
    reserved.delete(req);

    // leave server errors retryable; the short lock TTL frees the key either way
    if (res.status >= 500) {
      await Promise.resolve(store.release(held.key)).catch(() => {});
      return undefined;
    }

    // include handler-staged headers (req.setResponseHeader) so a retry replays them too
    const headers = [...req.stagedResponseHeaders, ...res.headers].filter(
      ([name]) => !SKIP_HEADERS.has(name.toLowerCase()),
    );
    try {
      await store.complete(
        held.key,
        {
          fingerprint: held.fingerprint,
          status: res.status,
          contentType: res.contentType,
          body: typeof res.body === "string" ? encoder.encode(res.body) : res.body,
          ...(headers.length > 0 ? { headers } : {}),
        },
        recordTtlMs,
      );
    } catch (error) {
      // don't abort a good response if the store write fails; the lock TTL frees the key
      req.log.error("idempotency store failed", { error: String(error) });
      await Promise.resolve(store.release(held.key)).catch(() => {});
    }
    return undefined;
  });
}
