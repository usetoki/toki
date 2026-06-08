import type { DocPage } from "../../types";

export const compressionPage: DocPage = {
  slug: "compression",
  title: "Compression",
  description: "Dynamic gzip and brotli for responses, negotiated per Accept-Encoding.",
  blocks: [
    {
      kind: "paragraph",
      text: "`compression()` is a response hook that compresses string response bodies. It reads the request's `Accept-Encoding`, picks `br` over `gzip`, runs `zlib` off the event loop (on the libuv thread pool), and replaces the body — setting `Content-Encoding` and `Vary: Accept-Encoding` for you. Register it once and every eligible response shrinks.",
    },
    {
      kind: "code",
      snippet: {
        filename: "compress.ts",
        language: "ts",
        code: `import { createApp, compression } from "@usetoki/toki";

const app = createApp();

app.addHook("onResponse", compression());

app.get("/article", () => longHtml); // sent br/gzip when the client allows

app.listen(3000);`,
      },
    },
    {
      kind: "callout",
      tone: "note",
      text: "`compression()` returns a `ResponseHook`, so it fits either response phase. `onResponse` runs first and is the usual choice; `onSend` runs last, right before the bytes go out. Pick one — registering on both would compress twice.",
    },
    { kind: "heading", id: "options", text: "Options" },
    {
      kind: "table",
      headers: ["Option", "Default", "Description"],
      rows: [
        ["`threshold`", "`1024`", "Minimum body size in bytes to compress. Smaller bodies are sent as-is — the overhead is not worth it."],
        ["`gzipLevel`", "`6`", "gzip level 0–9. Higher is smaller but slower."],
        ["`brotliQuality`", "`5`", "brotli quality 0–11. Higher is smaller but slower."],
      ],
    },
    {
      kind: "paragraph",
      text: "The defaults favor speed over ratio — sensible for bodies compressed fresh on every request. Raise the levels if your responses are large and CPU is cheap; raise the threshold if you serve many small JSON payloads.",
    },
    {
      kind: "code",
      snippet: {
        filename: "tuned.ts",
        language: "ts",
        code: `app.addHook("onResponse", compression({
  threshold: 2048,     // only bodies of 2 KiB or more
  brotliQuality: 6,    // a little smaller, a little slower
  gzipLevel: 7,
}));`,
      },
    },
    { kind: "heading", id: "when", text: "When it kicks in" },
    {
      kind: "paragraph",
      text: "Every condition below must hold, or the response passes through untouched:",
    },
    {
      kind: "list",
      items: [
        "The body is a `string` (built by `reply.text`, `reply.html`, `reply.json`, or a plain handler return). Already-binary responses from `reply.bytes` are left as-is.",
        "The body is at least `threshold` bytes.",
        "The content type is compressible — `text/*`, `application/json`, `application/javascript`, `application/xml`, `application/wasm`, any `+json` or `+xml` type, and `image/svg+xml`.",
        "The client offered `br` or `gzip` in `Accept-Encoding` (with a non-zero `q`).",
      ],
    },
    {
      kind: "callout",
      tone: "tip",
      text: "The negotiator honors quality values, so `Accept-Encoding: gzip, br;q=0` skips brotli and falls back to gzip — matching the native static-file negotiator exactly.",
    },
    { kind: "heading", id: "per-route", text: "Compressing one scope" },
    {
      kind: "paragraph",
      text: "A hook added with `app.addHook` is global. To compress only some routes, add the hook inside a [plugin](/docs/plugins) scope — `register` runs it against a child scope, so the hook applies to that plugin's routes and its children, and nowhere else.",
    },
    {
      kind: "code",
      snippet: {
        filename: "scoped.ts",
        language: "ts",
        code: `import { type TokiInstance } from "@usetoki/toki";

// compress the JSON API, leave the rest of the app alone
function api(app: TokiInstance) {
  app.addHook("onResponse", compression({ threshold: 512 }));
  app.get("/report", () => buildLargeReport()); // JSON, compressed
}

app.register(api, { prefix: "/api" }); // GET /api/report`,
      },
    },
    { kind: "heading", id: "exclude", text: "Excluding a type or route" },
    {
      kind: "paragraph",
      text: "The hook already skips non-compressible content types, so an `image/png` from `reply.bytes` is never touched. To opt a specific text response out, set its `Content-Type` to something outside the compressible set, or send pre-compressed bytes with `reply.bytes` and your own `Content-Encoding` header.",
    },
    {
      kind: "code",
      snippet: {
        filename: "exclude.ts",
        language: "ts",
        code: `import { gzipSync } from "node:zlib";
import { reply } from "@usetoki/toki";

// already gzipped at rest — ship it as bytes with the encoding set,
// and the compression hook leaves it alone (it only touches strings)
app.get("/feed.xml.gz", (req) => {
  req.setResponseHeader("Content-Encoding", "gzip");
  return reply.bytes(gzipSync(feedXml), "application/xml");
});`,
      },
    },
    { kind: "heading", id: "streams", text: "Streams and static files" },
    {
      kind: "list",
      items: [
        "Streaming responses (`reply.stream`) have no materialized body, so the hook never sees them. Compress inside the source if you need it — see [Streaming](/docs/streaming).",
        "Static files use pre-computed gzip/brotli variants built once at startup, not this hook — see [Static files](/docs/static-files). Serving an asset directory through `app.static` is always cheaper than compressing it per request.",
      ],
    },
    {
      kind: "callout",
      tone: "warning",
      text: "Compressing a response that reflects user input alongside a secret in the same body can leak the secret through its compressed size (the BREACH/CRIME class of attack). Do not compress responses that mix a per-request secret (a CSRF token, a session value) with attacker-controlled content.",
    },
  ],
};
