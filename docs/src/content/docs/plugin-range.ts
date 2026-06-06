import type { DocPage } from "../../types";

export const rangePluginPage: DocPage = {
  slug: "plugin-range",
  title: "Range",
  description: "HTTP Range requests and 206 Partial Content for buffers or files.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-range` serves a buffer or a file while honoring the request's `Range` header — the mechanism video players use to seek and download managers use to resume. Static files on disk already do this natively; reach for `sendRange` when the bytes come from somewhere a handler controls: a generated PDF, an object you fetched from storage, a file at a path you resolved at request time.",
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
      kind: "heading",
      id: "quick-start",
      text: "Quick start",
    },
    {
      kind: "paragraph",
      text: "`sendRange(req, source, options)` takes the request, a `Uint8Array` or a file path, and an optional content type. It returns a `HandlerResult`, so return it straight from the handler.",
    },
    {
      kind: "code",
      snippet: {
        filename: "app.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";
import { sendRange } from "@usetoki/toki-range";

const app = createApp();

// an in-memory buffer
app.get("/report.pdf", (req) =>
  sendRange(req, renderPdf(), { contentType: "application/pdf" }),
);`,
      },
    },
    {
      kind: "heading",
      id: "streaming-files",
      text: "Serving a file",
    },
    {
      kind: "paragraph",
      text: "Pass a path and `sendRange` opens the file once before committing any header — so a missing file becomes a clean error, never a truncated `206`. A range read pulls exactly the requested bytes from the open fd; a full request streams the file instead of buffering it. Either way the fd closes when the response ends.",
    },
    {
      kind: "code",
      snippet: {
        filename: "video.ts",
        language: "ts",
        code: `app.get("/video/:id", (req) =>
  sendRange(req, \`/media/\${req.params.id}.mp4\`, { contentType: "video/mp4" }),
);
// a player's  Range: bytes=1048576-  ->  206 with just that slice`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "Never interpolate a raw path param into the filesystem path — `req.params.id` could be `../../etc/passwd`. Validate or map the id to a known file first (an allowlist, a lookup, `path.basename`).",
    },
    {
      kind: "heading",
      id: "how-it-responds",
      text: "How it responds",
    },
    {
      kind: "table",
      headers: ["Request", "Response", "Headers"],
      rows: [
        ["No `Range` header", "`200` full entity", "`Accept-Ranges: bytes`"],
        [
          "Satisfiable range",
          "`206` with just those bytes",
          "`Content-Range: bytes start-end/size`, correct `Content-Length`",
        ],
        ["Unsatisfiable range", "`416`", "`Content-Range: bytes */size`"],
      ],
    },
    {
      kind: "paragraph",
      text: "All three `bytes=` forms are handled — `start-end`, `start-` (open-ended), and `-suffix` (the last N bytes). A multi-range request or a malformed header falls back to the full entity, which is always a valid answer to a Range request.",
    },
    {
      kind: "heading",
      id: "options",
      text: "Options",
    },
    {
      kind: "table",
      headers: ["Option", "Type", "Default", "Notes"],
      rows: [
        [
          "`contentType`",
          "`string`",
          '`"application/octet-stream"`',
          "Content type of the entity. Set it so clients render the bytes correctly.",
        ],
      ],
    },
    {
      kind: "heading",
      id: "low-level-parse",
      text: "Parsing a range yourself",
    },
    {
      kind: "paragraph",
      text: "`parseRange(header, size)` is exported if you need the resolved offsets without `sendRange` — for example to slice an object-store read or build your own `Content-Range`. It returns `{ start, end }` (inclusive), `\"invalid\"` for an unsatisfiable range, or `null` to serve the whole entity.",
    },
    {
      kind: "code",
      snippet: {
        filename: "parse.ts",
        language: "ts",
        code: `import { parseRange } from "@usetoki/toki-range";

const spec = parseRange("bytes=0-1023", 4096);
// -> { start: 0, end: 1023 }
parseRange("bytes=-500", 4096); // -> { start: 3596, end: 4095 }
parseRange("bytes=9000-", 4096); // -> "invalid"`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "A range read never loads the whole file into memory — only the requested slice is read off disk. That's the difference between streaming a 4 GB video and OOM-ing on it.",
    },
  ],
};
