import type { TokiRequest } from "@usetoki/toki";

/** Verifies a request and returns the authenticated user, or `null` to decline. A
 *  truthy `challenge` is sent as `WWW-Authenticate` on a 401. */
export interface Strategy {
  (req: TokiRequest): unknown | Promise<unknown>;
  readonly challenge?: string;
}

/** A verify callback returns the user (any truthy value), or `null` to reject. */
export type VerifyResult = unknown | Promise<unknown>;
