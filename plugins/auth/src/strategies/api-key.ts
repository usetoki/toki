import type { TokiRequest } from "@usetoki/toki";
import type { Strategy, VerifyResult } from "../types.ts";

export interface ApiKeyOptions {
  /** header carrying the key. Default "x-api-key". */
  header?: string;
  /** optional query parameter to fall back to (e.g. "api_key"). */
  query?: string;
}

/** API-key auth from a header (and optional query param). `verify(key, req)` returns the
 *  user, or null to reject. */
export function apiKey(
  verify: (key: string, req: TokiRequest) => VerifyResult,
  options: ApiKeyOptions = {},
): Strategy {
  const header = (options.header ?? "x-api-key").toLowerCase();
  const query = options.query;
  return async (req) => {
    let key = req.headers.get(header);
    if (key === null && query !== undefined) key = req.query.get(query);
    if (key === null || key === "") return null;
    return (await verify(key, req)) ?? null;
  };
}
