import type { TcpSocket } from "@usetoki/toki";
import type { RateLimitInfo } from "./rate-limit.ts";
import { MemoryStore, type Store, type StoreHit } from "./store.ts";

export interface TcpRateLimitOptions {
  /** Connections allowed per window, per key. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Bucket key for a connection. Default: the peer IP (`socket.remoteAddress`). */
  keyGenerator?: (socket: TcpSocket) => string;
  /** Return `true` to skip limiting for this connection. */
  skip?: (socket: TcpSocket) => boolean;
  /** Runs instead of the default `destroy()` when a connection is over the limit —
   *  say goodbye (`socket.end("BUSY\n")`), log, or let it through by doing nothing. */
  onLimit?: (socket: TcpSocket, info: RateLimitInfo) => void;
  /** Counter store. Default: a fresh in-memory fixed window for this limiter. Share one
   *  store with `rateLimit`/`udpRateLimit` for a budget that spans transports. */
  store?: Store;
  /** Store failure policy: `"open"` admits the connection (default), `"closed"` drops it. */
  onStoreError?: "open" | "closed";
}

// queued socket activity while an async store decides; replayed in order on allow.
type Pending =
  | { ev: "data"; chunk: Buffer }
  | { ev: "drain" | "end" | "close" };

/**
 * Per-key connection limiting for `createTcpServer`, wrapping the connection handler.
 * Counts accepted connections (the native `rateLimit` listen option is the cheaper
 * accept-time guard; this one adds custom keys, shared stores, and an `onLimit` hook).
 *
 * With the default in-memory store the decision is synchronous: an allowed connection
 * reaches `handler` with the bare socket, zero added cost. An async store (Redis,
 * memcached) buffers any bytes that arrive while the verdict is in flight and replays
 * them once the connection is admitted, so nothing is lost or reordered.
 */
export function tcpRateLimit(
  options: TcpRateLimitOptions,
  handler: (socket: TcpSocket) => void,
): (socket: TcpSocket) => void {
  const { max, windowMs } = options;
  const keyOf = options.keyGenerator ?? ((socket: TcpSocket) => socket.remoteAddress);
  const skip = options.skip;
  const onLimit = options.onLimit;
  const store = options.store ?? new MemoryStore();
  const failClosed = options.onStoreError === "closed";

  const decide = (socket: TcpSocket, hit: StoreHit): boolean => {
    if (hit.count <= max) return true;
    const retryAfter = Math.max(0, Math.ceil((hit.resetAt - Date.now()) / 1000));
    if (onLimit) onLimit(socket, { limit: max, remaining: 0, resetAt: hit.resetAt, retryAfter });
    else socket.destroy();
    return false;
  };

  return (socket) => {
    if (skip?.(socket)) {
      handler(socket);
      return;
    }

    let hit: StoreHit | Promise<StoreHit>;
    try {
      hit = store.hit(keyOf(socket), windowMs);
    } catch {
      if (failClosed) socket.destroy();
      else handler(socket);
      return;
    }

    // sync store: settle now, hand over the bare socket — nothing wrapped, nothing queued
    if (typeof (hit as Promise<StoreHit>).then !== "function") {
      if (decide(socket, hit as StoreHit)) handler(socket);
      return;
    }

    // async store: buffer events until the verdict lands, then replay in arrival order
    const queue: Pending[] = [];
    let buffering = true;
    type Ev = "data" | "drain" | "end" | "close";
    type Listener = (...args: never[]) => void;
    const buckets: { [K in Ev]: Listener[] } = { data: [], drain: [], end: [], close: [] };
    const emit = (ev: Ev, chunk?: Buffer): void => {
      for (const fn of buckets[ev]) (fn as (c?: Buffer) => void)(chunk);
    };

    socket.on("data", (chunk) => {
      if (buffering) queue.push({ ev: "data", chunk });
      else emit("data", chunk);
    });
    socket.on("drain", () => {
      if (buffering) queue.push({ ev: "drain" });
      else emit("drain");
    });
    socket.on("end", () => {
      if (buffering) queue.push({ ev: "end" });
      else emit("end");
    });
    socket.on("close", () => {
      if (buffering) queue.push({ ev: "close" });
      else emit("close");
    });

    const wrapper: TcpSocket = {
      get remoteAddress() {
        return socket.remoteAddress;
      },
      get remotePort() {
        return socket.remotePort;
      },
      get authorized() {
        return socket.authorized;
      },
      write: (data) => socket.write(data),
      end: (data) => socket.end(data),
      destroy: () => socket.destroy(),
      on(ev, listener) {
        buckets[ev].push(listener as never);
        return wrapper;
      },
      off(ev, listener) {
        const bucket = buckets[ev];
        const i = bucket.indexOf(listener as never);
        if (i !== -1) bucket.splice(i, 1);
        return wrapper;
      },
    };

    // either way the verdict lands, stop buffering and replay — a denied connection's
    // onLimit may have attached listeners that still want the queued end/close.
    const settle = (allowed: boolean): void => {
      if (allowed) handler(wrapper);
      buffering = false;
      for (const item of queue) emit(item.ev, item.ev === "data" ? item.chunk : undefined);
      queue.length = 0;
    };

    Promise.resolve(hit).then(
      (h) => settle(decide(wrapper, h)),
      () => {
        if (failClosed) {
          socket.destroy();
          settle(false);
        } else settle(true);
      },
    );
  };
}
