// A compact JSON Schema subset for request validation and response serialization.
// Dependency-free; covers the shapes real APIs use. Not a full draft implementation.

/** Custom error messages: one for the whole field, or per failing keyword. */
export interface ErrorMessages {
  type?: string;
  enum?: string;
  minLength?: string;
  maxLength?: string;
  pattern?: string;
  format?: string;
  minimum?: string;
  maximum?: string;
  additionalProperties?: string;
  /** Generic message, or one per required property name. */
  required?: string | Record<string, string>;
}

export interface JSONSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: ReadonlyArray<unknown>;
  /** Allow `null` in addition to `type`. */
  nullable?: boolean;
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: "email" | "uuid" | "date-time" | "uri";
  default?: unknown;
  /** Override the message(s) emitted when this schema fails. */
  errorMessage?: string | ErrorMessages;
}

/** custom message for a failed keyword, else fallback */
function messageFor(schema: JSONSchema, keyword: keyof ErrorMessages, fallback: string): string {
  const em = schema.errorMessage;
  if (typeof em === "string") return em;
  if (em && typeof em === "object") {
    const m = em[keyword];
    if (typeof m === "string") return m;
  }
  return fallback;
}

/** Per-route schema. `response` keys by status code. */
export interface RouteSchema {
  body?: JSONSchema;
  query?: JSONSchema;
  params?: JSONSchema;
  headers?: JSONSchema;
  response?: Record<number, JSONSchema>;
}

const FORMATS: Record<string, RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/,
  uri: /^[a-z][a-z0-9+.-]*:/i,
};

/** Validates `value` against `schema`, returning human-readable error messages (empty = valid). */
export function validate(schema: JSONSchema, value: unknown, path = ""): string[] {
  const errors: string[] = [];
  check(schema, value, path || "value", errors);
  return errors;
}

function check(schema: JSONSchema, value: unknown, path: string, errors: string[]): void {
  if (value === null) {
    if (schema.nullable || schema.type === "null") {
      return;
    }
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    errors.push(
      messageFor(schema, "enum", `${path} must be one of ${JSON.stringify(schema.enum)}`),
    );
    return;
  }
  switch (schema.type) {
    case "object":
      checkObject(schema, value, path, errors);
      break;
    case "array":
      checkArray(schema, value, path, errors);
      break;
    case "string":
      checkString(schema, value, path, errors);
      break;
    case "number":
    case "integer":
      checkNumber(schema, value, path, errors);
      break;
    case "boolean":
      if (typeof value !== "boolean")
        errors.push(messageFor(schema, "type", `${path} must be a boolean`));
      break;
    default:
      break;
  }
}

// required-property message: generic override, per-property map, or fallback
function requiredMessage(schema: JSONSchema, key: string, fallback: string): string {
  const em = schema.errorMessage;
  if (typeof em === "string") return em;
  if (em && typeof em === "object" && em.required !== undefined) {
    if (typeof em.required === "string") return em.required;
    return em.required[key] ?? fallback;
  }
  return fallback;
}

function checkObject(schema: JSONSchema, value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(messageFor(schema, "type", `${path} must be an object`));
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (!(key in obj)) {
      errors.push(requiredMessage(schema, key, `${path}.${key} is required`));
    }
  }
  if (schema.properties) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in obj) {
        check(sub, obj[key], `${path}.${key}`, errors);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in schema.properties)) {
          errors.push(messageFor(schema, "additionalProperties", `${path}.${key} is not allowed`));
        }
      }
    }
  }
}

function checkArray(schema: JSONSchema, value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(messageFor(schema, "type", `${path} must be an array`));
    return;
  }
  if (schema.items) {
    value.forEach((item, i) => check(schema.items as JSONSchema, item, `${path}[${i}]`, errors));
  }
}

function checkString(schema: JSONSchema, value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string") {
    errors.push(messageFor(schema, "type", `${path} must be a string`));
    return;
  }
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(
      messageFor(schema, "minLength", `${path} must be at least ${schema.minLength} characters`),
    );
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    errors.push(
      messageFor(schema, "maxLength", `${path} must be at most ${schema.maxLength} characters`),
    );
  }
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
    errors.push(messageFor(schema, "pattern", `${path} must match ${schema.pattern}`));
  }
  if (schema.format && FORMATS[schema.format] && !FORMATS[schema.format]!.test(value)) {
    errors.push(messageFor(schema, "format", `${path} must be a valid ${schema.format}`));
  }
}

function checkNumber(schema: JSONSchema, value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "number" || Number.isNaN(value)) {
    errors.push(messageFor(schema, "type", `${path} must be a number`));
    return;
  }
  if (schema.type === "integer" && !Number.isInteger(value)) {
    errors.push(messageFor(schema, "type", `${path} must be an integer`));
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    errors.push(messageFor(schema, "minimum", `${path} must be >= ${schema.minimum}`));
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    errors.push(messageFor(schema, "maximum", `${path} must be <= ${schema.maximum}`));
  }
}

/** schema-driven serialize: emits only declared props, falls back to JSON.stringify when type unknown */
export function serialize(schema: JSONSchema, value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object") return "null";
      const obj = value as Record<string, unknown>;
      let out = "{";
      let first = true;
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (obj[key] === undefined) {
          continue;
        }
        if (!first) out += ",";
        out += `${JSON.stringify(key)}:${serialize(sub, obj[key])}`;
        first = false;
      }
      return out + "}";
    }
    case "array": {
      if (!Array.isArray(value)) return "[]";
      const item = schema.items ?? {};
      return `[${value.map((v) => serialize(item, v)).join(",")}]`;
    }
    case "string":
      return JSON.stringify(String(value));
    case "integer":
    case "number":
      return Number.isFinite(value as number) ? String(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    default:
      return JSON.stringify(value);
  }
}
