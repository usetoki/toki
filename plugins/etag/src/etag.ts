import { reply } from "@usetoki/toki";
import type { TokiInstance, TokiRequest, TokiResponse } from "@usetoki/toki";
import { type EtagAlgorithm, hasher } from "./hash.ts";

export interface EtagOptions {
  /** Emit a weak validator (`W/"…"`) instead of a strong one. Default `false`. */
  weak?: boolean;
  /** Digest for the validator. `"fnv1a"` (default) is fast and non-crypto; sha1/md5/sha256 use node:crypto. */
  algorithm?: EtagAlgorithm;
}

const encoder = new TextEncoder();

/**
 * Tag GET/HEAD responses with an `ETag` derived from the body, and answer
 * `304 Not Modified` when the client's `If-None-Match` already holds that tag.
 * Streams skip response hooks, so only materialized bodies are tagged. A handler
 * that set its own `ETag` is left untouched.
 */
export function etag(instance: TokiInstance, options: EtagOptions = {}): void {
  const compute = hasher(options.algorithm ?? "fnv1a");
  const open = options.weak === true ? 'W/"' : '"';

  instance.addHook("onSend", (req, res) => {
    // only validate successful GET/HEAD bodies; never turn an error or redirect into a 304
    if (req.method !== "GET" && req.method !== "HEAD") return undefined;
    if (res.status !== 200 || hasEtag(req, res)) return undefined;

    const tag = open + compute(bytesOf(res.body)) + '"';
    req.setResponseHeader("ETag", tag);

    const ifNoneMatch = req.headers.get("if-none-match");
    if (ifNoneMatch !== null && matches(ifNoneMatch, tag)) return reply.empty(304);
    return undefined;
  });
}

function bytesOf(body: string | Uint8Array): Uint8Array {
  return typeof body === "string" ? encoder.encode(body) : body;
}

// an ETag the handler set itself — on the response, or staged via setResponseHeader
function hasEtag(req: TokiRequest, res: TokiResponse): boolean {
  const isEtag = (entry: readonly [string, string]): boolean => entry[0].toLowerCase() === "etag";
  return res.headers.some(isEtag) || req.stagedResponseHeaders.some(isEtag);
}

// If-None-Match uses weak comparison: ignore the W/ prefix; "*" matches any tag.
function matches(header: string, tag: string): boolean {
  if (header.trim() === "*") return true;
  const target = unweak(tag);
  return header.split(",").some((candidate) => unweak(candidate) === target);
}

function unweak(tag: string): string {
  return tag.trim().replace(/^W\//, "");
}
