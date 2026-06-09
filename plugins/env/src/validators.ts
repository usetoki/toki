// A spec describes one variable: how to coerce it, an optional default, and an
// optional closed set of allowed values. `default` being present (even as `undefined`)
// is what marks a variable optional; absence then yields the default instead of erroring.
export interface Spec<T> {
  // `default: undefined` is a valid, meaningful value (marks the var optional), so the
  // type must admit it explicitly under exactOptionalPropertyTypes.
  default?: T | undefined;
  choices?: readonly T[];
  /** shown in the error report when this variable is missing or invalid. */
  desc?: string;
}

/** A typed variable descriptor produced by a validator (`str()`, `num()`, …). */
export interface EnvVar<T> {
  coerce(raw: string): T;
  readonly hasDefault: boolean;
  readonly default: T | undefined;
  readonly choices: readonly T[] | undefined;
  readonly desc: string | undefined;
}

function validator<T>(coerce: (raw: string) => T): (spec?: Spec<T>) => EnvVar<T> {
  return (spec = {}) => ({
    coerce,
    hasDefault: Object.prototype.hasOwnProperty.call(spec, "default"),
    default: spec.default,
    choices: spec.choices,
    desc: spec.desc,
  });
}

// decimal only — Number() would otherwise accept "0x1a", "0b10", "  5 ", "" (→0), etc.
const DECIMAL = /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const UNSIGNED_INT = /^\d+$/;

/** A required string, or one with a default. Use `choices` for an enum. */
export const str = validator<string>((raw) => raw);

export const num = validator<number>((raw) => {
  if (!DECIMAL.test(raw)) throw new Error("expected a number");
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error("expected a finite number"); // e.g. "1e999" → Infinity
  return n;
});

export const bool = validator<boolean>((raw) => {
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  throw new Error("expected a boolean (true/false, 1/0, yes/no, on/off)");
});

/** A TCP port: an integer in 1–65535. */
export const port = validator<number>((raw) => {
  if (!UNSIGNED_INT.test(raw)) throw new Error("expected a port (1–65535)");
  const n = Number(raw);
  if (n < 1 || n > 65535) throw new Error("expected a port (1–65535)");
  return n;
});

/** A URL; validated by the WHATWG `URL` parser, returned as the original string. */
export const url = validator<string>((raw) => {
  new URL(raw);
  return raw;
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const email = validator<string>((raw) => {
  if (!EMAIL.test(raw)) throw new Error("expected an email address");
  return raw;
});

/** A JSON document parsed into a value. */
export const json = validator<unknown>((raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("expected valid JSON");
  }
});
