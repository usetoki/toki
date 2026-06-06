import { createHash } from "node:crypto";

export type EtagAlgorithm = "fnv1a" | "sha1" | "md5" | "sha256";

// FNV-1a (32-bit, via Math.imul) prefixed with the byte length. Allocation-free and
// fast; the length prefix makes a collision between two different bodies vanishingly
// unlikely, which is all a cache validator needs. Format: "<len-hex>-<hash-hex>".
function fnv1a(data: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${data.length.toString(16)}-${(hash >>> 0).toString(16)}`;
}

/** Pick the body→digest function. `fnv1a` is the fast default; the rest use node:crypto. */
export function hasher(algorithm: EtagAlgorithm): (data: Uint8Array) => string {
  if (algorithm === "fnv1a") return fnv1a;
  return (data) => createHash(algorithm).update(data).digest("base64url");
}
