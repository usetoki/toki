// run: node examples/reply-builders.ts
import assert from "node:assert/strict";
import { createApp, reply } from "../dist/index.js";

const app = createApp({ logger: false });

app.get("/text", () => reply.text("hello"));
app.get("/html", () => reply.html("<h1>hi</h1>"));
app.get("/json", () => reply.json({ ok: true }, 201));
app.get("/empty", () => reply.empty());
app.get("/go", () => reply.redirect("/text"));
app.get("/bytes", () => reply.bytes(new Uint8Array([0x42, 0x43]), "application/octet-stream"));

app.get("/whoami", (req) =>
  reply.json({
    ip: req.ip,
    q: req.query.get("q"),
    agent: req.headers.get("x-agent"),
  }),
);

async function main() {
  const text = await app.inject("/text");
  assert.equal(text.statusCode, 200);
  assert.equal(text.body, "hello");
  assert.match(text.headers["content-type"] as string, /text\/plain/);

  const html = await app.inject("/html");
  assert.match(html.headers["content-type"] as string, /text\/html/);
  assert.equal(html.body, "<h1>hi</h1>");

  const json = await app.inject("/json");
  assert.equal(json.statusCode, 201);
  assert.deepEqual(json.json(), { ok: true });

  const empty = await app.inject("/empty");
  assert.equal(empty.statusCode, 204);
  assert.equal(empty.body, "");

  const go = await app.inject("/go");
  assert.equal(go.statusCode, 302);
  assert.equal(go.headers["location"], "/text");

  const bytes = await app.inject("/bytes");
  assert.equal(bytes.headers["content-type"], "application/octet-stream");
  assert.equal(Buffer.from(bytes.body, "binary").length, 2);

  const me = await app.inject({ url: "/whoami?q=zig", headers: { "x-agent": "toki" } });
  const body = me.json<{ ip: string; q: string; agent: string }>();
  assert.ok(body.ip.length > 0);
  assert.equal(body.q, "zig");
  assert.equal(body.agent, "toki");

  console.log("reply-builders example OK");
  process.exit(0);
}

main();
