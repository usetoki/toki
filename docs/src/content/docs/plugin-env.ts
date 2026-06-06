import type { DocPage } from "../../types";

export const envPluginPage: DocPage = {
  slug: "plugin-env",
  title: "Env",
  description:
    "Validate environment variables at boot into a typed, frozen config — zero dependencies.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-env` validates and coerces `process.env` against a small schema at startup, so a missing or malformed variable fails fast — on boot, not mid-request. The result is a frozen, fully-typed config object. It's envalid-style (no JSON-schema dependency), which keeps it tiny and gives precise inference.",
    },
    {
      kind: "code",
      snippet: { filename: "install.sh", language: "bash", code: `npm install @usetoki/toki-env` },
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
      kind: "list",
      items: [
        "Validators: `str`, `num`, `bool`, `port` (1–65535), `url`, `email`, `json`.",
        "Each takes `default` (its presence makes the variable optional), `choices` (a closed set), and `desc`.",
        "A variable that is unset or empty falls back to its `default`; without one it's a hard error.",
      ],
    },
    {
      kind: "paragraph",
      text: "Every problem is collected and thrown together as an `EnvError`, so a single run reports everything that's wrong at once rather than one variable at a time.",
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
  ],
};
