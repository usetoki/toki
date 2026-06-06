import type { TokiRequest } from "@usetoki/toki";

/** Cache key: method + path + query, plus the values of any `vary` headers. */
export function defaultKey(req: TokiRequest, vary: readonly string[]): string {
  const query = req.query.toString();
  let key = query ? `${req.method} ${req.path}?${query}` : `${req.method} ${req.path}`;
  if (vary.length > 0) {
    key += ` | ${vary.map((header) => `${header}=${req.headers.get(header) ?? ""}`).join("&")}`;
  }
  return key;
}
