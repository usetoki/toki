import type { DocPage } from "../../types";

export const rangePluginPage: DocPage = {
  slug: "plugin-range",
  title: "Range",
  description: "HTTP Range requests and 206 Partial Content for buffers or files.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-range` serves a buffer or a file honoring the request's `Range` header — what video players and download managers use to seek and resume. Static files already do this natively; this is for content you generate or read from a path in a handler.",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-range`,
      },
    },
    {
      kind: "code",
      snippet: {
        filename: "app.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";
import { sendRange } from "@usetoki/toki-range";

const app = createApp();

// a file on disk — only the requested slice is read, never the whole file
app.get("/video/:id", (req) => sendRange(req, \`/media/\${req.params.id}.mp4\`, { contentType: "video/mp4" }));

// or an in-memory buffer
app.get("/report.pdf", (req) => sendRange(req, renderPdf(), { contentType: "application/pdf" }));`,
      },
    },
    {
      kind: "list",
      items: [
        "No `Range` header → the full entity with `Accept-Ranges: bytes`.",
        "A satisfiable range → `206` with `Content-Range` and just those bytes.",
        "An unsatisfiable range → `416`. All three `bytes=` forms are supported: `start-end`, `start-`, `-suffix`.",
        "Files are streamed a slice at a time, so a range read never loads the whole file into memory.",
      ],
    },
  ],
};
