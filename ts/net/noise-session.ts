import type { CipherState } from "./noise/cipher-state.ts";
import type { TransportPair } from "./noise/handshake-state.ts";

// A live, authenticated Noise session over a datagram transport. Each datagram carries an
// explicit 8-byte counter (UDP reorders and drops, so the AEAD nonce can't be implicit).
// The receiver rejects replays and far-future/duplicate counters with a sliding window,
// the same anti-replay scheme DTLS and IPsec/ESP use.

const COUNTER_BYTES = 8;
const WINDOW = 1024; // accept reordering up to this many datagrams behind the high-water mark

// 64-bit sliding-window replay filter over the peer's monotonic counters.
class ReplayFilter {
  #high = -1n; // highest counter accepted so far (-1 = none yet)
  #bits = new Set<bigint>(); // counters within [#high-WINDOW, #high] already seen

  /** Returns true if `n` is fresh (and records it); false for a replay or too-old counter. */
  check(n: bigint): boolean {
    if (n > this.#high) {
      // advance the window; drop anything now older than the window
      const lowOld = this.#high - BigInt(WINDOW);
      for (const seen of this.#bits) if (seen <= lowOld) this.#bits.delete(seen);
      this.#high = n;
      this.#bits.add(n);
      return true;
    }
    if (n <= this.#high - BigInt(WINDOW)) return false; // too old, outside the window
    if (this.#bits.has(n)) return false; // already seen
    this.#bits.add(n);
    return true;
  }
}

export class NoiseSession {
  readonly #send: CipherState;
  readonly #recv: CipherState;
  readonly #replay = new ReplayFilter();
  #counter = 0n;
  /** the peer's authenticated static public key (32 bytes) */
  readonly remoteStatic: Buffer;
  /** unique channel binding for this session */
  readonly handshakeHash: Buffer;

  constructor(transport: TransportPair) {
    this.#send = transport.send;
    this.#recv = transport.recv;
    this.remoteStatic = transport.remoteStatic;
    this.handshakeHash = transport.handshakeHash;
  }

  /** Seal a plaintext into a transport datagram: `[8-byte counter][ciphertext+tag]`. */
  seal(plaintext: Uint8Array): Buffer {
    const n = this.#counter;
    // the Noise spec reserves 2^64-1; never reuse a (key, counter) pair. Rekeying isn't
    // implemented, so refuse to send past the limit rather than wrap the counter.
    if (n >= (1n << 64n) - 1n)
      throw new Error("secure-udp: send counter exhausted — open a new session");
    this.#counter += 1n;
    const header = Buffer.alloc(COUNTER_BYTES);
    header.writeBigUInt64BE(n);
    const ct = this.#send.encryptAt(n, header, plaintext); // bind the counter as AAD
    return Buffer.concat([header, ct]);
  }

  /** Open a transport datagram. Returns the plaintext, or `null` if it's forged, replayed,
   *  too old, or malformed. A bad datagram is dropped, never delivered. */
  open(wire: Uint8Array): Buffer | null {
    if (wire.length < COUNTER_BYTES) return null;
    const header = Buffer.from(wire.subarray(0, COUNTER_BYTES));
    const n = header.readBigUInt64BE();
    let plain: Buffer;
    try {
      // authenticate FIRST — only a genuine datagram may record its counter, else a forged
      // packet could poison a legitimate counter out of the replay window.
      plain = this.#recv.decryptAt(n, header, wire.subarray(COUNTER_BYTES));
    } catch {
      return null; // failed authentication
    }
    if (!this.#replay.check(n)) return null; // replay or too old
    return plain;
  }
}
