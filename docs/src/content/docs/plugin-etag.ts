import type { DocPage } from "../../types";

export const etagPluginPage: DocPage = {
  slug: "plugin-etag",
  title: "ETag",
  description: "Automatic ETag validators and 304 Not Modified for dynamic responses.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-etag` hashes each GET/HEAD body into an `ETag` header. When the client sends that tag back as `If-None-Match`, toki answers `304 Not Modified` with no body, so the payload never crosses the wire. Static files already get native validators; this is for when a handler builds the body itself (a rendered page, a JSON document, a serialized list).",
    },
    {
      kind: "code",
      snippet: { filename: "install.sh", language: "bash", code: `npm install @usetoki/toki-etag` },
    },
    {
      kind: "heading",
      id: "quick-start",
      text: "Quick start",
    },
    {
      kind: "paragraph",
      text: "Register the hook once. Every successful GET/HEAD response now carries an `ETag`, and conditional requests get a `304`.",
    },
    {
      kind: "code",
      snippet: {
        filename: "etag.ts",
        language: "ts",
        code: `import { createApp, reply } from "@usetoki/toki";
import { etag } from "@usetoki/toki-etag";

const app = createApp();
etag(app);

app.get("/users/:id", (req) => reply.json(db.user(req.params.id)));
// 1st request  -> 200 + ETag: "1f-8a3c..."
// repeat with  If-None-Match: "1f-8a3c..."  -> 304, empty body`,
      },
    },
    {
      kind: "heading",
      id: "weak-validators",
      text: "Weak validators",
    },
    {
      kind: "paragraph",
      text: "A weak validator (`W/\"…\"`) says two representations are semantically equivalent, not byte-identical. Use it when small, harmless differences (a timestamp, a reordered key) shouldn't force a re-download. Comparison ignores the `W/` prefix either way, so a weak tag still matches its strong twin.",
    },
    {
      kind: "code",
      snippet: {
        filename: "weak.ts",
        language: "ts",
        code: `etag(app, { weak: true });

app.get("/feed", () => reply.json(buildFeed()));
// ETag: W/"2a1-4f9c..."`,
      },
    },
    {
      kind: "heading",
      id: "stronger-hash",
      text: "Choosing the hash",
    },
    {
      kind: "paragraph",
      text: "The default `fnv1a` is allocation-free and fast: a 32-bit hash prefixed with the body length, which makes a collision between two different bodies vanishingly unlikely. That's all a cache validator needs. If you'd rather use a crypto digest (to match an existing system, say), pick `sha1`, `md5`, or `sha256`; those route through `node:crypto`.",
    },
    {
      kind: "code",
      snippet: {
        filename: "algorithm.ts",
        language: "ts",
        code: `etag(app, { algorithm: "sha256" });
// ETag: "Zk9...base64url"`,
      },
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
        ["`weak`", "`boolean`", "`false`", "Emit `W/\"…\"` instead of a strong validator."],
        [
          "`algorithm`",
          '`"fnv1a" \\| "sha1" \\| "md5" \\| "sha256"`',
          '`"fnv1a"`',
          "`fnv1a` is fast and non-crypto; the rest use `node:crypto`.",
        ],
      ],
    },
    {
      kind: "heading",
      id: "behavior",
      text: "What gets tagged",
    },
    {
      kind: "list",
      items: [
        "Only `200` GET/HEAD responses — an error or redirect is never turned into a `304`.",
        "A handler that set its own `ETag` (on the response or staged via `setResponseHeader`) is left untouched.",
        "`If-None-Match: *` matches any current tag; a comma-separated list matches if any entry does.",
        "Streaming responses are skipped: there's no materialized body to hash.",
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "A conditional request still runs the handler — only the body is withheld on a match. To skip the work entirely, put `@usetoki/toki-cache` in front so the response is served from the store before the handler fires.",
    },
    {
      kind: "callout",
      tone: "tip",
      text: "`fnv1a` adds no crypto cost and is plenty for cache validation. Only switch to `sha256` if a downstream system expects that format.",
    },
  ],
};
