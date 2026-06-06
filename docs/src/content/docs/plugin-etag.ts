import type { DocPage } from "../../types";

export const etagPluginPage: DocPage = {
  slug: "plugin-etag",
  title: "ETag",
  description: "Automatic ETag validators and 304 Not Modified for dynamic responses.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-etag` adds an `ETag` to every GET/HEAD response, derived from the body. When the client sends it back as `If-None-Match`, toki answers `304 Not Modified` with an empty body — the payload never goes over the wire. Static files are already validated natively; this covers what your handlers build.",
    },
    {
      kind: "code",
      snippet: { filename: "install.sh", language: "bash", code: `npm install @usetoki/toki-etag` },
    },
    {
      kind: "code",
      snippet: {
        filename: "etag.ts",
        language: "ts",
        code: `import { etag } from "@usetoki/toki-etag";

const app = createApp();
etag(app);

app.get("/users/:id", (req) => db.user(req.params.id)); // now carries an ETag`,
      },
    },
    {
      kind: "list",
      items: [
        '`weak` — emit a weak validator (`W/"…"`). Default `false`.',
        '`algorithm` — `"fnv1a"` (default) is a fast, non-crypto hash; `"sha1"`, `"md5"`, `"sha256"` use `node:crypto`.',
        "A handler that set its own `ETag` is left untouched; streaming responses are skipped (no materialized body).",
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "The handler still runs on a conditional request — only the body is withheld. Pair with `@usetoki/toki-cache` to skip the handler too.",
    },
  ],
};
