import { open } from "node:fs/promises";
import { reply } from "@usetoki/toki";
import type { HandlerResult, TokiRequest } from "@usetoki/toki";
import { parseRange, type RangeSpec } from "./parse.js";

export interface RangeOptions {
  /** Content type of the entity. Default `"application/octet-stream"`. */
  contentType?: string;
}

/**
 * Serve `source` (a buffer or a file path) honoring the request's `Range` header. No
 * range → the full entity; a satisfiable range → `206` with `Content-Range` and just
 * those bytes (with a correct `Content-Length`); an unsatisfiable one → `416`.
 * `Accept-Ranges: bytes` is always set. The file is opened once before any header is
 * committed, so a missing file becomes a clean error rather than a truncated `206`.
 */
export async function sendRange(
  req: TokiRequest,
  source: Uint8Array | string,
  options: RangeOptions = {},
): Promise<HandlerResult> {
  const contentType = options.contentType ?? "application/octet-stream";
  req.setResponseHeader("Accept-Ranges", "bytes");
  return typeof source === "string"
    ? sendFile(req, source, contentType)
    : sendBuffer(req, source, contentType);
}

function sendBuffer(req: TokiRequest, body: Uint8Array, contentType: string): HandlerResult {
  const size = body.byteLength;
  const range = rangeOf(req, size);
  if (range === "invalid") return unsatisfiable(req, size);
  if (range === null) return reply.bytes(body, contentType, 200);
  req.setResponseHeader("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  return reply.bytes(body.subarray(range.start, range.end + 1), contentType, 206);
}

async function sendFile(
  req: TokiRequest,
  path: string,
  contentType: string,
): Promise<HandlerResult> {
  const handle = await open(path); // throws before any header is sent if the file is gone
  let size: number;
  try {
    size = (await handle.stat()).size;
  } catch (error) {
    await handle.close();
    throw error;
  }

  const range = rangeOf(req, size);
  if (range === "invalid") {
    await handle.close();
    return unsatisfiable(req, size);
  }
  if (range === null) {
    // full file: stream it, so a large file is never fully buffered (the fd closes on end)
    return reply.stream(handle.createReadStream(), { contentType });
  }

  // a range: read exactly those bytes from the same fd, so Content-Length is correct
  const length = range.end - range.start + 1;
  const buffer = Buffer.alloc(length);
  let read = 0;
  try {
    // a single read() may be short; loop so we never serve zero-padded tail bytes
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, range.start + read);
      if (bytesRead === 0) break; // truncated underneath us — serve what's actually there
      read += bytesRead;
    }
  } finally {
    await handle.close();
  }
  const end = range.start + read - 1;
  req.setResponseHeader("Content-Range", `bytes ${range.start}-${end}/${size}`);
  return reply.bytes(buffer.subarray(0, read), contentType, 206);
}

function rangeOf(req: TokiRequest, size: number): RangeSpec {
  const header = req.headers.get("range");
  return header === null ? null : parseRange(header, size);
}

function unsatisfiable(req: TokiRequest, size: number): HandlerResult {
  req.setResponseHeader("Content-Range", `bytes */${size}`);
  return reply.text("", 416);
}
