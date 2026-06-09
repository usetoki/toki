import dgram from "node:dgram";
import { createUdpServer, type RemoteInfo } from "./udp.js";
import { HandshakeState } from "./noise/handshake-state.js";
import type { KeyPair } from "./noise/dh.js";
import { NoiseSession } from "./noise-session.js";

export { generateKeyPair, keyPairFromPrivateRaw, type KeyPair } from "./noise/dh.js";
export { NoiseSession } from "./noise-session.js";

// Encrypted, authenticated UDP sessions built on the Noise XX handshake (X25519 + AES-256-GCM
// + SHA-256). The WireGuard-style way to secure connectionless traffic when DTLS isn't
// available. Each peer runs a mutual-auth handshake (forward secrecy via ephemeral DH), then
// exchanges replay-protected transport datagrams. This is NOT DTLS (no wire interop) and not
// a stream; it's a per-peer secure datagram session.

const HANDSHAKE = 1;
const TRANSPORT = 2;

/** A server-side view of one authenticated peer. */
export interface SecureSession {
  /** the peer's authenticated static public key (32 bytes) */
  readonly remoteStatic: Buffer;
  readonly address: string;
  readonly port: number;
  /** Send an encrypted datagram to this peer. */
  send(data: Uint8Array | string): void;
  /** Forget this peer; further datagrams from it must re-handshake. */
  close(): void;
}

export interface SecureUdpServer {
  bind(port: number, host?: string): { port: number };
  close(): void;
}

export interface SecureUdpServerOptions {
  /** the server's long-term X25519 identity (clients authenticate this key) */
  staticKey: KeyPair;
  /** new authenticated peer */
  onSession?: (session: SecureSession) => void;
  /** decrypted message from a peer */
  onMessage: (msg: Buffer, session: SecureSession) => void;
  /** max half-finished handshakes held at once (bounds half-open DoS). Default 1024. */
  maxPending?: number;
  /** drop a peer after this many ms of inactivity. Default 120000. */
  sessionTtlMs?: number;
}

interface Peer {
  hs: HandshakeState | null;
  session: NoiseSession | null;
  lastSeen: number;
}

/** Bind an encrypted-UDP server. Peers handshake (Noise XX), then exchange encrypted,
 *  replay-protected datagrams. One UDP socket per process (native singleton). */
export function createSecureUdpServer(options: SecureUdpServerOptions): SecureUdpServer {
  const maxPending = options.maxPending ?? 1024;
  const ttl = options.sessionTtlMs ?? 120_000;
  const peers = new Map<string, Peer>();
  let pending = 0;
  let sweep: ReturnType<typeof setInterval> | undefined;

  const keyOf = (r: RemoteInfo): string => `${r.address}:${r.port}`;

  // built once bind() has the socket, so a session can send back through it
  let sendRaw: (data: Uint8Array, port: number, address: string) => void = () => {};

  const wrap = (key: string, peer: Peer, r: RemoteInfo): SecureSession => ({
    remoteStatic: peer.session!.remoteStatic,
    address: r.address,
    port: r.port,
    send(data: Uint8Array | string): void {
      if (peer.session === null) return;
      const pt = typeof data === "string" ? Buffer.from(data) : data;
      sendRaw(Buffer.concat([Buffer.from([TRANSPORT]), peer.session.seal(pt)]), r.port, r.address);
    },
    close(): void {
      peers.delete(key);
    },
  });

  // Drop the oldest still-handshaking peer (Map keeps insertion order, so the first half-open
  // entry is the oldest admitted). Frees one pending slot so a new handshake can start.
  const evictOldestPending = (): void => {
    for (const [k, p] of peers) {
      if (p.hs !== null && p.session === null) {
        peers.delete(k);
        pending -= 1;
        return;
      }
    }
  };

  const onDatagram = (data: Buffer, r: RemoteInfo): void => {
    if (data.length < 1) return;
    const type = data[0];
    const body = data.subarray(1);
    const key = keyOf(r);

    if (type === HANDSHAKE) {
      let peer = peers.get(key);
      if (peer === undefined) {
        // At the half-open cap, evict the OLDEST pending handshake to make room. Just dropping
        // the newcomer would let an attacker pin `pending` at the cap with spoofed msg1s and
        // lock out every new legitimate peer. Evicting keeps the table bounded AND live.
        if (pending >= maxPending) evictOldestPending();
        peer = { hs: new HandshakeState(false, options.staticKey), session: null, lastSeen: now() };
        peers.set(key, peer);
        pending += 1;
      } else if (peer.hs === null) {
        // The peer may already hold a live session. Start a (re)handshake WITHOUT touching it:
        // an off-path attacker who spoofs this address:port could otherwise send one unauthenticated
        // msg1 and tear the session down. The session is replaced only when a NEW handshake
        // COMPLETES — which the spoofer can't do, since msg2 goes to the real peer, not them.
        if (pending >= maxPending) evictOldestPending();
        peer.hs = new HandshakeState(false, options.staticKey);
        pending += 1;
      }
      try {
        const read = peer.hs!.readMessage(body);
        peer.lastSeen = now();
        if (read.transport !== undefined) {
          peer.session = new NoiseSession(read.transport);
          peer.hs = null;
          pending -= 1;
          options.onSession?.(wrap(key, peer, r));
          return;
        }
        const written = peer.hs!.writeMessage();
        sendRaw(Buffer.concat([Buffer.from([HANDSHAKE]), written.message]), r.port, r.address);
      } catch {
        // malformed/forged/duplicate handshake datagram: abandon the in-progress handshake
        // but keep any established session intact (never tear it down on unauthenticated input).
        peer.hs = null;
        pending -= 1;
        if (peer.session === null) peers.delete(key);
      }
      return;
    }

    if (type === TRANSPORT) {
      const peer = peers.get(key);
      if (peer?.session == null) return;
      const pt = peer.session.open(body);
      if (pt === null) return; // forged / replayed / too old
      peer.lastSeen = now();
      options.onMessage(pt, wrap(key, peer, r));
    }
  };

  const socket = createUdpServer(onDatagram, {});

  return {
    bind(port: number, host = "0.0.0.0"): { port: number } {
      const bound = socket.bind(port, host);
      sendRaw = (d, p, a) => socket.send(d, p, a);
      sweep = setInterval(
        () => {
          const cutoff = now() - ttl;
          for (const [k, p] of peers) {
            if (p.lastSeen < cutoff) {
              if (peers.delete(k) && p.hs !== null) pending -= 1;
            }
          }
        },
        Math.min(ttl, 30_000),
      );
      sweep.unref?.();
      return bound;
    },
    close(): void {
      if (sweep !== undefined) clearInterval(sweep);
      peers.clear();
      pending = 0;
      socket.close();
    },
  };
}

/** A client's live session with a secure-UDP server. */
export interface SecureClientSession {
  readonly remoteStatic: Buffer;
  send(data: Uint8Array | string): void;
  on(event: "message", listener: (msg: Buffer) => void): this;
  close(): void;
}

export interface SecureUdpClientOptions {
  /** the client's X25519 identity (the server authenticates it) */
  staticKey: KeyPair;
  /** handshake retransmit interval, ms. Default 250. */
  retransmitMs?: number;
  /** give up after this long. Default 5000. */
  timeoutMs?: number;
}

/** Connect to a secure-UDP server and run the Noise XX handshake, resolving a session.
 *  Uses node:dgram, so it coexists with anything (no native-singleton conflict). */
export function connectSecureUdp(
  options: SecureUdpClientOptions,
  port: number,
  host = "127.0.0.1",
): Promise<SecureClientSession> {
  const retransmitMs = options.retransmitMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 5000;
  const sock = dgram.createSocket("udp4");
  const hs = new HandshakeState(true, options.staticKey);

  return new Promise<SecureClientSession>((resolve, reject) => {
    const msg1 = hs.writeMessage();
    let session: NoiseSession | null = null;
    const listeners: Array<(msg: Buffer) => void> = [];

    const send = (type: number, body: Uint8Array): void => {
      sock.send(Buffer.concat([Buffer.from([type]), body]), port, host);
    };

    const retransmit = setInterval(() => {
      if (session === null) send(HANDSHAKE, msg1.message); // msg1 may have been lost
    }, retransmitMs);
    const timer = setTimeout(() => {
      clearInterval(retransmit);
      sock.close();
      reject(new Error("secure-udp: handshake timed out"));
    }, timeoutMs);

    sock.on("message", (data) => {
      if (data.length < 1) return;
      const type = data[0];
      const body = data.subarray(1);
      if (session === null && type === HANDSHAKE) {
        try {
          hs.readMessage(body); // msg2
          const msg3 = hs.writeMessage();
          send(HANDSHAKE, msg3.message);
          if (msg3.transport === undefined) return;
          session = new NoiseSession(msg3.transport);
        } catch {
          return; // ignore a bad/duplicate handshake datagram, keep retransmitting
        }
        clearInterval(retransmit);
        clearTimeout(timer);
        const live = session;
        const clientSession: SecureClientSession = {
          remoteStatic: live.remoteStatic,
          send(d: Uint8Array | string): void {
            const pt = typeof d === "string" ? Buffer.from(d) : d;
            send(TRANSPORT, live.seal(pt));
          },
          on(event: "message", listener: (msg: Buffer) => void): SecureClientSession {
            if (event === "message") listeners.push(listener);
            return clientSession;
          },
          close(): void {
            sock.close();
          },
        };
        resolve(clientSession);
        return;
      }
      if (session !== null && type === TRANSPORT) {
        const pt = session.open(body);
        if (pt !== null) for (const fn of listeners) fn(pt);
      }
    });
    sock.on("error", (e) => {
      clearInterval(retransmit);
      clearTimeout(timer);
      reject(e);
    });

    send(HANDSHAKE, msg1.message);
  });
}

function now(): number {
  return Date.now();
}
