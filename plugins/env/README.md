# @usetoki/toki-env

Validate and coerce environment variables at boot into a typed, frozen config — for
[toki](https://usetoki.github.io/toki/), with zero dependencies. Catch a missing or
malformed variable on startup, not at 3am in production.

```bash
npm install @usetoki/toki-env
```

## Usage

```ts
import { loadEnv, str, num, bool, port, url } from "@usetoki/toki-env";

export const env = loadEnv({
  NODE_ENV: str({ choices: ["development", "production", "test"], default: "development" }),
  PORT: port({ default: 3000 }),
  DATABASE_URL: url({ desc: "Postgres connection string" }),
  LOG_LEVEL: str({ default: "info" }),
  WORKERS: num({ default: 4 }),
  DEBUG: bool({ default: false }),
});

env.PORT; // number
env.NODE_ENV; // "development" | "production" | "test"
```

`loadEnv` reads `process.env` (or any map you pass), coerces each value, and returns a
frozen, fully-typed object. A variable that is unset or empty falls back to its `default`;
without one it's a hard error.

## Validators

`str`, `num`, `bool`, `port` (1–65535), `url`, `email`, `json`. Each takes an optional
spec: `default` (its presence makes the variable optional), `choices` (a closed set), and
`desc` (shown in the error report).

## Errors

Every problem is collected and thrown together as an `EnvError`, so one run tells you
everything that's wrong:

```
EnvError: invalid environment:
  DATABASE_URL (Postgres connection string) is required
  PORT expected a port (1–65535) (got "70000")
```

`bool` accepts `true/false`, `1/0`, `yes/no`, `on/off`. Pass an explicit
`default: undefined` to make a variable optional without a fallback value.
