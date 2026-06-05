import type { TokiRequest } from "@usetoki/toki";
import type { Strategy, VerifyResult } from "../types.js";

export interface BasicOptions {
  /** realm shown in the WWW-Authenticate challenge. Default "Restricted". */
  realm?: string;
}

/** HTTP Basic auth. `verify(username, password, req)` returns the user, or null to reject. */
export function basic(
  verify: (username: string, password: string, req: TokiRequest) => VerifyResult,
  options: BasicOptions = {},
): Strategy {
  const challenge = `Basic realm="${options.realm ?? "Restricted"}"`;
  const strategy: Strategy = async (req) => {
    const header = req.headers.get("authorization");
    if (header === null || !header.startsWith("Basic ")) return null;
    const decoded = decode(header.slice(6));
    if (decoded === null) return null;
    const sep = decoded.indexOf(":");
    if (sep < 0) return null;
    return (await verify(decoded.slice(0, sep), decoded.slice(sep + 1), req)) ?? null;
  };
  return Object.assign(strategy, { challenge });
}

function decode(b64: string): string | null {
  try {
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return null;
  }
}
