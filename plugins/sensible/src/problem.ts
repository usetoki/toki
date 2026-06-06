import { reply } from "@usetoki/toki";
import type { ErrorHandler, TokiRequest } from "@usetoki/toki";
import { HttpError, isHttpError } from "./errors.js";

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
      encoder.encode(JSON.stringify(problem)),
      "application/problem+json; charset=utf-8",
      status,
    );
  };
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (isHttpError(error)) {
    const e = error as { statusCode: number; message?: string };
    return new HttpError(e.statusCode, e.message);
  }
  return new HttpError(500); // an unexpected failure — keep its message off the wire
}
