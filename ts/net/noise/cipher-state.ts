import { createCipheriv, createDecipheriv } from "node:crypto";

// CipherState (Noise spec §5.1) over AES-256-GCM. The 96-bit nonce is four zero bytes
// followed by the big-endian 64-bit message counter `n`, exactly as the spec mandates
// for the AESGCM cipher (§12.3). The 16-byte GCM tag is appended to the ciphertext.

export const KEYLEN = 32;
const TAGLEN = 16;
// 2^64 - 1 is reserved by the spec to signal "rekey required"; we refuse to reach it.
const NONCE_MAX = (1n << 64n) - 1n;

function nonceBytes(n: bigint): Buffer {
  const b = Buffer.alloc(12); // 4 zero bytes + 8-byte big-endian counter
  b.writeBigUInt64BE(n, 4);
  return b;
}

export class CipherState {
  #key: Buffer | null;
  #n = 0n;

  constructor(key?: Uint8Array) {
    this.#key = key ? Buffer.from(key) : null;
  }

  /** A keyed CipherState produces real AEAD output; an unkeyed one is a pass-through. */
  hasKey(): boolean {
    return this.#key !== null;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Buffer {
    if (this.#key === null) return Buffer.from(plaintext);
    if (this.#n >= NONCE_MAX) throw new Error("noise: nonce exhausted");
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonceBytes(this.#n));
    cipher.setAAD(ad);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    this.#n += 1n;
    return Buffer.concat([body, cipher.getAuthTag()]);
  }

  /** Decrypt or throw — a bad tag means the message is forged or out of order. */
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Buffer {
    if (this.#key === null) return Buffer.from(ciphertext);
    if (this.#n >= NONCE_MAX) throw new Error("noise: nonce exhausted");
    if (ciphertext.length < TAGLEN) throw new Error("noise: ciphertext too short");
    const split = ciphertext.length - TAGLEN;
    const decipher = createDecipheriv("aes-256-gcm", this.#key, nonceBytes(this.#n));
    decipher.setAAD(ad);
    decipher.setAuthTag(ciphertext.subarray(split));
    const out = Buffer.concat([decipher.update(ciphertext.subarray(0, split)), decipher.final()]);
    this.#n += 1n;
    return out;
  }

  /** The transport nonce counter — the receiver uses it to bound a replay window. */
  nonce(): bigint {
    return this.#n;
  }

  /** Decrypt a transport message at an explicit counter (for out-of-order datagrams),
   *  without disturbing this state's own counter. Used by the session replay layer. */
  decryptAt(n: bigint, ad: Uint8Array, ciphertext: Uint8Array): Buffer {
    if (this.#key === null) return Buffer.from(ciphertext);
    if (ciphertext.length < TAGLEN) throw new Error("noise: ciphertext too short");
    const split = ciphertext.length - TAGLEN;
    const decipher = createDecipheriv("aes-256-gcm", this.#key, nonceBytes(n));
    decipher.setAAD(ad);
    decipher.setAuthTag(ciphertext.subarray(split));
    return Buffer.concat([decipher.update(ciphertext.subarray(0, split)), decipher.final()]);
  }

  /** Encrypt a transport message at an explicit counter (the session manages counters). */
  encryptAt(n: bigint, ad: Uint8Array, plaintext: Uint8Array): Buffer {
    if (this.#key === null) return Buffer.from(plaintext);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonceBytes(n));
    cipher.setAAD(ad);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([body, cipher.getAuthTag()]);
  }
}
