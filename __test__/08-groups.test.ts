import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { reply, type TokiRequest, type TokiResponse } from "../ts";
import { withServer, type RunningServer } from "./helpers";

describe("route groups", () => {
  let server: RunningServer;
  const order: string[] = [];

  before(async () => {
    server = await withServer((app) => {
      app.addHook("onRequest", () => {
        order.push("root");
      });

      app.group("/api", (api) => {
        api.addHook("preHandler", () => {
          order.push("api-group");
        });
        api.get("/ping", () => reply.json({ scope: "api" }));

        api.group("/v2", (v2) => {
          v2.get("/ping", () => reply.json({ scope: "api/v2" }));

          v2.group("/admin", (admin) => {
            admin.addHook("preHandler", (req: TokiRequest): TokiResponse | void => {
              if (req.headers.get("authorization") !== "Bearer key") {
                return reply.json({ error: "unauthorized" }, { status: 401 });
              }
            });
            admin.get("/stats", () => reply.json({ scope: "api/v2/admin" }));
          });
        });
      });

      // A sibling route at the root: group hooks must not leak here.
      app.get("/root-only", () => reply.json({ scope: "root" }));
    });
  });

  after(() => server.close());

  test("a group prefixes its routes", async () => {
    const res = await fetch(`${server.base}/api/ping`);
    assert.deepEqual(await res.json(), { scope: "api" });
  });

  test("a nested group composes prefixes", async () => {
    const res = await fetch(`${server.base}/api/v2/ping`);
    assert.deepEqual(await res.json(), { scope: "api/v2" });
  });

  test("a deeply nested group composes all prefixes", async () => {
    const res = await fetch(`${server.base}/api/v2/admin/stats`, {
      headers: { authorization: "Bearer key" },
    });
    assert.deepEqual(await res.json(), { scope: "api/v2/admin" });
  });

  test("a group-scoped hook guards only its own routes", async () => {
    const res = await fetch(`${server.base}/api/v2/admin/stats`);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });

  test("a group-scoped hook does not run for a sibling root route", async () => {
    order.length = 0;
    const res = await fetch(`${server.base}/root-only`);
    assert.deepEqual(await res.json(), { scope: "root" });
    // Only the root onRequest fired; the api group's preHandler did not.
    assert.deepEqual(order, ["root"]);
  });

  test("the admin guard does not run for a non-admin route in the same parent group", async () => {
    // /api/v2/ping is inside /api/v2 but outside /api/v2/admin, so no auth is required.
    const res = await fetch(`${server.base}/api/v2/ping`);
    assert.equal(res.status, 200);
  });

  test("root hooks run before group hooks at the same stage", async () => {
    order.length = 0;
    await fetch(`${server.base}/api/ping`).then((r) => r.body?.cancel());
    // root onRequest, then the api group's preHandler.
    assert.deepEqual(order, ["root", "api-group"]);
  });
});
