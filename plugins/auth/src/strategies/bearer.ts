import type { TokiRequest } from "@usetoki/toki";
import type { Strategy, VerifyResult } from "../types.js";

/** Bearer-token auth. `verify(token, req)` returns the user, or null to reject. */
export function bearer(verify: (token: string, req: TokiRequest) => VerifyResult): Strategy {
  const strategy: Strategy = async (req) => {
    const header = req.headers.get("authorization");
    if (header === null || !header.startsWith("Bearer ")) return null;
    const token = header.slice(7).trim();
    if (token === "") return null;
    return (await verify(token, req)) ?? null;
  };
  return Object.assign(strategy, { challenge: "Bearer" });
}
