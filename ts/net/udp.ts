import { native, type RemoteInfo, type UdpOptions } from "../native/native.js";

export type { RemoteInfo, UdpOptions } from "../native/native.js";

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

/** Bind a UDP server. `onMessage` runs for every datagram with the sender's address. */
export function createUdpServer(
  onMessage: (msg: Buffer, rinfo: RemoteInfo, socket: UdpSocket) => void,
  options: UdpOptions = {},
): UdpSocket {
  const socket: UdpSocket = {
    bind(port: number, host = "0.0.0.0"): { port: number } {
      if (active) throw new Error("toki: a UDP server is already bound in this process");
      // native hands us a private, V8-owned copy of the datagram — safe to retain
      const dispatch = (data: Uint8Array, rinfo: RemoteInfo): void =>
        onMessage(data as Buffer, rinfo, socket);
      const bound = native.udpBind(port, host, options, dispatch);
      active = true;
      return { port: bound };
    },
    send(data: Uint8Array | string, port: number, address: string): void {
      const bytes = typeof data === "string" ? Buffer.from(data) : data;
      native.udpSend(bytes, port, address);
    },
    close(): void {
      if (!active) return;
      native.udpClose();
      active = false;
    },
  };
  return socket;
}
