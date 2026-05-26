import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { reply } from "../ts";
import { withServer } from "./helpers";

describe("X-Powered-By and default headers", () => {
  test("defaults to X-Powered-By: Toki on a successful response", async () => {
    const server = await withServer((app) => {
      app.get("/", () => reply.text("ok"));
    });
    try {
      const res = await fetch(`${server.base}/`);
      assert.equal(res.headers.get("x-powered-by"), "Toki");
      await res.body?.cancel();
    } finally {
      server.close();
    }
  });

  test("defaults to X-Powered-By: Toki on a native 404", async () => {
    const server = await withServer((app) => {
      app.get("/", () => reply.text("ok"));
    });
    try {
      const res = await fetch(`${server.base}/missing`);
      assert.equal(res.status, 404);
      assert.equal(res.headers.get("x-powered-by"), "Toki");
      await res.body?.cancel();
    } finally {
      server.close();
    }
  });

  test("poweredBy overrides the banner value", async () => {
    const server = await withServer(
      (app) => {
        app.get("/", () => reply.text("ok"));
      },
      { poweredBy: "Acme/2" },
    );
    try {
      const res = await fetch(`${server.base}/`);
      assert.equal(res.headers.get("x-powered-by"), "Acme/2");
      await res.body?.cancel();
    } finally {
      server.close();
    }
  });

  test("poweredBy false disables the banner on success and on errors", async () => {
    const server = await withServer(
      (app) => {
        app.get("/", () => reply.text("ok"));
      },
      { poweredBy: false },
    );
    try {
      const ok = await fetch(`${server.base}/`);
      assert.equal(ok.headers.get("x-powered-by"), null);
      await ok.body?.cancel();

      const miss = await fetch(`${server.base}/missing`);
      assert.equal(miss.headers.get("x-powered-by"), null);
      await miss.body?.cancel();
    } finally {
      server.close();
    }
  });

  test("a defaultHeaders x-powered-by wins over the banner", async () => {
    const server = await withServer(
      (app) => {
        app.get("/", () => reply.text("ok"));
      },
      { defaultHeaders: { "x-powered-by": "Custom" }, poweredBy: "Ignored" },
    );
    try {
      const res = await fetch(`${server.base}/`);
      assert.equal(res.headers.get("x-powered-by"), "Custom");
      await res.body?.cancel();
    } finally {
      server.close();
    }
  });

  test("other defaultHeaders appear on success and on errors", async () => {
    const server = await withServer(
      (app) => {
        app.get("/", () => reply.text("ok"));
      },
      { defaultHeaders: { "x-frame-options": "DENY" } },
    );
    try {
      const ok = await fetch(`${server.base}/`);
      assert.equal(ok.headers.get("x-frame-options"), "DENY");
      // The banner still rides along.
      assert.equal(ok.headers.get("x-powered-by"), "Toki");
      await ok.body?.cancel();

      const miss = await fetch(`${server.base}/missing`);
      assert.equal(miss.status, 404);
      assert.equal(miss.headers.get("x-frame-options"), "DENY");
      assert.equal(miss.headers.get("x-powered-by"), "Toki");
      await miss.body?.cancel();
    } finally {
      server.close();
    }
  });

  test("a handler header of the same name wins over a default header", async () => {
    const server = await withServer(
      (app) => {
        app.get("/", () => reply.text("ok", { headers: { "x-frame-options": "SAMEORIGIN" } }));
      },
      { defaultHeaders: { "x-frame-options": "DENY" } },
    );
    try {
      const res = await fetch(`${server.base}/`);
      assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
      await res.body?.cancel();
    } finally {
      server.close();
    }
  });
});
