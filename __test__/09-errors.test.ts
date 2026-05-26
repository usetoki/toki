import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { reply, type TokiRequest } from "../ts";
import { withServer } from "./helpers";

class ValidationError extends Error {
  override readonly name = "ValidationError";
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
  }
}

describe("errors", () => {
  test("a default error handler turns a thrown error into a 500", async () => {
    const server = await withServer((app) => {
      app.get("/boom", () => {
        throw new Error("kaboom");
      });
    });
    try {
      const res = await fetch(`${server.base}/boom`);
      assert.equal(res.status, 500);
      assert.equal(await res.text(), "Internal Server Error");
    } finally {
      server.close();
    }
  });

  test("a custom onError maps a typed error to a 4xx", async () => {
    const server = await withServer((app) => {
      app.onError((error: unknown, req: TokiRequest | null) => {
        if (error instanceof ValidationError) {
          return reply.json(
            { error: error.message, id: req?.id ?? null },
            { status: error.status },
          );
        }
        return reply.json({ error: "internal" }, { status: 500 });
      });
      app.get("/bad", () => {
        throw new ValidationError("name required");
      });
      app.get("/boom", () => {
        throw new Error("kaboom");
      });
    });
    try {
      const bad = await fetch(`${server.base}/bad`);
      assert.equal(bad.status, 422);
      const body = (await bad.json()) as { error: string; id: string };
      assert.equal(body.error, "name required");
      assert.match(body.id, /^[0-9a-f]{32}$/);

      const boom = await fetch(`${server.base}/boom`);
      assert.equal(boom.status, 500);
      assert.deepEqual(await boom.json(), { error: "internal" });
    } finally {
      server.close();
    }
  });

  test("a trailing wildcard catch-all serves a custom 404", async () => {
    const server = await withServer((app) => {
      app.get("/known", () => reply.text("known"));
      // The native router prefers the more specific route; this only catches misses.
      app.get("/*", (req) => reply.json({ notFound: req.path }, { status: 404 }));
    });
    try {
      const known = await fetch(`${server.base}/known`);
      assert.equal(await known.text(), "known");

      const miss = await fetch(`${server.base}/anything/here`);
      assert.equal(miss.status, 404);
      assert.deepEqual(await miss.json(), { notFound: "/anything/here" });
    } finally {
      server.close();
    }
  });

  test("a path matching no route falls back to the native default 404", async () => {
    const server = await withServer((app) => {
      app.get("/known", () => reply.text("known"));
    });
    try {
      const res = await fetch(`${server.base}/unknown`);
      assert.equal(res.status, 404);
      assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
      assert.equal(await res.text(), "Not Found");
    } finally {
      server.close();
    }
  });

  test("HEAD on a throwing GET returns the error status with no body", async () => {
    // The auto-HEAD mirror runs the handler, which throws; the error response then
    // has its body dropped, so a HEAD error carries Content-Length 0 and no bytes.
    const server = await withServer((app) => {
      app.get("/boom", () => {
        throw new Error("kaboom");
      });
    });
    try {
      const res = await fetch(`${server.base}/boom`, { method: "HEAD" });
      assert.equal(res.status, 500);
      assert.equal(res.headers.get("content-length"), "0");
      assert.equal(await res.text(), "");
    } finally {
      server.close();
    }
  });

  test("an onError that itself throws falls back to a 500", async () => {
    const server = await withServer((app) => {
      app.onError(() => {
        throw new Error("handler exploded");
      });
      app.get("/boom", () => {
        throw new Error("kaboom");
      });
    });
    try {
      const res = await fetch(`${server.base}/boom`);
      assert.equal(res.status, 500);
      assert.equal(await res.text(), "Internal Server Error");
    } finally {
      server.close();
    }
  });
});
