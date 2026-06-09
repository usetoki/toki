import { type HandlerResult, type Middleware, reply, type TokiRequest } from "@usetoki/toki";
import { JwtError } from "./errors.ts";
import type { KeyInput, KeyResolver } from "./types.ts";
import { verifyJwt, type VerifyOptions } from "./verify.ts";

declare module "@usetoki/toki" {
  interface TokiRequest {
    user?: unknown;
  }
}

export interface JwtAuthOptions extends VerifyOptions {
  /** public key, HMAC secret, or a JWKS resolver from {@link createJwksResolver}. */
  key: KeyInput | KeyResolver;
  /** extract the token from a request. Default: the `Authorization: Bearer` header. */
  getToken?: (req: TokiRequest) => string | null;
  /** request property the payload is attached to. Default "user". */
  decorateAs?: string;
  /** custom response when verification fails. Default: a 401 JSON body. */
  onUnauthorized?: (req: TokiRequest, error: unknown) => HandlerResult;
}

/** Verify a Bearer JWT and attach the payload to `req.user` (or 401). */
export function jwtAuth(options: JwtAuthOptions): Middleware {
  const { key, getToken, decorateAs = "user", onUnauthorized, ...verifyOptions } = options;
  const extract = getToken ?? bearerToken;

  return async (req) => {
    const token = extract(req);
    if (token === null) return fail(req, new JwtError("missing token"), onUnauthorized);
    try {
      const payload = await verifyJwt(token, key, verifyOptions);
      (req as unknown as Record<string, unknown>)[decorateAs] = payload;
      return undefined;
    } catch (error) {
      return fail(req, error, onUnauthorized);
    }
  };
}

function bearerToken(req: TokiRequest): string | null {
  const header = req.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token === "" ? null : token;
}

function fail(
  req: TokiRequest,
  error: unknown,
  custom: ((req: TokiRequest, error: unknown) => HandlerResult) | undefined,
): HandlerResult {
  if (custom !== undefined) return custom(req, error);
  const message = error instanceof JwtError ? error.message : "invalid token";
  req.appendResponseHeader("WWW-Authenticate", "Bearer");
  return reply.json({ statusCode: 401, error: "Unauthorized", message }, 401);
}
