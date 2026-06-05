// run: node examples/plugins.ts
import assert from "node:assert/strict";
import { createApp, TokiRequest, type TokiInstance, type PluginOptions } from "../dist/index.js";

const scopedOf = (req: TokiRequest) => (req as unknown as { scoped?: string }).scoped ?? null;

const app = createApp({ logger: false });

app.get("/ping", (req) => ({ pong: true, scoped: scopedOf(req) }));

function adminPlugin(admin: TokiInstance) {
  admin.get("/stats", () => ({ uptime: 1 }));
}

async function apiPlugin(api: TokiInstance, opts: PluginOptions) {
  await Promise.resolve();

  api.decorateRequest("scoped", opts.tag);
  api.addHook("onRequest", (req) => {
    req.setResponseHeader("x-api", "1");
  });

  api.get("/me", (req) => ({ scoped: scopedOf(req) }));
  api.register(adminPlugin, { prefix: "/admin" });
}

app.register(apiPlugin, { prefix: "/v1", tag: "alpha" });

// async plugin present, so ready() must settle before inject
await app.ready();

const root = await app.inject("/ping");
assert.equal(root.statusCode, 200);
assert.deepEqual(root.json(), { pong: true, scoped: null });
assert.equal(root.headers["x-api"], undefined);

const me = await app.inject("/v1/me");
assert.equal(me.statusCode, 200);
assert.deepEqual(me.json(), { scoped: "alpha" });
assert.equal(me.headers["x-api"], "1");

const stats = await app.inject("/v1/admin/stats");
assert.equal(stats.statusCode, 200);
assert.deepEqual(stats.json(), { uptime: 1 });
assert.equal(stats.headers["x-api"], "1");

console.log("plugins example OK");
process.exit(0);
