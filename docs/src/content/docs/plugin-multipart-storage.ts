import type { DocPage } from "../../types";

export const multipartStoragePluginPage: DocPage = {
  slug: "plugin-multipart-storage",
  title: "Multipart storage",
  description: "Handle multipart uploads — write file parts to disk, S3, or a custom store.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-multipart-storage` parses a `multipart/form-data` request, collects the plain fields, and hands each file part to a pluggable storage backend. Parts go one at a time, as a view into the request buffer, with no extra copy. Size, count, and type limits are enforced as parts are read, so a bad upload is rejected before it ever reaches your store. Use it on any form that uploads a file: an avatar, a CSV import, a batch of attachments.",
    },
    {
      kind: "heading",
      id: "install",
      text: "Install",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-multipart-storage`,
      },
    },
    {
      kind: "heading",
      id: "quick-start",
      text: "Quick start",
    },
    {
      kind: "paragraph",
      text: "`multipart(req, options)` returns `{ fields, files }`. `fields` is the plain form fields; `files` is whatever your storage returned for each saved file. `diskStorage` writes to a directory with random, traversal-safe filenames.",
    },
    {
      kind: "code",
      snippet: {
        filename: "app.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";
import { multipart, diskStorage } from "@usetoki/toki-multipart-storage";

const app = createApp();
const storage = diskStorage({ dir: "/var/uploads" }); // random, traversal-safe names

app.post("/avatar", async (req) => {
  const { fields, files } = await multipart(req, {
    storage,
    maxFiles: 1,
    maxFileBytes: 2 * 1024 * 1024,
    allowedTypes: ["image/png", "image/jpeg"],
  });
  return { caption: fields.caption, saved: files.map((f) => f.path) };
});`,
      },
    },
    {
      kind: "paragraph",
      text: "A `diskStorage` result is `{ field, filename, contentType, size, path }`. `path` is the absolute path on disk; `filename` is the (untrusted) client name, kept only as metadata.",
    },
    {
      kind: "heading",
      id: "allowed-types",
      text: "Restricting content types",
    },
    {
      kind: "paragraph",
      text: "`allowedTypes` takes an exact (case-insensitive) list or a RegExp. Anything else is rejected with a 415 before the part is stored. The list compares the bare type, ignoring parameters like `; charset=utf-8`.",
    },
    {
      kind: "code",
      snippet: {
        filename: "images.ts",
        language: "ts",
        code: `// any image type, by pattern
await multipart(req, { storage, allowedTypes: /^image\\// });

// an explicit allowlist
await multipart(req, { storage, allowedTypes: ["application/pdf", "text/csv"] });`,
      },
    },
    {
      kind: "heading",
      id: "custom-storage",
      text: "A custom storage backend",
    },
    {
      kind: "paragraph",
      text: "`Storage` is one method: `store(file)` takes an `IncomingFile` (`field`, `filename`, `contentType`, `data`) and returns whatever reference your app needs. The return type flows through to `files`, so an S3 store can return its key.",
    },
    {
      kind: "code",
      snippet: {
        filename: "s3-storage.ts",
        language: "ts",
        code: `import { randomUUID } from "node:crypto";
import type { Storage } from "@usetoki/toki-multipart-storage";

const s3Storage = (bucket: string): Storage<{ key: string }> => ({
  async store(file) {
    const key = \`uploads/\${randomUUID()}\`;
    await s3.putObject({ Bucket: bucket, Key: key, Body: file.data, ContentType: file.contentType });
    return { key };
  },
});

app.post("/docs", async (req) => {
  const { files } = await multipart(req, { storage: s3Storage("my-bucket"), maxFiles: 5 });
  return { keys: files.map((f) => f.key) };
});`,
      },
    },
    {
      kind: "heading",
      id: "naming",
      text: "Custom disk filenames",
    },
    {
      kind: "paragraph",
      text: "By default `diskStorage` names files randomly and keeps a safe extension from the original. Pass `filename` to name them yourself — the resolved path is still confined to `dir`, so a crafted name can't escape it.",
    },
    {
      kind: "code",
      snippet: {
        filename: "naming.ts",
        language: "ts",
        code: `const storage = diskStorage({
  dir: "/var/uploads",
  filename: (file) => \`\${Date.now()}-\${file.field}\`,
});`,
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
        ["storage", "Storage<T>", "—", "Required. Where file parts are written."],
        ["maxFiles", "number", "10", "Maximum number of files; a 413 past it."],
        ["maxFileBytes", "number", "10485760", "Maximum bytes per file (10 MiB); a 413 past it."],
        ["maxFields", "number", "1000", "Maximum number of non-file fields; a 413 past it."],
        ["allowedTypes", "string[] | RegExp", "any", "Permitted content types; a 415 otherwise."],
      ],
    },
    {
      kind: "heading",
      id: "errors",
      text: "Errors",
    },
    {
      kind: "paragraph",
      text: "A rejected upload raises a `MultipartError` carrying a `statusCode` (400 for a non-multipart body, 413 for a size/count limit, 415 for a disallowed type). Pair it with toki-sensible and it renders as problem+json automatically.",
    },
    {
      kind: "code",
      snippet: {
        filename: "with-sensible.ts",
        language: "ts",
        code: `import { sensible } from "@usetoki/toki-sensible";

sensible(app); // a MultipartError now comes out as application/problem+json`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "The request body is buffered by the engine up to `maxBodyBytes`. The default is small, so raise it in `listen({ maxBodyBytes })` to match your largest expected upload, or large files are truncated before `multipart` ever sees them.",
    },
    {
      kind: "callout",
      tone: "tip",
      text: "The client's filename is never trusted as a path. `diskStorage` writes under a random name (keeping a sanitized extension) and refuses any resolved target outside `dir`, so a `../../etc/passwd` filename can't write where it shouldn't.",
    },
  ],
};
