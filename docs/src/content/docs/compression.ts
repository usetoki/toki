import type { DocPage } from "../../types";

export const compressionPage: DocPage = {
  slug: "compression",
  title: "Compression",
  description: "Dynamic gzip and brotli for responses, negotiated per Accept-Encoding.",
  blocks: [
    {
      kind: "paragraph",
      text: "`compression()` is an `onSend` hook that compresses string response bodies. It negotiates `br` over `gzip` from the request's `Accept-Encoding`, sets `Content-Encoding` and `Vary`, and runs `zlib` off the event loop.",
    },
    {
      kind: "code",
      snippet: {
        filename: "compress.ts",
        language: "ts",
        code: `import { compression } from "@usetoki/toki";

app.addHook("onSend", compression());`,
      },
    },
    { kind: "heading", id: "options", text: "Options" },
    {
      kind: "table",
      headers: ["Option", "Default", "Description"],
      rows: [
        ["`threshold`", "`1024`", "Minimum body size (bytes) to compress."],
        ["`gzipLevel`", "`6`", "gzip level (0–9)."],
        ["`brotliQuality`", "`5`", "brotli quality (0–11)."],
      ],
    },
    {
      kind: "code",
      snippet: {
        filename: "tuned.ts",
        language: "ts",
        code: `app.addHook("onSend", compression({ threshold: 2048, brotliQuality: 6 }));`,
      },
    },
    { kind: "heading", id: "notes", text: "What is and isn't compressed" },
    {
      kind: "list",
      items: [
        "Only string bodies above the threshold with a compressible content type are compressed.",
        "Already-binary responses (`reply.bytes`) are left as-is.",
        "Static files use pre-computed variants instead — see [Static files](/docs/static-files).",
      ],
    },
  ],
};
