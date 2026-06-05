import type { TokiRequest } from "./request.js";
import { isTokiResponse, jsonResponse, normalize, reply } from "./response.js";
import { type JSONSchema, type RouteSchema, serialize, validate } from "./schema.js";
import type {
  HandlerResult,
  Middleware,
  ResponseHook,
  SerializationHook,
  TokiResponse,
} from "./types.js";

export function isThenable<T>(value: unknown): value is Promise<T> {
  return (
    value != null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** What `materialize` needs off a compiled route — a CompiledRoute satisfies it. */
interface ResultShape {
  readonly responseSchemas?: Record<number, JSONSchema>;
  readonly defaultStatus?: number;
}

// turn a handler result into a response; plain values serialize as JSON, via the
// route's response schema when one is present
export function materialize(result: HandlerResult, route: ResultShape): TokiResponse {
  if (isTokiResponse(result)) {
    return result;
  }
  const status = route.defaultStatus ?? 200;
  if (typeof result === "string") {
    return reply.text(result, status);
  }
  const schema = route.responseSchemas?.[status];
  return jsonResponse(schema ? serialize(schema, result) : JSON.stringify(result), status);
}

// before-step: validate the request against `schema`, short-circuiting 400
export function validationStep(schema: RouteSchema): Middleware {
  return (req) => {
    const errors = validateRequest(req, schema);
    if (errors.length > 0) {
      return reply.json(
        { statusCode: 400, error: "Bad Request", message: errors.join("; "), errors },
        400,
      );
    }
  };
}

function validateRequest(req: TokiRequest, schema: RouteSchema): string[] {
  const errors: string[] = [];
  if (schema.params) {
    errors.push(...validate(schema.params, coerce(schema.params, { ...req.params }), "params"));
  }
  if (schema.query) {
    errors.push(...validate(schema.query, coerce(schema.query, fromEntries(req.query)), "query"));
  }
  if (schema.headers) {
    errors.push(...validate(schema.headers, fromEntries(req.headers), "headers"));
  }
  if (schema.body) {
    let body: unknown;
    try {
      body = req.json();
    } catch {
      return [...errors, "body must be valid JSON"];
    }
    errors.push(...validate(schema.body, body, "body"));
  }
  return errors;
}

function fromEntries(source: {
  entries(): IterableIterator<[string, string]>;
}): Record<string, string> {
  return Object.fromEntries(source.entries());
}

// coerce string-valued fields (query/params) to the type their schema declares
function coerce(schema: JSONSchema, obj: Record<string, unknown>): Record<string, unknown> {
  if (!schema.properties) {
    return obj;
  }
  const out: Record<string, unknown> = { ...obj };
  for (const [key, sub] of Object.entries(schema.properties)) {
    const value = out[key];
    if (typeof value !== "string") {
      continue;
    }
    if (sub.type === "number" || sub.type === "integer") {
      const n = Number(value);
      if (!Number.isNaN(n)) out[key] = n;
    } else if (sub.type === "boolean" && (value === "true" || value === "false")) {
      out[key] = value === "true";
    }
  }
  return out;
}

// content-type predicate: a RegExp, "*" for any, or a case-insensitive prefix
export function contentTypeMatcher(type: string | RegExp): (contentType: string) => boolean {
  if (type instanceof RegExp) {
    return (contentType) => type.test(contentType);
  }
  if (type === "*") {
    return () => true;
  }
  const lower = type.toLowerCase();
  return (contentType) => contentType.startsWith(lower);
}

// pipeline runners — each stays sync until a step returns a Promise, then chains

export function runBefore(
  steps: readonly Middleware[],
  req: TokiRequest,
  start: number,
): HandlerResult | undefined | Promise<HandlerResult | undefined> {
  for (let i = start; i < steps.length; i++) {
    const out = steps[i]!(req);
    if (isThenable(out)) {
      return out.then((value) => (value != null ? value : runBefore(steps, req, i + 1)));
    }
    if (out != null) {
      return out;
    }
  }
  return undefined;
}

// thread a payload through the preSerialization hooks; each returns the next payload
export function runSerialization(
  hooks: readonly SerializationHook[],
  req: TokiRequest,
  payload: unknown,
  start: number,
): unknown | Promise<unknown> {
  for (let i = start; i < hooks.length; i++) {
    const out = hooks[i]!(req, payload);
    if (isThenable(out)) {
      return out.then((value) => runSerialization(hooks, req, value, i + 1));
    }
    payload = out;
  }
  return payload;
}

export function runAfter(
  hooks: readonly ResponseHook[],
  req: TokiRequest,
  res: TokiResponse,
  start: number,
): TokiResponse | Promise<TokiResponse> {
  for (let i = start; i < hooks.length; i++) {
    const out = hooks[i]!(req, res);
    if (isThenable(out)) {
      return out.then((value) =>
        runAfter(hooks, req, value != null ? normalize(value) : res, i + 1),
      );
    }
    if (out != null) {
      res = normalize(out);
    }
  }
  return res;
}
