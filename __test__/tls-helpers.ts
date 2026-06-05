import { readFileSync } from "node:fs";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { dirname, join } from "node:path";
import type { TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const certFixture = (name: string): Buffer => readFileSync(join(here, "fixtures", name));

export interface Res {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  body: string;
  alpn: string | false;
  tlsVersion: string | null;
}

export interface HttpsOpts {
  method?: string;
  path: string;
  body?: string;
  headers?: Record<string, string>;
}

/** A small HTTPS client bound to one port, trusting the self-signed test cert. */
export function makeHttps(port: number): (opts: HttpsOpts) => Promise<Res> {
  return (opts) =>
    new Promise<Res>((resolve, reject) => {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      if (opts.body !== undefined && headers["content-length"] === undefined) {
        headers["content-length"] = String(Buffer.byteLength(opts.body));
      }
      const requestOptions = {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path,
        rejectUnauthorized: false, // self-signed test cert on loopback
        ALPNProtocols: ["http/1.1"],
        headers,
      } as RequestOptions & { ALPNProtocols: string[] };
      const req = httpsRequest(requestOptions, (res) => {
        const socket = res.socket as TLSSocket;
        const alpn = socket.alpnProtocol ?? false;
        const tlsVersion = socket.getProtocol?.() ?? null;
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: data,
            alpn,
            tlsVersion,
          }),
        );
      });
      req.on("error", reject);
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    });
}
