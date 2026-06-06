import type { DocPage } from "../../types";

export const multipartStoragePluginPage: DocPage = {
  slug: "plugin-multipart-storage",
  title: "Multipart storage",
  description: "Handle multipart uploads — write file parts to disk, S3, or a custom store.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-multipart-storage` parses a `multipart/form-data` request, collects the plain fields, and hands each file part to a pluggable storage backend — one at a time, as a view into the request buffer, with no extra copy. Size, count, and type limits are enforced as parts are read.",
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
      kind: "code",
      snippet: {
        filename: "app.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";
import { multipart, diskStorage } from "@usetoki/toki-multipart-storage";

const app = createApp();
const storage = diskStorage({ dir: "/var/uploads" }); // random, traversal-safe filenames

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
      kind: "list",
      items: [
        "`diskStorage({ dir })` writes each part to disk with a random name confined to `dir`; the result has `{ path, size, filename, contentType }`.",
        "Implement the one-method `Storage` interface for S3 or any other backend — `store(file)` returns whatever reference you need.",
        "Limits raise a `MultipartError` (with a `statusCode`) before the file reaches storage — pair with toki-sensible to render it.",
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "The request body is buffered by the engine up to `maxBodyBytes`; raise it in `listen({ maxBodyBytes })` for large uploads.",
    },
    {
      kind: "code",
      snippet: {
        filename: "s3-storage.ts",
        language: "ts",
        code: `import type { Storage } from "@usetoki/toki-multipart-storage";

const s3Storage = (bucket: string): Storage<{ key: string }> => ({
  async store(file) {
    const key = crypto.randomUUID();
    await s3.putObject({ Bucket: bucket, Key: key, Body: file.data, ContentType: file.contentType });
    return { key };
  },
});`,
      },
    },
  ],
};
