import type { NativeResponse } from "./native.js";
import type { HandlerResult, StreamResponse, StreamSource, TokiResponse } from "./types.js";

type StagedHeaders = ReadonlyArray<readonly [string, string]>;

const TOKI_RESPONSE = Symbol.for("toki.response");
const TOKI_STREAM = Symbol.for("toki.stream");

export function isTokiResponse(value: unknown): value is TokiResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[TOKI_RESPONSE] === true
  );
}

export function isStreamResponse(value: unknown): value is StreamResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[TOKI_STREAM] === true
  );
}

/** Wrap an already-serialized JSON string as a response (schema serialization path). */
export function jsonResponse(serialized: string, status = 200): TokiResponse {
  return {
    status,
    contentType: JSON_TYPE,
    headers: [],
    body: serialized,
    [TOKI_RESPONSE]: true,
  } as TokiResponse;
}

/** Build a fully-specified branded response (for middleware crafting its own). */
export function rawResponse(
  status: number,
  contentType: string,
  body: string | Uint8Array,
  headers: ReadonlyArray<readonly [string, string]> = [],
): TokiResponse {
  return make(status, contentType, body, headers);
}

const TEXT = "text/plain; charset=utf-8";
const HTML = "text/html; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";

function make(
  status: number,
  contentType: string,
  body: string | Uint8Array,
  headers: ReadonlyArray<readonly [string, string]> = [],
): TokiResponse {
  return { status, contentType, headers, body, [TOKI_RESPONSE]: true } as TokiResponse;
}

/** Builders for the common response shapes. */
export const reply = {
  text(body: string, status = 200): TokiResponse {
    return make(status, TEXT, body);
  },

  html(body: string, status = 200): TokiResponse {
    return make(status, HTML, body);
  },

  json<T>(data: T, status = 200): TokiResponse {
    return make(status, JSON_TYPE, JSON.stringify(data));
  },

  empty(status = 204): TokiResponse {
    return make(status, TEXT, "");
  },

  redirect(location: string, status = 302): TokiResponse {
    return make(status, TEXT, "", [["Location", location]]);
  },

  bytes(data: Uint8Array, contentType = "application/octet-stream", status = 200): TokiResponse {
    return make(status, contentType, data);
  },

  /**
   * Chunked streaming response. `source` is an async/sync iterable or Node `Readable`;
   * each chunk (bytes or utf-8 string) is written as it arrives. SSE: set
   * `contentType: "text/event-stream"`.
   */
  stream(
    source: StreamSource,
    options: {
      status?: number;
      contentType?: string;
      headers?: ReadonlyArray<readonly [string, string]>;
    } = {},
  ): StreamResponse {
    return {
      status: options.status ?? 200,
      contentType: options.contentType ?? "application/octet-stream",
      headers: options.headers ?? [],
      source,
      [TOKI_STREAM]: true,
    } as StreamResponse;
  },
} as const;

/** String becomes text/plain; any other plain value becomes JSON. */
export function normalize(result: HandlerResult): TokiResponse {
  if (typeof result === "string") {
    return reply.text(result);
  }
  if (isTokiResponse(result)) {
    return result;
  }
  return reply.json(result);
}

/** Flatten a handler result into the engine's wire shape, prepending staged headers. */
export function toNative(result: HandlerResult, staged: StagedHeaders = []): NativeResponse {
  const response = normalize(result);
  let headers = "";
  // staged first: on a single-valued conflict the response's own header wins (written last)
  for (const [name, value] of staged) {
    headers += `${name}: ${value}\r\n`;
  }
  headers += `Content-Type: ${response.contentType}\r\n`;
  for (const [name, value] of response.headers) {
    headers += `${name}: ${value}\r\n`;
  }
  return { status: response.status, headers, body: response.body };
}
