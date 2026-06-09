import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

// Authenticated encryption for connectionless UDP. Each datagram is sealed on its own.
// No handshake and no session (that's DTLS, which the bundled TLS stack doesn't implement).
// You get confidentiality + integrity per datagram under a pre-shared 32-byte key:
// AES-256-GCM with a fresh random nonce, plus an optional anti-replay window. Both ends
// must share the key.
//
// Wire format:  [12-byte nonce][ciphertext][16-byte GCM tag]

const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const OVERHEAD = NONCE_LEN + TAG_LEN;

function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_LEN) {
    throw new RangeError(
      `secure datagram: key must be ${KEY_LEN} bytes (AES-256), got ${key.length}`,
    );
  }
}

/** Seal a plaintext datagram. Safe to call once per send; the nonce is fresh each time. */
export function sealDatagram(key: Uint8Array, plaintext: Uint8Array): Buffer {
  assertKey(key);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

/** Open a sealed datagram. Returns the plaintext, or `null` if it's malformed, was
 *  tampered with, or fails authentication. A bad datagram is dropped, never delivered. */
export function openDatagram(key: Uint8Array, sealed: Uint8Array): Buffer | null {
  assertKey(key);
  if (sealed.length < OVERHEAD) return null;
  const nonce = sealed.subarray(0, NONCE_LEN);
  const tag = sealed.subarray(sealed.length - TAG_LEN);
  const body = sealed.subarray(NONCE_LEN, sealed.length - TAG_LEN);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return null; // auth failure / corrupt — drop it
  }
}

/** A bounded set of recently-seen nonces, so a replayed datagram is rejected once. Best
 *  effort for a connectionless protocol: it bounds memory, so an attacker can eventually
 *  age a captured datagram out and replay it. Size the window to your threat model. */
export class ReplayWindow {
  readonly #seen = new Set<string>();
  // a fixed ring of the last #max nonces; evicting the oldest is O(1) (no Array.shift,
  // which is O(n) and would be a CPU-DoS at high packet rates).
  readonly #ring: Array<string | undefined>;
  #head = 0;
  readonly #max: number;

  constructor(max = 100_000) {
    this.#max = Math.max(1, max);
    this.#ring = new Array<string | undefined>(this.#max).fill(undefined);
  }

  /** Record a nonce; returns `false` if it was already seen (a replay). */
  accept(sealed: Uint8Array): boolean {
    const nonce = Buffer.from(sealed.subarray(0, NONCE_LEN)).toString("latin1");
    if (this.#seen.has(nonce)) return false;
    const evicted = this.#ring[this.#head];
    if (evicted !== undefined) this.#seen.delete(evicted);
    this.#ring[this.#head] = nonce;
    this.#head = (this.#head + 1) % this.#max;
    this.#seen.add(nonce);
    return true;
  }
}

/** constant-time key comparison, for callers that rotate or compare keys themselves */
export function keysEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
