import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, reply } from "../dist/index.js";

const app = createApp({ logger: false });

app.post("/form", (req) => reply.json(req.form?.fields ?? null));

app.post("/upload", (req) => {
  const form = req.form;
  if (!form) return reply.empty(415);
  return reply.json({
    fields: form.fields,
    files: form.files.map((f) => ({
      name: f.name,
      filename: f.filename,
      type: f.contentType,
      size: f.data.length,
      text: new TextDecoder().decode(f.data),
    })),
  });
});

app.post("/raw", (req) => reply.text(req.form === null ? "not-a-form" : "form"));

app.post("/parsed", async (req) => {
  const parsed = await req.parseBody();
  if (parsed === undefined) return reply.text("undefined");
  if (parsed === null) return reply.text("null");
  if (typeof parsed === "string") return reply.json({ kind: "string", value: parsed });
  if (parsed instanceof Uint8Array) return reply.json({ kind: "bytes", size: parsed.length });
  return reply.json({ kind: "object", value: parsed });
});

type Part =
  | { name: string; value: string }
  | { name: string; filename: string; contentType?: string; data: string | Uint8Array };

function multipart(boundary: string, parts: Part[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if ("filename" in part) {
      head += `; filename="${part.filename}"\r\n`;
      head += `Content-Type: ${part.contentType ?? "application/octet-stream"}\r\n\r\n`;
      chunks.push(enc.encode(head));
      chunks.push(typeof part.data === "string" ? enc.encode(part.data) : part.data);
    } else {
      head += `\r\n\r\n${part.value}`;
      chunks.push(enc.encode(head));
    }
    chunks.push(enc.encode("\r\n"));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const ctMultipart = (b: string) => `multipart/form-data; boundary=${b}`;
const ctUrlenc = "application/x-www-form-urlencoded";

// fresh connection so concurrent large bodies never share a reused socket
const noKeepAlive = { connection: "close" };

test("urlencoded body parses into fields", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/form",
    headers: { "content-type": ctUrlenc },
    payload: "a=1&b=hello+world",
  });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { a: "1", b: "hello world" });
});

test("urlencoded decodes percent-escapes and the plus sign", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/form",
    headers: { "content-type": ctUrlenc },
    payload: "email=a%40b.com&q=c%2B%2B&tag=a+b",
  });
  assert.deepEqual(r.json(), { email: "a@b.com", q: "c++", tag: "a b" });
});

test("urlencoded keeps the last value for a repeated key", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/form",
    headers: { "content-type": ctUrlenc },
    payload: "x=1&x=2&x=3",
  });
  assert.deepEqual(r.json(), { x: "3" });
});

test("urlencoded with a bare key yields an empty-string value", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/form",
    headers: { "content-type": ctUrlenc },
    payload: "flag&name=z",
  });
  assert.deepEqual(r.json(), { flag: "", name: "z" });
});

test("urlencoded with charset suffix on the content-type still parses", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/form",
    headers: { "content-type": `${ctUrlenc}; charset=utf-8` },
    payload: "a=1",
  });
  assert.deepEqual(r.json(), { a: "1" });
});

test("urlencoded content-type matching is case-insensitive", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/form",
    headers: { "content-type": "APPLICATION/X-WWW-FORM-URLENCODED" },
    payload: "a=1",
  });
  assert.deepEqual(r.json(), { a: "1" });
});

test("multipart fields and a small file", async () => {
  const b = "----tokitest1";
  const payload = multipart(b, [
    { name: "name", value: "alice" },
    { name: "avatar", filename: "a.png", contentType: "image/png", data: "PNGDATA" },
  ]);
  const r = await app.inject({
    method: "POST",
    url: "/upload",
    headers: { "content-type": ctMultipart(b) },
    payload,
  });
  const out = r.json<{ fields: Record<string, string>; files: any[] }>();
  assert.deepEqual(out.fields, { name: "alice" });
  assert.equal(out.files.length, 1);
  assert.deepEqual(out.files[0], {
    name: "avatar",
    filename: "a.png",
    type: "image/png",
    size: 7,
    text: "PNGDATA",
  });
});

test("multipart with multiple fields and multiple files", async () => {
  const b = "----tokitest2";
  const payload = multipart(b, [
    { name: "title", value: "report" },
    { name: "author", value: "bob" },
    { name: "f1", filename: "one.txt", contentType: "text/plain", data: "first" },
    { name: "f2", filename: "two.bin", contentType: "application/octet-stream", data: "second" },
  ]);
  const r = await app.inject({
    method: "POST",
    url: "/upload",
    headers: { "content-type": ctMultipart(b) },
    payload,
  });
  const out = r.json<{ fields: Record<string, string>; files: any[] }>();
  assert.deepEqual(out.fields, { title: "report", author: "bob" });
  assert.equal(out.files.length, 2);
  assert.deepEqual(
    out.files.map((f) => f.filename),
    ["one.txt", "two.bin"],
  );
  assert.deepEqual(
    out.files.map((f) => f.text),
    ["first", "second"],
  );
  assert.equal(out.files[1].type, "application/octet-stream");
});

test("a large multipart upload survives the overflow buffer intact", async () => {
  const big = "Z".repeat(200 * 1024);
  const b = "----tokitestbig";
  const payload = multipart(b, [
    { name: "doc", filename: "big.txt", contentType: "text/plain", data: big },
  ]);
  const r = await app.inject({
    method: "POST",
    url: "/upload",
    headers: { "content-type": ctMultipart(b), ...noKeepAlive },
    payload,
  });
  const out = r.json<{ files: any[] }>();
  assert.equal(out.files[0].size, big.length);
  assert.equal(out.files[0].text, big);
});

test("multipart preserves binary file bytes exactly", async () => {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bytes[i] = i;
  const b = "----tokitestbin";
  const payload = multipart(b, [
    { name: "blob", filename: "raw.bin", contentType: "application/octet-stream", data: bytes },
  ]);
  const r = await app.inject({
    method: "POST",
    url: "/upload",
    headers: { "content-type": ctMultipart(b), ...noKeepAlive },
    payload,
  });
  const out = r.json<{ files: any[] }>();
  assert.equal(out.files[0].size, 256);
  const decoded = new TextDecoder().decode(bytes);
  assert.equal(out.files[0].text, decoded);
});

test("multipart file with no Content-Type defaults to octet-stream", async () => {
  const b = "----tokitestdefault";
  const enc = new TextEncoder();
  const head = `--${b}\r\nContent-Disposition: form-data; name="f"; filename="x.dat"\r\n\r\n`;
  const body = `${head}hello\r\n--${b}--\r\n`;
  const r = await app.inject({
    method: "POST",
    url: "/upload",
    headers: { "content-type": ctMultipart(b) },
    payload: enc.encode(body),
  });
  const out = r.json<{ files: any[] }>();
  assert.equal(out.files[0].type, "application/octet-stream");
  assert.equal(out.files[0].text, "hello");
});

test("multipart quoted boundary in the content-type is honored", async () => {
  const b = "boundary-with-spaces and stuff";
  const payload = multipart(b, [{ name: "k", value: "v" }]);
  const r = await app.inject({
    method: "POST",
    url: "/upload",
    headers: { "content-type": `multipart/form-data; boundary="${b}"` },
    payload,
  });
  const out = r.json<{ fields: Record<string, string>; files: any[] }>();
  assert.deepEqual(out.fields, { k: "v" });
  assert.equal(out.files.length, 0);
});

test("multipart field value may contain CRLF and the boundary text", async () => {
  const b = "----tokitestembed";
  const tricky = "line1\r\nline2 with --not-the-boundary inside";
  const payload = multipart(b, [{ name: "msg", value: tricky }]);
  const r = await app.inject({
    method: "POST",
    url: "/upload",
    headers: { "content-type": ctMultipart(b) },
    payload,
  });
  const out = r.json<{ fields: Record<string, string> }>();
  assert.equal(out.fields.msg, tricky);
});

test("multipart with an empty field value parses to empty string", async () => {
  const b = "----tokitestempty";
  const payload = multipart(b, [
    { name: "blank", value: "" },
    { name: "set", value: "y" },
  ]);
  const r = await app.inject({
    method: "POST",
    url: "/upload",
    headers: { "content-type": ctMultipart(b) },
    payload,
  });
  const out = r.json<{ fields: Record<string, string> }>();
  assert.deepEqual(out.fields, { blank: "", set: "y" });
});

test("multipart with no boundary param yields empty fields and files", async () => {
  const b = "----tokitestnob";
  const payload = multipart(b, [{ name: "k", value: "v" }]);
  const r = await app.inject({
    method: "POST",
    url: "/upload",
    headers: { "content-type": "multipart/form-data" },
    payload,
  });
  const out = r.json<{ fields: Record<string, string>; files: any[] }>();
  assert.deepEqual(out.fields, {});
  assert.deepEqual(out.files, []);
});

test("multipart with no entries (boundary present, nothing between) is empty", async () => {
  const b = "----tokitestnoparts";
  const r = await app.inject({
    method: "POST",
    url: "/upload",
    headers: { "content-type": ctMultipart(b) },
    payload: new TextEncoder().encode(`--${b}--\r\n`),
  });
  const out = r.json<{ fields: Record<string, string>; files: any[] }>();
  assert.deepEqual(out.fields, {});
  assert.deepEqual(out.files, []);
});

test("a JSON body is not a form (req.form is null)", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/raw",
    headers: { "content-type": "application/json" },
    payload: { x: 1 },
  });
  assert.equal(r.body, "not-a-form");
});

test("a text/plain body is not a form (req.form is null)", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/raw",
    headers: { "content-type": "text/plain" },
    payload: "just text",
  });
  assert.equal(r.body, "not-a-form");
});

test("a missing content-type is not a form (req.form is null)", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/raw",
    headers: { "content-type": "" },
    payload: "a=1&b=2",
  });
  assert.equal(r.body, "not-a-form");
});

test("/upload rejects a non-form body with 415", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/upload",
    headers: { "content-type": "application/json" },
    payload: { x: 1 },
  });
  assert.equal(r.statusCode, 415);
});

test("empty body with urlencoded content-type yields null form", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/raw",
    headers: { "content-type": ctUrlenc },
  });
  assert.equal(r.body, "not-a-form");
});

test("empty body on /form returns null fields", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/form",
    headers: { "content-type": ctUrlenc },
  });
  assert.equal(r.body, "null");
});

test("a zero-length urlencoded body parses to empty fields", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/form",
    headers: { "content-type": ctUrlenc, "content-length": "0" },
    payload: "",
  });
  assert.equal(r.body, "null");
});

test("parseBody returns the form shape for a urlencoded body", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/parsed",
    headers: { "content-type": ctUrlenc },
    payload: "a=1&b=2",
  });
  assert.deepEqual(r.json(), {
    kind: "object",
    value: { fields: { a: "1", b: "2" }, files: [] },
  });
});

test("parseBody returns the form shape for a multipart body", async () => {
  const b = "----tokitestparse";
  const payload = multipart(b, [{ name: "k", value: "v" }]);
  const r = await app.inject({
    method: "POST",
    url: "/parsed",
    headers: { "content-type": ctMultipart(b) },
    payload,
  });
  assert.deepEqual(r.json(), {
    kind: "object",
    value: { fields: { k: "v" }, files: [] },
  });
});

test("parseBody parses JSON bodies", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/parsed",
    headers: { "content-type": "application/json" },
    payload: { hello: "world" },
  });
  assert.deepEqual(r.json(), { kind: "object", value: { hello: "world" } });
});

test("parseBody returns a string for text/* bodies", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/parsed",
    headers: { "content-type": "text/plain" },
    payload: "raw text",
  });
  assert.deepEqual(r.json(), { kind: "string", value: "raw text" });
});

test("parseBody falls back to raw bytes for unknown content-type", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/parsed",
    headers: { "content-type": "application/x-thing" },
    payload: new TextEncoder().encode("abcde"),
  });
  assert.deepEqual(r.json(), { kind: "bytes", size: 5 });
});

test("parseBody returns undefined for an empty body", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/parsed",
    headers: { "content-type": ctUrlenc },
  });
  assert.equal(r.body, "undefined");
});

test("req.form is cached (same reference across reads)", async () => {
  const a = createApp({ logger: false });
  a.post("/cache", (req) => reply.text(String(req.form === req.form)));
  const r = await a.inject({
    method: "POST",
    url: "/cache",
    headers: { "content-type": ctUrlenc },
    payload: "a=1",
  });
  assert.equal(r.body, "true");
});
