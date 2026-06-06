import type { TokiRequest } from "@usetoki/toki";

/**
 * Check the request's `Origin` (falling back to `Referer`) against a host allow-list.
 * `allowed === null` means same-origin — compare to the request's own `Host`. A request
 * with neither header is unverifiable and rejected, which is the safe default for a
 * state-changing call.
 */
export function originAllowed(req: TokiRequest, allowed: readonly string[] | null): boolean {
  const source = req.headers.get("origin") ?? req.headers.get("referer");
  if (source === null) return false;

  let host: string;
  try {
    host = new URL(source).host;
  } catch {
    return false;
  }

  if (allowed !== null) return allowed.includes(host);
  const self = req.headers.get("host");
  return self !== null && host === self;
}
