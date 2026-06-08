import { createHash, hkdfSync } from "node:crypto";
import { CipherState } from "./cipher-state.js";

// SymmetricState (Noise spec §5.2) with SHA-256. Tracks the chaining key `ck` and the
// running transcript hash `h`, and folds DH outputs and handshake bytes into both.

const HASHLEN = 32;
const EMPTY = Buffer.alloc(0);

function sha256(...parts: Uint8Array[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

// Noise HKDF (§4.3): extract with salt=chaining_key, then expand with empty info into
// `num` 32-byte outputs — which is exactly HKDF-Expand, so node's hkdfSync gives it to us.
function hkdf(chainingKey: Uint8Array, ikm: Uint8Array, num: 2 | 3): Buffer[] {
  const out = Buffer.from(hkdfSync("sha256", ikm, chainingKey, EMPTY, num * HASHLEN));
  const parts: Buffer[] = [];
  for (let i = 0; i < num; i++) parts.push(out.subarray(i * HASHLEN, (i + 1) * HASHLEN));
  return parts;
}

export class SymmetricState {
  #ck: Buffer;
  #h: Buffer;
  #cipher = new CipherState();

  constructor(protocolName: string) {
    const name = Buffer.from(protocolName, "utf8");
    this.#h =
      name.length <= HASHLEN
        ? Buffer.concat([name, Buffer.alloc(HASHLEN - name.length)])
        : sha256(name);
    this.#ck = Buffer.from(this.#h);
  }

  mixKey(input: Uint8Array): void {
    const [ck, tempK] = hkdf(this.#ck, input, 2);
    this.#ck = ck!;
    this.#cipher = new CipherState(tempK);
  }

  mixHash(data: Uint8Array): void {
    this.#h = sha256(this.#h, data);
  }

  /** AD for handshake AEAD is the current transcript hash. */
  encryptAndHash(plaintext: Uint8Array): Buffer {
    const ct = this.#cipher.encryptWithAd(this.#h, plaintext);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext: Uint8Array): Buffer {
    const pt = this.#cipher.decryptWithAd(this.#h, ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }

  /** Derive the two transport CipherStates once the handshake completes. */
  split(): { send: CipherState; recv: CipherState } {
    const [k1, k2] = hkdf(this.#ck, EMPTY, 2);
    return { send: new CipherState(k1), recv: new CipherState(k2) };
  }

  hash(): Buffer {
    return Buffer.from(this.#h);
  }

  /** Whether the embedded CipherState is keyed yet — decides if an encrypted static in a
   *  handshake message carries a 16-byte tag. */
  hasKey(): boolean {
    return this.#cipher.hasKey();
  }
}
