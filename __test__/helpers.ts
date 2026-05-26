import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Toki } from "../ts";
import type { ListenHandle, ListenOptions, LoggerOption } from "../ts";

/** Everything but `port` (always forced to `0`), plus an optional constructor `logger`. */
export type WithServerOptions = Omit<ListenOptions, "port"> & {
  /** Forwarded to the {@link Toki} constructor; silent when omitted. */
  readonly logger?: LoggerOption;
};

/** A running test server: its base URL and a synchronous close. */
export interface RunningServer {
  /** `http://127.0.0.1:<port>` (or `https://...` when TLS options are passed). */
  readonly base: string;
  readonly port: number;
  readonly handle: ListenHandle;
  close(): void;
}

/**
 * Build a {@link Toki} app, listen on an OS-chosen port, and return its base URL and a close fn.
 * Always binds `port: 0` so files run in parallel without collisions.
 */
export async function withServer(
  configure: (app: Toki) => void | Promise<void>,
  options: WithServerOptions = {},
): Promise<RunningServer> {
  const { logger, ...listen } = options;
  const app = new Toki(logger !== undefined ? { logger } : {});
  await configure(app);
  const handle = await app.listen({ ...listen, port: 0 });
  const scheme = listen.tlsCert && listen.tlsKey ? "https" : "http";
  return {
    base: `${scheme}://127.0.0.1:${handle.port}`,
    port: handle.port,
    handle,
    close: () => handle.close(),
  };
}

/** A unique `.sock` path under the OS temp dir, for Unix-socket servers. */
export function uniqueSocketPath(): string {
  return join(tmpdir(), `toki-test-${process.pid}-${randomToken()}.sock`);
}

/** A fresh temp directory; remember to remove it in an `after`/`finally`. */
export function makeTempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `toki-${label}-`));
}

/** Best-effort recursive removal of a temp path. */
export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** A short random hex token for unique file/socket names. */
export function randomToken(): string {
  return Math.random().toString(16).slice(2, 10);
}

/** A throwaway self-signed cert/key pair, or `null` when `openssl` is unavailable. */
export interface SelfSignedCert {
  readonly cert: string;
  readonly key: string;
  cleanup(): void;
}

/**
 * Generate a self-signed localhost cert via `openssl` into a temp dir. Returns
 * `null` if `openssl` is missing or fails, so the caller can `skip`.
 */
export function generateSelfSignedCert(): SelfSignedCert | null {
  let dir: string;
  try {
    dir = makeTempDir("tls");
  } catch {
    return null;
  }
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
      ],
      { stdio: "ignore" },
    );
  } catch {
    removeTempDir(dir);
    return null;
  }
  const fs = require("node:fs") as typeof import("node:fs");
  const cert = fs.readFileSync(certPath, "utf8");
  const key = fs.readFileSync(keyPath, "utf8");
  return { cert, key, cleanup: () => removeTempDir(dir) };
}

/** Write a file synchronously (for `before` fixtures); returns the path written. */
export function writeFixture(dir: string, name: string, contents: string | Uint8Array): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

/** Raw response captured over a Unix-domain socket. */
export interface UnixResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** Send a request to a Unix-socket server via `node:http` and collect the response. */
export function unixFetch(
  socketPath: string,
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<UnixResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        path,
        method: init.method ?? "GET",
        headers: init.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Send a raw request over a TCP socket and return the full response bytes. Lets a
 * test craft malformed heads (too many headers, oversize lines) that `fetch` would
 * not allow, and read the native error response verbatim.
 */
export function rawRequest(port: number, raw: string | Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const net = require("node:net") as typeof import("node:net");
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(raw);
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks)));
    socket.on("close", () => resolve(Buffer.concat(chunks)));
    socket.on("error", reject);
    // Some error paths keep the connection open briefly; close our side after the head.
    socket.setTimeout(2000, () => socket.end());
  });
}

/** Parse the status code out of a raw HTTP response buffer (e.g. from {@link rawRequest}). */
export function rawStatus(response: Buffer): number {
  const firstLine = response.toString("latin1").split("\r\n", 1)[0] ?? "";
  const match = firstLine.match(/^HTTP\/1\.[01] (\d{3})/);
  return match ? Number(match[1]) : 0;
}
