import { reply } from "@usetoki/toki";
import type { ErrorHandler, TokiRequest } from "@usetoki/toki";
import { HttpError, type HttpErrorOptions, isHttpError } from "./errors.ts";

const encoder = new TextEncoder();

export interface ProblemOptions {
  /** Map a status to a problem `type` URI. Default `"about:blank"`. */
  type?: (status: number) => string;
  /** Invoked for 5xx (whose message is hidden from the client) — log the real error here. */
  onError?: (error: unknown, req: TokiRequest) => void;
}

/**
 * An {@link ErrorHandler} that renders thrown errors as RFC 9457
 * `application/problem+json`. An {@link HttpError} maps to its status and reason; a 4xx
 * exposes its message and `details`, a 5xx is reported as a bare "Internal Server Error"
 * so internals never leak. Any other thrown value becomes a 500.
 */
export function problemJson(options: ProblemOptions = {}): ErrorHandler {
  return (req, error) => {
    const httpError = toHttpError(error);
    const status = httpError.statusCode;
    if (status >= 500) options.onError?.(error, req);

    if (httpError.headers) {
      for (const [name, value] of Object.entries(httpError.headers)) {
        req.setResponseHeader(name, value);
      }
    }

    const problem = {
      ...(httpError.expose && httpError.details ? httpError.details : {}),
      type: options.type?.(status) ?? "about:blank",
      title: httpError.title,
      status,
      detail: httpError.expose ? httpError.message : httpError.title,
      instance: req.path,
    };
    return reply.bytes(
      encoder.encode(serialize(problem, httpError, status, req)),
      "application/problem+json; charset=utf-8",
      status,
    );
  };
}

// a non-serializable `details` (bigint, circular ref) must not crash the error handler.
// fall back to the standard members alone.
function serialize(
  problem: Record<string, unknown>,
  httpError: HttpError,
  status: number,
  req: TokiRequest,
): string {
  try {
    return JSON.stringify(problem);
  } catch {
    return JSON.stringify({
      type: problem.type,
      title: httpError.title,
      status,
      detail: httpError.expose ? httpError.message : httpError.title,
      instance: req.path,
    });
  }
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (isHttpError(error)) {
    const e = error as {
      statusCode: number;
      message?: string;
      headers?: unknown;
      details?: unknown;
    };
    const options: HttpErrorOptions = {};
    if (e.headers !== null && typeof e.headers === "object") {
      options.headers = e.headers as Record<string, string>;
    }
    if (e.details !== null && typeof e.details === "object") {
      options.details = e.details as Record<string, unknown>;
    }
    return new HttpError(e.statusCode, e.message, options);
  }
  return new HttpError(500); // unexpected failure; keep its message off the wire
}
