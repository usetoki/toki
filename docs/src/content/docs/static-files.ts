import type { DocPage } from "../../types";

export const staticFilesPage: DocPage = {
  slug: "static-files",
  title: "Static files",
  description: "Serve a directory with MIME, ETag, HEAD, and pre-computed gzip/brotli.",
  blocks: [
    {
      kind: "paragraph",
      text: "`app.static(urlPrefix, dir, options?)` serves a directory. Files are read once at `listen` and served natively: a hash lookup, an `Accept-Encoding` choice, and a corked write — no per-request I/O and no JavaScript on the hot path.",
    },
    {
      kind: "code",
      snippet: {
        filename: "static.ts",
        language: "ts",
        code: `app.static("/assets", "./public");

// GET /assets/app.css ->
//   Content-Type: text/css
//   ETag: "..."  (304 on a matching If-None-Match)
//   Content-Encoding: gzip | br  (when Accept-Encoding allows)`,
      },
    },
    { kind: "heading", id: "what-you-get", text: "What you get" },
    {
      kind: "list",
      items: [
        "Correct MIME types from a native lookup table.",
        "`ETag` and `304 Not Modified` on a matching `If-None-Match`.",
        "`HEAD` support (headers and `Content-Length`, no body).",
        "Pre-computed gzip and brotli variants for compressible files, negotiated per `Accept-Encoding` with `Vary: Accept-Encoding`.",
        "Traversal-safe — only registered URLs exist, so `../` cannot escape the directory.",
      ],
    },
    { kind: "heading", id: "options", text: "Options" },
    {
      kind: "table",
      headers: ["Option", "Default", "Description"],
      rows: [
        ["`compress`", "`true`", "Pre-compute gzip/brotli for compressible files."],
        ["`compressMinBytes`", "`1024`", "Skip compression below this size."],
        ["`gzipLevel`", "`9`", "gzip level (computed once at startup)."],
        ["`brotliQuality`", "`11`", "brotli quality (computed once at startup)."],
        ["`cacheControl`", "—", "`Cache-Control` header for served files."],
      ],
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Because variants are built at startup, compression costs nothing per request — the bytes are already on disk in memory.",
    },
  ],
};
