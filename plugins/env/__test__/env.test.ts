import assert from "node:assert/strict";
import { test } from "node:test";
import { bool, email, EnvError, json, loadEnv, num, port, str, url } from "../dist/index.js";

test("coerces each variable to its declared type", () => {
  const env = loadEnv(
    {
      NAME: str(),
      PORT: port(),
      WORKERS: num(),
      DEBUG: bool(),
      ORIGIN: url(),
      ADMIN: email(),
      FLAGS: json(),
    },
    {
      NAME: "toki",
      PORT: "8080",
      WORKERS: "4",
      DEBUG: "true",
      ORIGIN: "https://toki.dev/app",
      ADMIN: "a@b.io",
      FLAGS: '{"beta":true}',
    },
  );
  assert.deepEqual(env, {
    NAME: "toki",
    PORT: 8080,
    WORKERS: 4,
    DEBUG: true,
    ORIGIN: "https://toki.dev/app",
    ADMIN: "a@b.io",
    FLAGS: { beta: true },
  });
});

test("applies defaults for unset or empty variables", () => {
  const env = loadEnv(
    { HOST: str({ default: "0.0.0.0" }), PORT: port({ default: 3000 }) },
    { PORT: "" }, // empty counts as absent
  );
  assert.equal(env.HOST, "0.0.0.0");
  assert.equal(env.PORT, 3000);
});

test("a default of undefined makes a variable optional", () => {
  const env = loadEnv({ SENTRY_DSN: str({ default: undefined }) }, {});
  assert.equal(env.SENTRY_DSN, undefined);
});

test("reports every problem at once, not just the first", () => {
  let err: EnvError | undefined;
  try {
    loadEnv({ A: str(), B: port(), C: num() }, { B: "70000", C: "abc" });
  } catch (e) {
    err = e as EnvError;
  }
  assert.ok(err instanceof EnvError);
  assert.equal(err.problems.length, 3);
  assert.match(err.message, /A is required/);
  assert.match(err.message, /B .*port/);
  assert.match(err.message, /C .*number/);
});

test("enforces choices", () => {
  assert.equal(
    loadEnv({ NODE_ENV: str({ choices: ["dev", "prod"] }) }, { NODE_ENV: "prod" }).NODE_ENV,
    "prod",
  );
  assert.throws(
    () => loadEnv({ NODE_ENV: str({ choices: ["dev", "prod"] }) }, { NODE_ENV: "staging" }),
    /must be one of dev, prod/,
  );
});

test("bool accepts the common truthy/falsy spellings", () => {
  for (const v of ["true", "1", "yes", "on", "TRUE"]) {
    assert.equal(loadEnv({ X: bool() }, { X: v }).X, true, v);
  }
  for (const v of ["false", "0", "no", "off"]) {
    assert.equal(loadEnv({ X: bool() }, { X: v }).X, false, v);
  }
  assert.throws(() => loadEnv({ X: bool() }, { X: "maybe" }), /boolean/);
});

test("port rejects non-integers and out-of-range values", () => {
  assert.throws(() => loadEnv({ P: port() }, { P: "0" }), /port/);
  assert.throws(() => loadEnv({ P: port() }, { P: "65536" }), /port/);
  assert.throws(() => loadEnv({ P: port() }, { P: "80.5" }), /port/);
});

test("url and email reject malformed values", () => {
  assert.throws(() => loadEnv({ U: url() }, { U: "not a url" }), /url/i);
  assert.throws(() => loadEnv({ E: email() }, { E: "nope" }), /email/);
});

test("json surfaces a clean error on malformed input", () => {
  assert.throws(() => loadEnv({ J: json() }, { J: "{bad" }), /valid JSON/);
});

test("the returned config is frozen", () => {
  const env = loadEnv({ NAME: str() }, { NAME: "x" });
  assert.throws(() => {
    (env as { NAME: string }).NAME = "y";
  }, TypeError);
});

test("descriptions appear in the error report", () => {
  assert.throws(
    () => loadEnv({ DB_URL: str({ desc: "Postgres connection string" }) }, {}),
    /DB_URL \(Postgres connection string\) is required/,
  );
});

test("whitespace-only values are treated as missing, not coerced", () => {
  assert.throws(() => loadEnv({ WORKERS: num() }, { WORKERS: " " }), /required/);
  assert.equal(loadEnv({ WORKERS: num({ default: 2 }) }, { WORKERS: "\t" }).WORKERS, 2);
});

test("num and port reject hex/binary/octal notation", () => {
  assert.throws(() => loadEnv({ N: num() }, { N: "0x1A" }), /number/);
  assert.throws(() => loadEnv({ N: num() }, { N: "0b101" }), /number/);
  assert.throws(() => loadEnv({ P: port() }, { P: "0x50" }), /port/);
});

test("a default outside its own choices is reported", () => {
  assert.throws(
    () => loadEnv({ MODE: str({ choices: ["a", "b"], default: "c" }) }, {}),
    /default must be one of a, b/,
  );
});
