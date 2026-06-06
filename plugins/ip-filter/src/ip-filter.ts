import { reply } from "@usetoki/toki";
import type { Middleware, TokiRequest } from "@usetoki/toki";
import { type Cidr, inCidr, parseCidr, parseIp } from "./cidr.js";

export interface IpFilterOptions {
  /** Allow-list of IPs/CIDRs. When set, an address must match one of these to pass. */
  allow?: string[];
  /** Deny-list of IPs/CIDRs. A match is always rejected, even if also allowed. */
  deny?: string[];
  /** Trust `X-Forwarded-For` and filter on its left-most address. Only enable behind a proxy you control. */
  trustProxy?: boolean;
  /** Status for a blocked request. Default `403`. */
  statusCode?: number;
  /** Body for a blocked request. Default `"Forbidden"`. */
  message?: string;
}

/**
 * Allow/deny requests by IP or CIDR. Mount on a route's `preHandler`, or `app.use` it
 * to guard a whole scope. `deny` always wins; with an `allow` list set, anything not
 * matched is rejected (default-deny). Lists are parsed once, up front — an invalid
 * entry throws at setup, not mid-request.
 */
export function ipFilter(options: IpFilterOptions = {}): Middleware {
  const allow = compile(options.allow);
  const deny = compile(options.deny);
  const trustProxy = options.trustProxy === true;
  const status = options.statusCode ?? 403;
  const message = options.message ?? "Forbidden";

  return (req) => {
    const ip = parseIp(clientIp(req, trustProxy));
    const blocked =
      ip === null || // an address we can't parse is never trusted
      deny.some((cidr) => inCidr(ip, cidr)) ||
      (allow.length > 0 && !allow.some((cidr) => inCidr(ip, cidr)));
    return blocked ? reply.text(message, status) : undefined;
  };
}

function compile(list: string[] | undefined): Cidr[] {
  if (list === undefined) return [];
  return list.map((entry) => {
    const cidr = parseCidr(entry);
    if (cidr === null) throw new Error(`ip-filter: invalid IP or CIDR "${entry}"`);
    return cidr;
  });
}

function clientIp(req: TokiRequest, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0]!.trim();
  }
  return req.ip;
}
