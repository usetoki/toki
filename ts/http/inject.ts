// real HTTP/1.1 over loopback rather than a fake request, so tests hit the actual
// native path (parse, route, dispatch, stream, rate-limit) end to end.
import { request as httpRequest } from "node:http";

/** What to inject. A bare string is shorthand for `{ url }` (a GET). */
export interface InjectOptions {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  // non-string/non-bytes payload is JSON-encoded and sets content-type
  payload?: string | Uint8Array | Record<string, unknown> | unknown[];
}

/** Captured response, shaped after Fastify's `inject` result. */
export interface InjectResponse {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  payload: string; // alias of body
  rawPayload: Buffer;
  json<T = unknown>(): T;
}

interface NormalizedInject {
  method: string;
  url: string;
  headers: Record<string, string>;
  payload: string | Uint8Array | undefined;
}

function normalize(options: InjectOptions | string): NormalizedInject {
  const opts = typeof options === "string" ? { url: options } : options;
  const headers = { ...(opts.headers ?? {}) };
  let payload: string | Uint8Array | undefined;
  if (opts.payload !== undefined) {
    if (typeof opts.payload === "string" || opts.payload instanceof Uint8Array) {
      payload = opts.payload;
    } else {
      payload = JSON.stringify(opts.payload);
      if (!hasHeader(headers, "content-type")) {
        headers["content-type"] = "application/json";
      }
    }
    // engine reads Content-Length, not chunked request bodies — force fixed framing
    if (!hasHeader(headers, "content-length")) {
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
  }
  return { method: opts.method ?? "GET", url: opts.url ?? "/", headers, payload };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

/** Sends one request to `127.0.0.1:port` and resolves the captured response. */
export function inject(port: number, options: InjectOptions | string): Promise<InjectResponse> {
  const { method, url, headers, payload } = normalize(options);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path: url, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const rawPayload = Buffer.concat(chunks);
        const body = rawPayload.toString("utf8");
        resolve({
          statusCode: res.statusCode ?? 0,
          statusMessage: res.statusMessage ?? "",
          headers: res.headers,
          body,
          payload: body,
          rawPayload,
          json: <T = unknown>() => JSON.parse(body) as T,
        });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}
