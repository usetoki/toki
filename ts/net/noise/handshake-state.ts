import { CipherState } from "./cipher-state.ts";
import { DHLEN, dh, generateKeyPair, type KeyPair } from "./dh.ts";
import { SymmetricState } from "./symmetric-state.ts";

// HandshakeState (Noise spec §5.3) for the XX pattern over X25519 + AES-256-GCM + SHA-256:
//
//   -> e
//   <- e, ee, s, es
//   -> s, se
//
// XX gives mutual authentication with identity hiding (each static key is sent encrypted).
// The ephemeral DH (`ee`) gives forward secrecy. After the three messages both sides
// Split() into a pair of transport CipherStates.

export const PROTOCOL_NAME = "Noise_XX_25519_AESGCM_SHA256";
const TAGLEN = 16;

type Token = "e" | "s" | "ee" | "es" | "se" | "ss";
const XX: Token[][] = [["e"], ["e", "ee", "s", "es"], ["s", "se"]];

export interface TransportPair {
  /** keys this side uses to send / the peer uses to receive */
  send: CipherState;
  /** keys this side uses to receive / the peer uses to send */
  recv: CipherState;
  /** the final handshake hash — a unique channel binding for this session */
  handshakeHash: Buffer;
  /** the peer's authenticated static public key (32 bytes) */
  remoteStatic: Buffer;
}

export class HandshakeState {
  readonly #ss: SymmetricState;
  readonly #initiator: boolean;
  readonly #s: KeyPair;
  #e: KeyPair | null = null;
  #rs: Buffer | null = null;
  #re: Buffer | null = null;
  #step = 0;
  // test-only: a deterministic ephemeral, to reproduce published Noise test vectors.
  #fixedEphemeral: KeyPair | undefined;

  constructor(
    initiator: boolean,
    staticKey: KeyPair,
    prologue: Uint8Array = new Uint8Array(0),
    fixedEphemeral?: KeyPair,
  ) {
    this.#ss = new SymmetricState(PROTOCOL_NAME);
    this.#ss.mixHash(prologue);
    this.#initiator = initiator;
    this.#s = staticKey;
    this.#fixedEphemeral = fixedEphemeral;
  }

  /** Whether the handshake has produced transport keys. */
  get done(): boolean {
    return this.#step >= XX.length;
  }

  /** Write the next handshake message (with an optional payload). Returns the bytes to
   *  send, and the transport keys once the final message of the pattern is written. */
  writeMessage(payload: Uint8Array = new Uint8Array(0)): {
    message: Buffer;
    transport?: TransportPair;
  } {
    const pattern = XX[this.#step];
    if (pattern === undefined) throw new Error("noise: handshake already complete");
    const parts: Buffer[] = [];
    for (const token of pattern) {
      if (token === "e") {
        this.#e = this.#fixedEphemeral ?? generateKeyPair();
        parts.push(this.#e.publicRaw);
        this.#ss.mixHash(this.#e.publicRaw);
      } else if (token === "s") {
        parts.push(this.#ss.encryptAndHash(this.#s.publicRaw));
      } else {
        this.#mixDh(token);
      }
    }
    parts.push(this.#ss.encryptAndHash(payload));
    this.#step += 1;
    const message = Buffer.concat(parts);
    return this.done ? { message, transport: this.#finish() } : { message };
  }

  /** Read the next handshake message. Returns the decrypted payload, and the transport
   *  keys once the final message of the pattern is read. Throws on a tampered message. */
  readMessage(message: Uint8Array): { payload: Buffer; transport?: TransportPair } {
    const pattern = XX[this.#step];
    if (pattern === undefined) throw new Error("noise: handshake already complete");
    let buf = Buffer.from(message);
    for (const token of pattern) {
      if (token === "e") {
        if (buf.length < DHLEN) throw new Error("noise: short handshake message (e)");
        this.#re = buf.subarray(0, DHLEN);
        buf = buf.subarray(DHLEN);
        this.#ss.mixHash(this.#re);
      } else if (token === "s") {
        const len = this.#ss.hasKey() ? DHLEN + TAGLEN : DHLEN;
        if (buf.length < len) throw new Error("noise: short handshake message (s)");
        this.#rs = this.#ss.decryptAndHash(buf.subarray(0, len));
        buf = buf.subarray(len);
      } else {
        this.#mixDh(token);
      }
    }
    const payload = this.#ss.decryptAndHash(buf);
    this.#step += 1;
    return this.done ? { payload, transport: this.#finish() } : { payload };
  }

  #mixDh(token: Token): void {
    const initiator = this.#initiator;
    let secret: Buffer;
    switch (token) {
      case "ee":
        secret = dh(this.#e!.privateKey, this.#re!);
        break;
      case "ss":
        secret = dh(this.#s.privateKey, this.#rs!);
        break;
      case "es":
        secret = initiator ? dh(this.#e!.privateKey, this.#rs!) : dh(this.#s.privateKey, this.#re!);
        break;
      case "se":
        secret = initiator ? dh(this.#s.privateKey, this.#re!) : dh(this.#e!.privateKey, this.#rs!);
        break;
      default:
        throw new Error(`noise: unexpected token ${token}`);
    }
    this.#ss.mixKey(secret);
  }

  #finish(): TransportPair {
    const { send, recv } = this.#ss.split();
    // the responder's send/recv are swapped relative to the initiator's
    const pair = this.#initiator ? { send, recv } : { send: recv, recv: send };
    return { ...pair, handshakeHash: this.#ss.hash(), remoteStatic: Buffer.from(this.#rs!) };
  }
}
