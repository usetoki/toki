import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp, reply } from "../dist/index.js";

const root = mkdtempSync(join(tmpdir(), "toki-mime-"));

const MIME: Array<[string, string]> = [
  ["a.html", "text/html; charset=utf-8"],
  ["a.htm", "text/html; charset=utf-8"],
  ["a.css", "text/css; charset=utf-8"],
  ["a.js", "text/javascript; charset=utf-8"],
  ["a.mjs", "text/javascript; charset=utf-8"],
  ["a.cjs", "text/javascript; charset=utf-8"],
  ["a.json", "application/json; charset=utf-8"],
  ["a.jsonld", "application/ld+json; charset=utf-8"],
  ["a.webmanifest", "application/manifest+json; charset=utf-8"],
  ["a.map", "application/json; charset=utf-8"],
  ["a.xml", "application/xml; charset=utf-8"],
  ["a.txt", "text/plain; charset=utf-8"],
  ["a.md", "text/markdown; charset=utf-8"],
  ["a.csv", "text/csv; charset=utf-8"],
  ["a.ics", "text/calendar; charset=utf-8"],
  ["a.wasm", "application/wasm"],
  ["a.woff", "font/woff"],
  ["a.woff2", "font/woff2"],
  ["a.ttf", "font/ttf"],
  ["a.otf", "font/otf"],
  ["a.eot", "application/vnd.ms-fontobject"],
  ["a.svg", "image/svg+xml; charset=utf-8"],
  ["a.png", "image/png"],
  ["a.jpg", "image/jpeg"],
  ["a.jpeg", "image/jpeg"],
  ["a.gif", "image/gif"],
  ["a.webp", "image/webp"],
  ["a.avif", "image/avif"],
  ["a.ico", "image/x-icon"],
  ["a.bmp", "image/bmp"],
  ["a.tiff", "image/tiff"],
  ["a.mp4", "video/mp4"],
  ["a.webm", "video/webm"],
  ["a.ogg", "audio/ogg"],
  ["a.mp3", "audio/mpeg"],
  ["a.wav", "audio/wav"],
  ["a.flac", "audio/flac"],
  ["a.aac", "audio/aac"],
  ["a.pdf", "application/pdf"],
  ["a.zip", "application/zip"],
  ["a.gz", "application/gzip"],
  ["a.tar", "application/x-tar"],
  ["a.doc", "application/msword"],
  ["a.xls", "application/vnd.ms-excel"],
];

const MIME_DEFAULT = ["a.xyz", "a.weird", "a.bin", "a.exe", "noext"];

before(() => {
  mkdirSync(root, { recursive: true });
  for (const [name] of MIME) writeFileSync(join(root, name), "x");
  for (const name of MIME_DEFAULT) writeFileSync(join(root, name), "x");
  writeFileSync(join(root, "photo.PNG"), "x");
  writeFileSync(join(root, "data.JSON"), "x");
  writeFileSync(join(root, "shadowed.json"), '{"file":true}');
});

after(() => rmSync(root, { recursive: true, force: true }));

const app = createApp({ logger: false });

const STATUS: Array<[number, string]> = [
  [200, "OK"],
  [201, "Created"],
  [202, "Accepted"],
  [203, "Non-Authoritative Information"],
  [204, "No Content"],
  [205, "Reset Content"],
  [206, "Partial Content"],
  [207, "Multi-Status"],
  [208, "Already Reported"],
  [226, "IM Used"],
  [300, "Multiple Choices"],
  [301, "Moved Permanently"],
  [302, "Found"],
  [303, "See Other"],
  [304, "Not Modified"],
  [307, "Temporary Redirect"],
  [308, "Permanent Redirect"],
  [400, "Bad Request"],
  [401, "Unauthorized"],
  [402, "Payment Required"],
  [403, "Forbidden"],
  [404, "Not Found"],
  [405, "Method Not Allowed"],
  [406, "Not Acceptable"],
  [407, "Proxy Authentication Required"],
  [408, "Request Timeout"],
  [409, "Conflict"],
  [410, "Gone"],
  [411, "Length Required"],
  [412, "Precondition Failed"],
  [413, "Content Too Large"],
  [414, "URI Too Long"],
  [415, "Unsupported Media Type"],
  [416, "Range Not Satisfiable"],
  [417, "Expectation Failed"],
  [418, "I'm a Teapot"],
  [421, "Misdirected Request"],
  [422, "Unprocessable Content"],
  [423, "Locked"],
  [424, "Failed Dependency"],
  [425, "Too Early"],
  [426, "Upgrade Required"],
  [428, "Precondition Required"],
  [429, "Too Many Requests"],
  [431, "Request Header Fields Too Large"],
  [451, "Unavailable For Legal Reasons"],
  [500, "Internal Server Error"],
  [501, "Not Implemented"],
  [502, "Bad Gateway"],
  [503, "Service Unavailable"],
  [504, "Gateway Timeout"],
  [505, "HTTP Version Not Supported"],
  [506, "Variant Also Negotiates"],
  [507, "Insufficient Storage"],
  [508, "Loop Detected"],
  [510, "Not Extended"],
  [511, "Network Authentication Required"],
];

const STATUS_FALLBACK: Array<[number, string]> = [
  [299, "OK"],
  [469, "Client Error"],
  [499, "Client Error"],
  [599, "Server Error"],
  [799, "Server Error"],
];

for (const [code] of STATUS) {
  app.get(`/status/${code}`, () => reply.empty(code));
}
for (const [code] of STATUS_FALLBACK) {
  app.get(`/status/${code}`, () => reply.empty(code));
}

app.get("/text-451", () => reply.text("nope", 451));
app.get("/json-422", () => reply.json({ error: "bad" }, 422));
app.get("/html-410", () => reply.html("<h1>gone</h1>", 410));
app.get("/redirect", () => reply.redirect("/elsewhere", 308));

app.get("/ct/bytes-default", () => reply.bytes(new Uint8Array([1, 2, 3])));
app.get("/ct/bytes-png", () => reply.bytes(new Uint8Array([1, 2, 3]), "image/png"));
app.get("/ct/text", () => reply.text("hi"));
app.get("/ct/html", () => reply.html("<b>x</b>"));
app.get("/ct/json", () => reply.json({ a: 1 }));
app.get("/ct/object", () => ({ a: 1 }));
app.get("/ct/array", () => [1, 2, 3]);
app.get("/ct/string", () => "plain");
app.get("/ct/stream-csv", () => reply.stream(["a", "b"], { contentType: "text/csv" }));
app.get("/ct/stream-default", () => reply.stream(["a", "b"]));
app.get("/ct/set-header", (req) => {
  req.setResponseHeader("content-type", "application/xml");
  return reply.text("<x/>");
});

app.get("/files/shadowed.json", () => reply.text("ROUTE WINS"));
app.static("/files", root);

test("every well-known status maps to its canonical reason phrase", async () => {
  for (const [code, phrase] of STATUS) {
    const r = await app.inject({ url: `/status/${code}` });
    assert.equal(r.statusCode, code, `status ${code}`);
    assert.equal(r.statusMessage, phrase, `phrase for ${code}`);
  }
});

test("unknown codes fall back to a per-class generic phrase, never empty", async () => {
  for (const [code, phrase] of STATUS_FALLBACK) {
    const r = await app.inject({ url: `/status/${code}` });
    assert.equal(r.statusCode, code, `status ${code}`);
    assert.equal(r.statusMessage, phrase, `fallback phrase for ${code}`);
    assert.notEqual(r.statusMessage, "", `phrase for ${code} must not be empty`);
  }
});

test("body-bearing replies carry the right phrase and body together", async () => {
  const legal = await app.inject({ url: "/text-451" });
  assert.equal(legal.statusCode, 451);
  assert.equal(legal.statusMessage, "Unavailable For Legal Reasons");
  assert.equal(legal.body, "nope");
  assert.equal(legal.headers["content-type"], "text/plain; charset=utf-8");

  const unproc = await app.inject({ url: "/json-422" });
  assert.equal(unproc.statusCode, 422);
  assert.equal(unproc.statusMessage, "Unprocessable Content");
  assert.deepEqual(unproc.json(), { error: "bad" });

  const gone = await app.inject({ url: "/html-410" });
  assert.equal(gone.statusCode, 410);
  assert.equal(gone.statusMessage, "Gone");
  assert.equal(gone.headers["content-type"], "text/html; charset=utf-8");
});

test("a redirect emits its phrase, status, and Location header", async () => {
  const r = await app.inject({ url: "/redirect" });
  assert.equal(r.statusCode, 308);
  assert.equal(r.statusMessage, "Permanent Redirect");
  assert.equal(r.headers["location"], "/elsewhere");
});

test("204 and 304 send no body regardless of the requested status", async () => {
  for (const code of [204, 304]) {
    const r = await app.inject({ url: `/status/${code}` });
    assert.equal(r.statusCode, code);
    assert.equal(r.rawPayload.length, 0, `${code} must have an empty body`);
  }
});

test("a 404 from an unrouted path keeps the Not Found phrase", async () => {
  const r = await app.inject({ url: "/no/such/route" });
  assert.equal(r.statusCode, 404);
  assert.equal(r.statusMessage, "Not Found");
});

test("the engine resolves every known MIME type by extension", async () => {
  for (const [name, type] of MIME) {
    const r = await app.inject({ url: `/files/${name}` });
    assert.equal(r.statusCode, 200, name);
    assert.equal(r.headers["content-type"], type, name);
  }
});

test("unknown extensions and extension-less files default to octet-stream", async () => {
  for (const name of MIME_DEFAULT) {
    const r = await app.inject({ url: `/files/${name}` });
    assert.equal(r.statusCode, 200, name);
    assert.equal(r.headers["content-type"], "application/octet-stream", name);
  }
});

test("extension lookup is case-insensitive", async () => {
  const png = await app.inject({ url: "/files/photo.PNG" });
  assert.equal(png.headers["content-type"], "image/png");
  const json = await app.inject({ url: "/files/data.JSON" });
  assert.equal(json.headers["content-type"], "application/json; charset=utf-8");
});

test("reply helpers stamp the expected default content-type", async () => {
  const cases: Array<[string, string]> = [
    ["/ct/text", "text/plain; charset=utf-8"],
    ["/ct/string", "text/plain; charset=utf-8"],
    ["/ct/html", "text/html; charset=utf-8"],
    ["/ct/json", "application/json; charset=utf-8"],
    ["/ct/object", "application/json; charset=utf-8"],
    ["/ct/array", "application/json; charset=utf-8"],
    ["/ct/bytes-default", "application/octet-stream"],
    ["/ct/stream-default", "application/octet-stream"],
  ];
  for (const [url, type] of cases) {
    const r = await app.inject({ url });
    assert.equal(r.statusCode, 200, url);
    assert.equal(r.headers["content-type"], type, url);
  }
});

test("an explicit content-type argument overrides the default", async () => {
  const png = await app.inject({ url: "/ct/bytes-png" });
  assert.equal(png.headers["content-type"], "image/png");

  const csv = await app.inject({ url: "/ct/stream-csv" });
  assert.equal(csv.headers["content-type"], "text/csv");
  assert.equal(csv.body, "ab");
});

test("setResponseHeader('content-type') overrides the reply default", async () => {
  const r = await app.inject({ url: "/ct/set-header" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["content-type"], "application/xml");
  assert.equal(r.body, "<x/>");
});

test("an explicit route overrides the content-type a static file would resolve", async () => {
  const r = await app.inject({ url: "/files/shadowed.json" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body, "ROUTE WINS");
  assert.equal(r.headers["content-type"], "text/plain; charset=utf-8");
});
