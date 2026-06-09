import type { EnvVar } from "./validators.ts";

/** A map of variable name → validator. */
export type EnvSchema = Record<string, EnvVar<unknown>>;

/** The typed config a schema produces — each key carries its validator's type. */
export type Env<S extends EnvSchema> = {
  readonly [K in keyof S]: S[K] extends EnvVar<infer T> ? T : never;
};

/** Thrown when one or more variables are missing or invalid; collects every problem. */
export class EnvError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid environment:\n  ${problems.join("\n  ")}`);
    this.name = "EnvError";
    this.problems = problems;
  }
}

/**
 * Validate `source` (default `process.env`) against `schema`, coercing each value to
 * its declared type. Reports *every* problem at once rather than failing on the first,
 * then returns a frozen, fully-typed config. A variable that is unset or empty falls
 * back to its `default`; without one, it's a hard error.
 */
export function loadEnv<S extends EnvSchema>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): Env<S> {
  const config: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const key of Object.keys(schema)) {
    const spec = schema[key]!;
    const raw = source[key]?.trim();

    if (raw === undefined || raw === "") {
      if (!spec.hasDefault) {
        problems.push(label(key, spec.desc, "is required"));
      } else if (
        spec.choices &&
        spec.default !== undefined &&
        !spec.choices.includes(spec.default)
      ) {
        problems.push(label(key, spec.desc, `default must be one of ${spec.choices.join(", ")}`));
      } else {
        config[key] = spec.default;
      }
      continue;
    }

    let value: unknown;
    try {
      value = spec.coerce(raw);
    } catch (err) {
      problems.push(label(key, spec.desc, `${(err as Error).message} (got "${raw}")`));
      continue;
    }

    if (spec.choices && !spec.choices.includes(value as never)) {
      problems.push(
        label(key, spec.desc, `must be one of ${spec.choices.join(", ")} (got "${raw}")`),
      );
      continue;
    }

    config[key] = value;
  }

  if (problems.length > 0) throw new EnvError(problems);
  return deepFreeze(config) as Env<S>;
}

// Object.freeze is shallow, so a json() value would stay mutable. Freeze the whole tree.
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

function label(key: string, desc: string | undefined, problem: string): string {
  return desc ? `${key} (${desc}) ${problem}` : `${key} ${problem}`;
}
