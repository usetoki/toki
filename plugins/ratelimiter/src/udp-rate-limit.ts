import type { RemoteInfo, UdpSocket } from "@usetoki/toki";
import type { RateLimitInfo } from "./rate-limit.ts";
import { MemoryStore, type Store, type StoreHit } from "./store.ts";

type UdpHandler = (msg: Buffer, rinfo: RemoteInfo, socket: UdpSocket) => void;

export interface UdpRateLimitOptions {
  /** Datagrams allowed per window, per key. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Bucket key for a datagram. Default: the sender IP (`rinfo.address`). */
  keyGenerator?: (rinfo: RemoteInfo) => string;
  /** Return `true` to skip limiting for this datagram. */
  skip?: (msg: Buffer, rinfo: RemoteInfo) => boolean;
  /** Runs when a datagram is over the limit. Default: drop it silently — answering an
   *  over-limit datagram hands an attacker an amplifier, so only reply if you know the
   *  source address is authenticated (e.g. behind `secure`). */
  onLimit?: (msg: Buffer, rinfo: RemoteInfo, info: RateLimitInfo) => void;
  /** Counter store. Default: a fresh in-memory fixed window for this limiter. Share one
   *  store with `rateLimit`/`tcpRateLimit` for a budget that spans transports. */
  store?: Store;
  /** Store failure policy: `"open"` delivers the datagram (default), `"closed"` drops it. */
  onStoreError?: "open" | "closed";
}

/**
 * Per-key datagram limiting for `createUdpServer`, wrapping the message handler.
 * The native `rateLimit` bind option is the cheaper engine-side guard (drops before
 * the bytes ever reach JS); this one adds custom keys — an app-level sender id, a
 * token from the payload — plus shared stores and an `onLimit` hook.
 *
 * With the default in-memory store the decision is synchronous. An async store delivers
 * the datagram after the verdict resolves; UDP makes no ordering promises, so a late
 * delivery is indistinguishable from network reordering.
 */
export function udpRateLimit(options: UdpRateLimitOptions, onMessage: UdpHandler): UdpHandler {
  const { max, windowMs } = options;
  const keyOf = options.keyGenerator ?? ((rinfo: RemoteInfo) => rinfo.address);
  const skip = options.skip;
  const onLimit = options.onLimit;
  const store = options.store ?? new MemoryStore();
  const failClosed = options.onStoreError === "closed";

  const decide = (msg: Buffer, rinfo: RemoteInfo, socket: UdpSocket, hit: StoreHit): void => {
    if (hit.count <= max) {
      onMessage(msg, rinfo, socket);
      return;
    }
    if (onLimit) {
      const retryAfter = Math.max(0, Math.ceil((hit.resetAt - Date.now()) / 1000));
      onLimit(msg, rinfo, { limit: max, remaining: 0, resetAt: hit.resetAt, retryAfter });
    }
    // default: silent drop
  };

  return (msg, rinfo, socket) => {
    if (skip?.(msg, rinfo)) {
      onMessage(msg, rinfo, socket);
      return;
    }

    let hit: StoreHit | Promise<StoreHit>;
    try {
      hit = store.hit(keyOf(rinfo), windowMs);
    } catch {
      if (!failClosed) onMessage(msg, rinfo, socket);
      return;
    }

    if (typeof (hit as Promise<StoreHit>).then !== "function") {
      decide(msg, rinfo, socket, hit as StoreHit);
      return;
    }

    Promise.resolve(hit).then(
      (h) => decide(msg, rinfo, socket, h),
      () => {
        if (!failClosed) onMessage(msg, rinfo, socket);
      },
    );
  };
}
