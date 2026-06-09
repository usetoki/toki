import type { DocPage } from "../../types";

export const envPluginPage: DocPage = {
  slug: "plugin-env",
  title: "Env",
  description:
    "Validate environment variables at boot into a typed, frozen config — zero dependencies.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-env` validates and coerces `process.env` against a small schema at startup. A missing or malformed variable fails fast, on boot, not mid-request three days later. You get back a frozen, fully-typed config object: `PORT` is a `number`, `NODE_ENV` is the literal union you declared. It's envalid-style with no JSON-schema dependency, which keeps it tiny and gives precise inference.",
    },
    {
      kind: "heading",
      id: "install",
      text: "Install",
    },
    {
      kind: "code",
      snippet: { filename: "install.sh", language: "bash", code: `npm install @usetoki/toki-env` },
    },
    {
      kind: "heading",
      id: "quick-start",
      text: "Quick start",
    },
    {
      kind: "paragraph",
      text: "Declare a schema with the validators, call `loadEnv` once at the top of your boot file, and export the result. Import it anywhere — the types follow.",
    },
    {
      kind: "code",
      snippet: {
        filename: "env.ts",
        language: "ts",
        code: `import { loadEnv, str, num, bool, port, url } from "@usetoki/toki-env";

export const env = loadEnv({
  NODE_ENV: str({ choices: ["development", "production", "test"], default: "development" }),
  PORT: port({ default: 3000 }),
  DATABASE_URL: url({ desc: "Postgres connection string" }),
  WORKERS: num({ default: 4 }),
  DEBUG: bool({ default: false }),
});

env.PORT;     // number
env.NODE_ENV; // "development" | "production" | "test"`,
      },
    },
    {
      kind: "code",
      snippet: {
        filename: "app.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";
import { env } from "./env.ts";

const app = createApp();
app.listen(env.PORT);`,
      },
    },
    {
      kind: "heading",
      id: "validators",
      text: "Validators",
    },
    {
      kind: "paragraph",
      text: "Seven validators cover the common shapes. Each coerces the raw string and rejects garbage: `num` is decimal-only (no `0x1a`, no empty-string-as-zero) and refuses non-finite values, `port` enforces 1–65535, `url` runs the WHATWG parser.",
    },
    {
      kind: "table",
      headers: ["Validator", "Coerces to", "Rejects"],
      rows: [
        ["str", "string", "nothing (use `choices` for an enum)"],
        ["num", "number", "non-decimal, `Infinity`, `NaN`"],
        ["bool", "boolean", "anything but true/false, 1/0, yes/no, on/off"],
        ["port", "number", "non-integers and values outside 1–65535"],
        ["url", "string (original)", "anything the WHATWG `URL` parser won't accept"],
        ["email", "string", "values without an `@` and a dotted host"],
        ["json", "unknown", "anything `JSON.parse` can't read"],
      ],
    },
    {
      kind: "heading",
      id: "spec",
      text: "Defaults, choices, and descriptions",
    },
    {
      kind: "paragraph",
      text: "Every validator takes the same three options. The presence of `default` is what makes a variable optional — even `default: undefined` marks it optional. An unset or empty variable falls back to its default; without one, it's a hard error.",
    },
    {
      kind: "table",
      headers: ["Option", "Type", "Effect"],
      rows: [
        ["default", "T | undefined", "Used when the variable is unset or empty; its presence makes the variable optional."],
        ["choices", "readonly T[]", "A closed set — a value outside it is an error."],
        ["desc", "string", "Shown in the error report, so the message names what's missing."],
      ],
    },
    {
      kind: "code",
      snippet: {
        filename: "more.ts",
        language: "ts",
        code: `import { loadEnv, str, json, email } from "@usetoki/toki-env";

export const env = loadEnv({
  LOG_LEVEL: str({ choices: ["debug", "info", "warn", "error"], default: "info" }),
  ADMIN_EMAIL: email({ desc: "where alerts go" }),
  FEATURE_FLAGS: json({ default: {} }), // parsed and deep-frozen
});`,
      },
    },
    {
      kind: "heading",
      id: "errors",
      text: "One report, every problem",
    },
    {
      kind: "paragraph",
      text: "`loadEnv` collects every problem and throws them together as an `EnvError`, so a single run tells you everything that's wrong rather than one variable per restart.",
    },
    {
      kind: "code",
      snippet: {
        filename: "error.txt",
        language: "bash",
        code: `EnvError: invalid environment:
  DATABASE_URL (Postgres connection string) is required
  PORT expected a port (1–65535) (got "70000")`,
      },
    },
    {
      kind: "heading",
      id: "testing",
      text: "Validating something other than process.env",
    },
    {
      kind: "paragraph",
      text: "`loadEnv` takes an optional second argument — a source map. Handy in tests, or to load from a parsed `.env` file.",
    },
    {
      kind: "code",
      snippet: {
        filename: "env.test.ts",
        language: "ts",
        code: `const env = loadEnv(schema, { PORT: "8080", DATABASE_URL: "postgres://localhost/test" });`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "The returned config is deep-frozen — a `json()` value can't be mutated later either. Treat it as read-only application config.",
    },
  ],
};
