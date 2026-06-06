import { createError, type HttpErrorOptions } from "./errors.js";

/**
 * Throw an {@link HttpError} with `status` when `condition` is falsy. The narrowing return
 * type lets the compiler treat the value as present after the call:
 *
 * ```ts
 * const user = await db.find(id);
 * assert(user, 404, "user not found");
 * user.email; // narrowed to non-null
 * ```
 */
export function assert(
  condition: unknown,
  status: number,
  message?: string,
  options?: HttpErrorOptions,
): asserts condition {
  if (!condition) throw createError(status, message, options);
}
