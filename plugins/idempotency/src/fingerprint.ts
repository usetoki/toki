import { createHash } from "node:crypto";

/**
 * A digest of the request that owns an Idempotency-Key. A retry must carry the same
 * method, path, and body; a key reused with different parameters is rejected rather than
 * silently replaying the wrong response.
 */
export function fingerprint(method: string, path: string, body: Uint8Array | null): string {
  const hash = createHash("sha256");
  hash.update(method);
  hash.update("\n");
  hash.update(path);
  hash.update("\n");
  if (body) hash.update(body);
  return hash.digest("base64url");
}
