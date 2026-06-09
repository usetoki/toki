import { native, type RemoteInfo, type UdpOptions } from "../native/native.ts";
import { openDatagram, ReplayWindow, sealDatagram } from "./secure-datagram.ts";

export type { RemoteInfo, UdpOptions } from "../native/native.ts";
export { sealDatagram, openDatagram, ReplayWindow, keysEqual } from "./secure-datagram.ts";

/** Pre-shared-key authenticated encryption for every datagram (AES-256-GCM). Not DTLS —
 *  no handshake, no session — just per-datagram confidentiality + integrity. Both ends
 *  must share `key` (32 bytes). */
export interface SecureUdpOptions {
  /** 32-byte AES-256 key, shared with the peers. */
  key: Uint8Array;
  /** Drop replayed datagrams, remembering this many recent nonces. Default off. */
  antiReplay?: number;
}

/** Options for {@link createUdpServer}. */
export interface UdpServerOptions extends UdpOptions {
  secure?: SecureUdpOptions;
  /**
   * Native per-source datagram limit. An over-limit packet is dropped in the engine —
   * no decryption, no Buffer copy, no dispatch into JS — and nothing is sent back
   * (answering an over-limit datagram would be an amplification vector). The packet has
   * still crossed the kernel, so this is abuse control, not a line-rate DDoS shield.
   */
  rateLimit?: { max: number; windowMs: number };
}

/** A bound UDP socket. UDP is connectionless — there are no connections to track, just
 *  datagrams in and out. */
export interface UdpSocket {
  /** Bind and start receiving. `0` picks a free port; the chosen port is returned. */
  bind(port: number, host?: string): { port: number };
  /** Send one datagram. A string is encoded as UTF-8. There is no delivery guarantee. */
  send(data: Uint8Array | string, port: number, address: string): void;
  /** Stop receiving and close the socket. */
  close(): void;
}

// One UDP socket per process — the native engine is a singleton.
let active = false;

/** Bind a UDP server. `onMessage` runs for every datagram with the sender's address.
 *  With `options.secure`, datagrams are sealed/opened with AES-256-GCM and a forged or
 *  tampered datagram is dropped before it ever reaches `onMessage`. */
export function createUdpServer(
  onMessage: (msg: Buffer, rinfo: RemoteInfo, socket: UdpSocket) => void,
  options: UdpServerOptions = {},
): UdpSocket {
  const secure = options.secure;
  const replay = secure?.antiReplay ? new ReplayWindow(secure.antiReplay) : undefined;

  // flatten the rateLimit option into the fields native reads (mirrors createTcpServer)
  let nativeOptions: UdpServerOptions = options;
  if (options.rateLimit) {
    nativeOptions = {
      ...options,
      rateLimitMax: options.rateLimit.max,
      rateLimitWindowMs: options.rateLimit.windowMs,
    };
  }

  const socket: UdpSocket = {
    bind(port: number, host = "0.0.0.0"): { port: number } {
      if (active) throw new Error("toki: a UDP server is already bound in this process");
      const dispatch = (data: Uint8Array, rinfo: RemoteInfo): void => {
        if (secure === undefined) {
          // native hands us a private, V8-owned copy of the datagram; safe to retain
          onMessage(data as Buffer, rinfo, socket);
          return;
        }
        // authenticate FIRST, then replay-check — only a genuine datagram may record its
        // nonce, else a forged packet could pre-poison a legitimate nonce out of the window.
        const plain = openDatagram(secure.key, data);
        if (plain === null) return; // forged / tampered / malformed — drop
        if (replay !== undefined && !replay.accept(data)) return; // replayed — drop
        onMessage(plain, rinfo, socket);
      };
      const bound = native.udpBind(port, host, nativeOptions, dispatch);
      active = true;
      return { port: bound };
    },
    send(data: Uint8Array | string, port: number, address: string): void {
      const bytes = typeof data === "string" ? Buffer.from(data) : data;
      native.udpSend(secure === undefined ? bytes : sealDatagram(secure.key, bytes), port, address);
    },
    close(): void {
      if (!active) return;
      native.udpClose();
      active = false;
    },
  };
  return socket;
}
