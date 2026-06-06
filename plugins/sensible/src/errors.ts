// Reason phrases for the status codes we name. Drives both HttpError.title and the
// `title` field of a problem+json document.
const REASONS: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Payload Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a Teapot",
  422: "Unprocessable Entity",
  423: "Locked",
  424: "Failed Dependency",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  507: "Insufficient Storage",
  511: "Network Authentication Required",
};

export interface HttpErrorOptions {
  /** Response headers to set alongside the error (e.g. `Retry-After`, `WWW-Authenticate`). */
  headers?: Record<string, string>;
  /** Extra members merged into the problem+json document (RFC 9457 extension members). */
  details?: Record<string, unknown>;
  /** The underlying cause, kept off the wire. */
  cause?: unknown;
}

/** An error carrying an HTTP status. 4xx expose their message; 5xx hide it by default. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly expose: boolean;
  readonly headers: Record<string, string> | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(statusCode: number, message?: string, options: HttpErrorOptions = {}) {
    super(message ?? REASONS[statusCode] ?? "Error", { cause: options.cause });
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.expose = statusCode < 500;
    this.headers = options.headers;
    this.details = options.details;
  }

  /** The status reason phrase, e.g. `"Not Found"`. */
  get title(): string {
    return REASONS[this.statusCode] ?? "Error";
  }
}

/** Build an {@link HttpError} for any status. */
export function createError(
  statusCode: number,
  message?: string,
  options?: HttpErrorOptions,
): HttpError {
  return new HttpError(statusCode, message, options);
}

/** True for an {@link HttpError} or any error-like object carrying a numeric `statusCode`. */
export function isHttpError(value: unknown): value is HttpError {
  if (value instanceof HttpError) return true;
  if (typeof value !== "object" || value === null) return false;
  // a real HTTP error status — rejects NaN/Infinity, out-of-range, and 2xx/3xx that would
  // otherwise reach the wire as a garbage status or silently swallow a programming error
  const status = (value as { statusCode?: unknown }).statusCode;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599;
}

// Named factory → status. Method names follow the @fastify/sensible / http-errors convention.
const FACTORIES = {
  badRequest: 400,
  unauthorized: 401,
  paymentRequired: 402,
  forbidden: 403,
  notFound: 404,
  methodNotAllowed: 405,
  notAcceptable: 406,
  requestTimeout: 408,
  conflict: 409,
  gone: 410,
  lengthRequired: 411,
  preconditionFailed: 412,
  payloadTooLarge: 413,
  uriTooLong: 414,
  unsupportedMediaType: 415,
  rangeNotSatisfiable: 416,
  expectationFailed: 417,
  imateapot: 418,
  unprocessableEntity: 422,
  locked: 423,
  failedDependency: 424,
  preconditionRequired: 428,
  tooManyRequests: 429,
  requestHeaderFieldsTooLarge: 431,
  unavailableForLegalReasons: 451,
  internalServerError: 500,
  notImplemented: 501,
  badGateway: 502,
  serviceUnavailable: 503,
  gatewayTimeout: 504,
  httpVersionNotSupported: 505,
  insufficientStorage: 507,
  networkAuthenticationRequired: 511,
} as const;

type ErrorFactory = (message?: string, options?: HttpErrorOptions) => HttpError;

/** Named constructors: `httpErrors.notFound()`, `httpErrors.conflict("taken")`, … */
export const httpErrors = Object.fromEntries(
  Object.entries(FACTORIES).map(([name, status]) => [
    name,
    (message?: string, options?: HttpErrorOptions) => createError(status, message, options),
  ]),
) as Record<keyof typeof FACTORIES, ErrorFactory>;
