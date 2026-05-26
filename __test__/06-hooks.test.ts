import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { reply, type TokiResponse } from "../ts";
import { withServer } from "./helpers";

describe("hooks pipeline", () => {
  test("runs onRequest, middleware, preHandler, handler, then onResponse in order", async () => {
    const order: string[] = [];
    const server = await withServer((app) => {
      app.addHook("onRequest", () => {
        order.push("onRequest");
      });
      app.use(() => {
        order.push("middleware");
      });
      app.addHook("preHandler", () => {
        order.push("preHandler");
      });
      app.addHook("onResponse", () => {
        order.push("onResponse");
      });
      app.get("/", () => {
        order.push("handler");
        return reply.text("ok");
      });
    });
    try {
      const res = await fetch(`${server.base}/`);
      assert.equal(await res.text(), "ok");
      assert.deepEqual(order, ["onRequest", "middleware", "preHandler", "handler", "onResponse"]);
    } finally {
      server.close();
    }
  });

  test("an onRequest short-circuit skips middleware, preHandler, and the handler", async () => {
    const reached: string[] = [];
    const server = await withServer((app) => {
      app.addHook("onRequest", () => reply.json({ stop: "onRequest" }, { status: 418 }));
      app.use(() => {
        reached.push("middleware");
      });
      app.addHook("preHandler", () => {
        reached.push("preHandler");
      });
      app.get("/", () => {
        reached.push("handler");
        return reply.text("ok");
      });
    });
    try {
      const res = await fetch(`${server.base}/`);
      assert.equal(res.status, 418);
      assert.deepEqual(await res.json(), { stop: "onRequest" });
      assert.deepEqual(reached, []);
    } finally {
      server.close();
    }
  });

  test("a middleware short-circuit skips preHandler and the handler", async () => {
    const reached: string[] = [];
    const server = await withServer((app) => {
      app.use(() => reply.json({ stop: "middleware" }, { status: 403 }));
      app.addHook("preHandler", () => {
        reached.push("preHandler");
      });
      app.get("/", () => {
        reached.push("handler");
        return reply.text("ok");
      });
    });
    try {
      const res = await fetch(`${server.base}/`);
      assert.equal(res.status, 403);
      assert.deepEqual(reached, []);
    } finally {
      server.close();
    }
  });

  test("a preHandler short-circuit skips the handler", async () => {
    let handlerRan = false;
    const server = await withServer((app) => {
      app.addHook("preHandler", () => reply.json({ stop: "preHandler" }, { status: 401 }));
      app.get("/", () => {
        handlerRan = true;
        return reply.text("ok");
      });
    });
    try {
      const res = await fetch(`${server.base}/`);
      assert.equal(res.status, 401);
      assert.equal(handlerRan, false);
    } finally {
      server.close();
    }
  });

  test("onResponse still runs after a pre-stage short-circuit", async () => {
    let onResponseRan = false;
    const server = await withServer((app) => {
      app.addHook("preHandler", () => reply.text("short", { status: 400 }));
      app.addHook("onResponse", (_req, res) => {
        onResponseRan = true;
        res.headers.set("x-seen", "1");
      });
      app.get("/", () => reply.text("ok"));
    });
    try {
      const res = await fetch(`${server.base}/`);
      assert.equal(res.status, 400);
      assert.equal(res.headers.get("x-seen"), "1");
      assert.equal(onResponseRan, true);
    } finally {
      server.close();
    }
  });

  test("onResponse can replace the response entirely", async () => {
    const server = await withServer((app) => {
      app.addHook(
        "onResponse",
        (): TokiResponse => reply.json({ replaced: true }, { status: 202 }),
      );
      app.get("/", () => reply.text("original"));
    });
    try {
      const res = await fetch(`${server.base}/`);
      assert.equal(res.status, 202);
      assert.deepEqual(await res.json(), { replaced: true });
    } finally {
      server.close();
    }
  });

  test("staged headers are merged but the handler's own header wins", async () => {
    const server = await withServer((app) => {
      app.use((req) => {
        req.setResponseHeader("x-staged", "from-middleware");
        req.setResponseHeader("x-shared", "staged");
      });
      app.get("/", () => reply.text("ok", { headers: { "x-shared": "from-handler" } }));
    });
    try {
      const res = await fetch(`${server.base}/`);
      // A staged header the handler didn't set is applied; one it set is kept.
      assert.equal(res.headers.get("x-staged"), "from-middleware");
      assert.equal(res.headers.get("x-shared"), "from-handler");
    } finally {
      server.close();
    }
  });

  test("staged set-cookie accumulates alongside the handler's set-cookie", async () => {
    const server = await withServer((app) => {
      app.use((req) => {
        req.appendResponseHeader("set-cookie", "staged=1");
      });
      app.get("/", () => reply.cookie(reply.text("ok"), "handler", "2"));
    });
    try {
      const res = await fetch(`${server.base}/`);
      const cookies = res.headers.getSetCookie();
      assert.equal(cookies.length, 2);
      assert.ok(cookies.includes("staged=1"));
      assert.ok(cookies.includes("handler=2"));
      await res.body?.cancel();
    } finally {
      server.close();
    }
  });
});
