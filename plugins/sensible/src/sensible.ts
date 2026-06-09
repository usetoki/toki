import type { TokiInstance } from "@usetoki/toki";
import { problemJson, type ProblemOptions } from "./problem.ts";

/**
 * Install the RFC 9457 problem+json error handler on a scope. Throw an `httpErrors.*`
 * (or call `assert`) from any handler and it's rendered as `application/problem+json`.
 */
export function sensible(instance: TokiInstance, options: ProblemOptions = {}): void {
  instance.setErrorHandler(problemJson(options));
}
