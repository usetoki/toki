import assert from "node:assert/strict";
import net from "node:net";
import { after, test } from "node:test";
import { createApp, reply } from "../ts/index.ts";
import type { RouteMethod } from "../ts/index.ts";
import { freePort } from "./helpers.ts";

const PORT = await freePort();

const app = createApp();

app.get("/", () => reply.text("hi"));
app.get("/json", (req) => reply.json({ x: req.query.get("x") }));
app.post("/echo", (req) => reply.text(req.text()));
app.get("/ua", (req) => reply.text(req.headers.get("user-agent") ?? ""));

app.get("/users", () => reply.text("list"));
app.get("/users/:id", (req) => reply.json({ id: req.params.id }));
app.get("/files/:a/:b", (req) => reply.json(req.params));
app.get("/Case", () => reply.text("upper"));

app.get("/multi", () => reply.text("g"));
app.post("/multi", () => reply.text("p"));
app.put("/multi", () => reply.text("u"));
app.patch("/multi", () => reply.text("pa"));
app.delete("/multi", () => reply.text("d"));

app.options("/opt", () => reply.text("explicit-options"));
app.head("/peek", () => reply.text("PEEKBODY"));
app.route("BREW" as RouteMethod, "/coffee", () => reply.text("brewing"));

const handle = app.listen(PORT, { host: "127.0.0.1" });
after(() => handle.close());

test("GET match returns body and text content-type", async () => {
  const r = await app.inject("/");
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(r.body, "hi");
});

test("query string is parsed into req.query", async () => {
  const r = await app.inject("/json?x=42");
  assert.deepEqual(r.json(), { x: "42" });
});

test("request headers are readable", async () => {
  const r = await app.inject({ url: "/ua", headers: { "user-agent": "toki-test" } });
  assert.equal(r.body, "toki-test");
});

test("POST body echoes back through the handler", async () => {
  const r = await app.inject({ method: "POST", url: "/echo", payload: "payload-123" });
  assert.equal(r.body, "payload-123");
});

test("unknown path is 404", async () => {
  const r = await app.inject("/nope");
  assert.equal(r.statusCode, 404);
  assert.equal(r.statusMessage, "Not Found");
});

test("wrong method is 405 with an Allow header", async () => {
  const r = await app.inject({ method: "DELETE", url: "/" });
  assert.equal(r.statusCode, 405);
  assert.equal(r.headers["allow"], "GET");
});

test("each verb on /multi routes to its own handler", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/multi" })).body, "g");
  assert.equal((await app.inject({ method: "POST", url: "/multi" })).body, "p");
  assert.equal((await app.inject({ method: "PUT", url: "/multi" })).body, "u");
  assert.equal((await app.inject({ method: "PATCH", url: "/multi" })).body, "pa");
  assert.equal((await app.inject({ method: "DELETE", url: "/multi" })).body, "d");
});

test("a custom method registered via app.route is dispatched", async () => {
  const r = await app.inject({ method: "BREW", url: "/coffee" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body, "brewing");
});

test("query string never affects which route matches", async () => {
  const r = await app.inject("/?a=1&a=2&b=");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body, "hi");
});

test("empty POST body is accepted and echoes empty", async () => {
  const r = await app.inject({ method: "POST", url: "/echo", payload: "" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body, "");
  assert.equal(r.headers["content-length"], "0");
});

test("static and dynamic siblings are distinct routes", async () => {
  assert.equal((await app.inject("/users")).body, "list");
  assert.deepEqual((await app.inject("/users/42")).json(), { id: "42" });
});

test("multiple path params bind by position", async () => {
  assert.deepEqual((await app.inject("/files/x/y")).json(), { a: "x", b: "y" });
});

test("percent-encoded param segments are decoded", async () => {
  assert.deepEqual((await app.inject("/users/a%20b")).json(), { id: "a b" });
});

test("path matching is case-sensitive", async () => {
  assert.equal((await app.inject("/Case")).statusCode, 200);
  assert.equal((await app.inject("/case")).statusCode, 404);
});

test("a trailing slash is significant, not collapsed", async () => {
  const r = await app.inject("/users/");
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { id: "" });
});

test("a leading double slash does not match a single-slash route", async () => {
  assert.equal((await app.inject("//users")).statusCode, 404);
});

test("an over-deep path does not match a shorter route", async () => {
  assert.equal((await app.inject("/users/1/extra")).statusCode, 404);
  assert.equal((await app.inject("/a/b/c")).statusCode, 404);
});

test("404 carries the plain-text body and content-type", async () => {
  const r = await app.inject("/definitely-missing");
  assert.equal(r.statusCode, 404);
  assert.equal(r.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(r.body, "Not Found");
});

test("405 lists every registered verb in the Allow header, sorted", async () => {
  const r = await app.inject({ method: "TRACE", url: "/multi" });
  assert.equal(r.statusCode, 405);
  assert.equal(r.statusMessage, "Method Not Allowed");
  assert.equal(r.headers["allow"], "DELETE, GET, PATCH, POST, PUT");
});

test("405 Allow reflects a single-verb route", async () => {
  const r = await app.inject({ method: "POST", url: "/" });
  assert.equal(r.statusCode, 405);
  assert.equal(r.headers["allow"], "GET");
});

test("405 Allow reflects a custom method token", async () => {
  const r = await app.inject({ method: "GET", url: "/coffee" });
  assert.equal(r.statusCode, 405);
  assert.equal(r.headers["allow"], "BREW");
});

test("a missing path with no route yields 404, not 405", async () => {
  const r = await app.inject({ method: "POST", url: "/no-such-thing" });
  assert.equal(r.statusCode, 404);
});

test("an explicit OPTIONS handler is invoked", async () => {
  const r = await app.inject({ method: "OPTIONS", url: "/opt" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body, "explicit-options");
});

test("OPTIONS on a GET-only route is 405 (no implicit OPTIONS)", async () => {
  const r = await app.inject({ method: "OPTIONS", url: "/" });
  assert.equal(r.statusCode, 405);
  assert.equal(r.headers["allow"], "GET");
});

test("HEAD on a GET-only route is auto-served from the GET handler", async () => {
  const r = await rawRequest(PORT, "HEAD /");
  const [head] = r.split("\r\n\r\n");
  assert.match(head!, /^HTTP\/1\.1 200 OK/);
  assert.match(head!, /\r\nContent-Length: 2\r\n/); // length of "hi"
  assert.equal(r.split("\r\n\r\n").slice(1).join("\r\n\r\n"), ""); // no body
});

test("an explicit HEAD handler replies with GET-shaped headers", async () => {
  const r = await rawRequest(PORT, "HEAD /peek");
  const [head] = r.split("\r\n\r\n");
  assert.ok(head, "response should contain a header block");
  assert.match(head, /^HTTP\/1\.1 200 OK/);
  assert.match(head, /\r\nContent-Type: text\/plain; charset=utf-8\r\n/);
  assert.match(head, /\r\nContent-Length: 8\r\n/);
});

test("a HEAD response carries no message body (RFC 9110 §9.3.2)", async () => {
  const r = await rawRequest(PORT, "HEAD /peek");
  const body = r.split("\r\n\r\n").slice(1).join("\r\n\r\n");
  assert.equal(body, "");
});

// raw socket so HEAD responses skip inject's body-rejecting HTTP client. latin1 keeps byte counts exact.
function rawRequest(port: number, requestLine: string): Promise<string> {
  const message = `${requestLine} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`;
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(message));
    const chunks: Buffer[] = [];
    sock.on("data", (d: Buffer) => chunks.push(d));
    sock.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
    sock.on("error", reject);
  });
}
