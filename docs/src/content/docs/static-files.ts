import type { DocPage } from "../../types";

export const staticFilesPage: DocPage = {
  slug: "static-files",
  title: "Static files",
  description: "Serve a directory with MIME, ETag, HEAD, and pre-computed gzip/brotli.",
  blocks: [
    {
      kind: "paragraph",
      text: "`app.static(urlPrefix, dir, options?)` serves a directory. Files are read once at `listen` and held in memory, then served natively: a hash lookup, an `Accept-Encoding` choice, and a corked write. No per-request I/O, no JavaScript on the hot path. It is the fastest way to ship a built frontend, fonts, images, or any fixed asset set.",
    },
    {
      kind: "code",
      snippet: {
        filename: "static.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";

const app = createApp();

app.static("/assets", "./public");

// GET /assets/app.css ->
//   Content-Type: text/css; charset=utf-8
//   ETag: "..."                 (304 on a matching If-None-Match)
//   Content-Encoding: br | gzip  (when Accept-Encoding allows)
//   Vary: Accept-Encoding

app.listen(3000);`,
      },
    },
    {
      kind: "paragraph",
      text: "The URL prefix and the on-disk layout map directly: a file at `./public/css/app.css` is served at `/assets/css/app.css`. Nested directories are walked recursively at startup.",
    },
    { kind: "heading", id: "what-you-get", text: "What you get" },
    {
      kind: "list",
      items: [
        "Correct MIME types from a native lookup table, with `charset=utf-8` on text types.",
        "`ETag` and `304 Not Modified` on a matching `If-None-Match`, so unchanged assets cost a header round-trip and no body.",
        "`HEAD` support: headers and `Content-Length`, no body.",
        "Pre-computed gzip and brotli variants for compressible files, negotiated per `Accept-Encoding` with `Vary: Accept-Encoding`. Brotli wins when the client offers both.",
        "Traversal-safe by construction — only the URLs registered at startup exist, so a `../` in a request path matches nothing and cannot escape the directory.",
      ],
    },
    { kind: "heading", id: "options", text: "Options" },
    {
      kind: "table",
      headers: ["Option", "Default", "Description"],
      rows: [
        ["`cacheControl`", "`\"public, max-age=3600\"`", "`Cache-Control` header sent with every file in this mount."],
        ["`index`", "`\"index.html\"`", "File served for a directory URL. `false` disables it."],
        ["`maxFileBytes`", "`52428800` (50 MiB)", "Skip files larger than this — they are never loaded into memory."],
        ["`compress`", "`true`", "Pre-compute gzip/brotli variants for compressible files."],
        ["`compressMinBytes`", "`1024`", "Skip compression for files below this size."],
        ["`gzipLevel`", "`9`", "gzip level 0–9 (best by default — computed once at startup)."],
        ["`brotliQuality`", "`11`", "brotli quality 0–11 (best by default — computed once at startup)."],
      ],
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Because variants are built at startup, compression costs nothing per request; the compressed bytes are already in memory. That is why the defaults are the maximum levels (gzip 9, brotli 11): you pay the CPU once at boot, then serve the smallest payload forever.",
    },
    { kind: "heading", id: "index", text: "Directory index" },
    {
      kind: "paragraph",
      text: "When `index` is set, the index file also answers its directory URL — both with and without a trailing slash. With the default `\"index.html\"`, a request to `/assets`, `/assets/`, or `/assets/index.html` all return the same file. This is what you want for a single-page app or a docs site.",
    },
    {
      kind: "code",
      snippet: {
        filename: "spa.ts",
        language: "ts",
        code: `// serve a built SPA at the root; "/" returns dist/index.html
app.static("/", "./dist", {
  index: "index.html",
  cacheControl: "public, max-age=86400",
});`,
      },
    },
    { kind: "heading", id: "single-file", text: "Serving a single file" },
    {
      kind: "paragraph",
      text: "`app.static` mounts a directory; there is no single-file form. To serve one file at a fixed URL, point a tiny route at it. For a small fixed asset, read it once at startup and return the bytes with `reply.bytes`:",
    },
    {
      kind: "code",
      snippet: {
        filename: "favicon.ts",
        language: "ts",
        code: `import { readFileSync } from "node:fs";
import { reply } from "@usetoki/toki";

const favicon = readFileSync("./public/favicon.ico");

app.get("/favicon.ico", (req) => {
  req.setResponseHeader("Cache-Control", "public, max-age=604800");
  return reply.bytes(favicon, "image/x-icon");
});`,
      },
    },
    {
      kind: "callout",
      tone: "note",
      text: "For a file resolved per request, or one that needs `Range` requests and `206 Partial Content` (video, large downloads), use the [Range plugin](/docs/plugin-range) — it opens the file, honors the `Range` header, and streams the rest.",
    },
    { kind: "heading", id: "cache-control", text: "Cache-Control by mount" },
    {
      kind: "paragraph",
      text: "`cacheControl` is per mount, so split assets by how long they live. Hashed, content-addressed bundles can be cached forever; an `index.html` that points at them should revalidate often so a deploy lands immediately.",
    },
    {
      kind: "code",
      snippet: {
        filename: "cache.ts",
        language: "ts",
        code: `// fingerprinted bundles never change — cache hard
app.static("/static", "./dist/static", {
  cacheControl: "public, max-age=31536000, immutable",
});

// the entry HTML must pick up new bundles on the next visit
app.static("/", "./dist", {
  index: "index.html",
  cacheControl: "no-cache",
});`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "Files are snapshotted at `listen`. Editing a file on disk after the server starts has no effect until you restart; there is no watch. This is deliberate: it is what makes serving lock-free and I/O-free. In development, restart on change; in production, you deploy a fresh build anyway.",
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Variants that do not actually shrink the body are dropped, so already-compressed formats (`.png`, `.jpg`, `.woff2`, `.zip`) are served as-is with no wasted memory. Static compression is independent of the dynamic [compression](/docs/compression) hook, which never touches files served this way.",
    },
  ],
};
