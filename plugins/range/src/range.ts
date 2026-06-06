import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { reply } from "@usetoki/toki";
import type { HandlerResult, TokiRequest } from "@usetoki/toki";
import { parseRange } from "./parse.js";

export interface RangeOptions {
  /** Content type of the entity. Default `"application/octet-stream"`. */
  contentType?: string;
}

/**
 * Serve `source` (a buffer or a file path) honoring the request's `Range` header. No
 * range → the full entity; a satisfiable range → `206` with `Content-Range` and just
 * those bytes; an unsatisfiable one → `416`. `Accept-Ranges: bytes` is always set. Files
 * are streamed a slice at a time, so a range read never loads the whole file into memory.
 */
export async function sendRange(
  req: TokiRequest,
  source: Uint8Array | string,
  options: RangeOptions = {},
): Promise<HandlerResult> {
  const contentType = options.contentType ?? "application/octet-stream";
  const size = typeof source === "string" ? (await stat(source)).size : source.byteLength;
  req.setResponseHeader("Accept-Ranges", "bytes");

  const header = req.headers.get("range");
  const range = header === null ? null : parseRange(header, size);

  if (range === "invalid") {
    req.setResponseHeader("Content-Range", `bytes */${size}`);
    return reply.text("", 416);
  }

  if (range === null) {
    return typeof source === "string"
      ? reply.stream(createReadStream(source), { contentType })
      : reply.bytes(source, contentType, 200);
  }

  const { start, end } = range;
  req.setResponseHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  if (typeof source === "string") {
    return reply.stream(createReadStream(source, { start, end }), { status: 206, contentType });
  }
  return reply.bytes(source.subarray(start, end + 1), contentType, 206);
}
