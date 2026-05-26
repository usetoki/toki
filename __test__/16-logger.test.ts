import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { reply, type Logger } from "../ts";
import { withServer } from "./helpers";

interface Recorded {
  readonly level: string;
  readonly fields: Record<string, unknown> | null;
  readonly message: string | undefined;
}

/** A {@link Logger} that records every call into a shared sink; `child` merges bindings. */
function recordingLogger(sink: Recorded[], bindings: Record<string, unknown> = {}): Logger {
  const make =
    (level: string) =>
    (first: string | Record<string, unknown>, second?: string): void => {
      if (typeof first === "string") {
        sink.push({ level, fields: bindings, message: first });
      } else {
        sink.push({ level, fields: { ...bindings, ...first }, message: second });
      }
    };
  return {
    fatal: make("fatal"),
    error: make("error"),
    warn: make("warn"),
    info: make("info"),
    debug: make("debug"),
    trace: make("trace"),
    child: (childBindings) => recordingLogger(sink, { ...bindings, ...childBindings }),
  };
}

describe("logger", () => {
  test("a custom logger receives a child bound to the request and handler calls", async () => {
    const sink: Recorded[] = [];
    const server = await withServer(
      (app) => {
        app.get("/", (req) => {
          req.log.info({ at: "handler" }, "handling");
          return reply.text("ok");
        });
      },
      { logger: recordingLogger(sink) },
    );
    try {
      const res = await fetch(`${server.base}/`);
      assert.equal(await res.text(), "ok");
      const entry = sink.find((e) => e.message === "handling");
      assert.ok(entry, "handler log entry recorded");
      // The dispatcher's child bindings ride along with the handler's fields.
      assert.equal(entry.fields?.["at"], "handler");
      assert.match(String(entry.fields?.["reqId"]), /^[0-9a-f]{32}$/);
      assert.equal(entry.fields?.["method"], "GET");
      assert.equal(entry.fields?.["path"], "/");
    } finally {
      server.close();
    }
  });

  test("logger: false is silent and never throws", async () => {
    const server = await withServer(
      (app) => {
        app.get("/", (req) => {
          // A silent logger must accept calls without error.
          req.log.info({ x: 1 }, "ignored");
          req.log.error("also ignored");
          return reply.text("ok");
        });
      },
      { logger: false },
    );
    try {
      const res = await fetch(`${server.base}/`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "ok");
    } finally {
      server.close();
    }
  });
});
