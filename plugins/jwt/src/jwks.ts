import { createPublicKey, type JsonWebKey, type KeyObject } from "node:crypto";
import { JwtError } from "./errors.js";
import type { JwtHeader, KeyResolver } from "./types.js";

export interface JwksOptions {
  /** the JWKS endpoint (e.g. https://issuer/.well-known/jwks.json) */
  uri: string;
  /** how long to trust the cached key set, ms. Default 600000 (10 min). */
  cacheMaxAge?: number;
  /** minimum gap between refetches triggered by an unknown kid, ms. Default 30000. */
  cooldown?: number;
  /** override the fetch implementation (testing). */
  fetch?: typeof fetch;
}

type Jwk = JsonWebKey & { kid?: string };

/** A key resolver that fetches a JWKS, caches the keys by `kid`, and refetches when a
 *  token presents an unknown kid (rate-limited) — so rotated keys are picked up. */
export function createJwksResolver(options: JwksOptions): KeyResolver {
  const cacheMaxAge = options.cacheMaxAge ?? 600_000;
  const cooldown = options.cooldown ?? 30_000;
  const doFetch = options.fetch ?? fetch;

  let keys = new Map<string, KeyObject>();
  let fetchedAt = 0;
  let lastMiss = 0;

  async function refresh(): Promise<void> {
    const res = await doFetch(options.uri);
    if (!res.ok) throw new JwtError(`jwks fetch failed: ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    const next = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) {
      try {
        next.set(jwk.kid ?? "", createPublicKey({ key: jwk, format: "jwk" }));
      } catch {
        // skip keys node can't import (unsupported kty, etc.)
      }
    }
    keys = next;
    fetchedAt = Date.now();
  }

  return async (header: JwtHeader): Promise<KeyObject> => {
    const kid = header.kid ?? "";
    const now = Date.now();
    if (keys.size === 0 || now - fetchedAt > cacheMaxAge) await refresh();

    let key = keys.get(kid);
    if (key === undefined && now - lastMiss > cooldown) {
      lastMiss = now;
      await refresh(); // the key may have just rotated in
      key = keys.get(kid);
    }
    if (key === undefined) throw new JwtError(`jwks: no key for kid "${kid}"`);
    return key;
  };
}
