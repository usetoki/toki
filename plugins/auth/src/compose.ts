import { type HandlerResult, type Middleware, reply, type TokiRequest } from "@usetoki/toki";
import type { Strategy } from "./types.js";

declare module "@usetoki/toki" {
  interface TokiRequest {
    user?: unknown;
  }
}

export interface AuthOptions {
  /** "anyOf" (default): one strategy must pass. "allOf": every strategy must pass. */
  mode?: "anyOf" | "allOf";
  /** custom response when authentication fails. Default: a 401 JSON body. */
  onUnauthorized?: (req: TokiRequest) => HandlerResult;
}

/** Compose one or more strategies into a middleware that sets `req.user`, or replies 401. */
export function auth(strategies: Strategy | Strategy[], options: AuthOptions = {}): Middleware {
  const list = Array.isArray(strategies) ? strategies : [strategies];
  const allOf = options.mode === "allOf";
  const challenges = list.map((s) => s.challenge).filter((c): c is string => c !== undefined);
  const reject = options.onUnauthorized;

  return async (req) => {
    let user: unknown = null;
    for (const strategy of list) {
      const result = await strategy(req);
      // a strategy that resolves null OR undefined did not authenticate
      if (result == null) {
        if (allOf) return fail(req, challenges, reject);
        continue;
      }
      user = result;
      if (!allOf) break; // anyOf: stop at the first that passes
    }
    if (user == null) return fail(req, challenges, reject);
    req.user = user;
    return undefined;
  };
}

function fail(
  req: TokiRequest,
  challenges: readonly string[],
  reject: ((req: TokiRequest) => HandlerResult) | undefined,
): HandlerResult {
  if (reject !== undefined) return reject(req);
  for (const challenge of challenges) req.appendResponseHeader("WWW-Authenticate", challenge);
  return reply.json(
    { statusCode: 401, error: "Unauthorized", message: "authentication required" },
    401,
  );
}
