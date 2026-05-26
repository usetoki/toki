// Native multipart upload: files streamed to disk, extension + size limits enforced in Rust.
// Run: npx tsx examples/04-file-upload.ts
// curl -X POST http://127.0.0.1:3004/upload -F file=@./README.md   (bad ext -> 415, >5 MiB -> 413)

import { tmpdir } from "node:os";

import { Toki, reply, type TokiResponse } from "../ts";

const PORT = 3004;
const UPLOAD_DIR = tmpdir();
const ALLOWED_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "pdf", "txt", "md"];
const MAX_FILE_SIZE = 5 * 1024 * 1024;

const app = new Toki();

app.post("/upload", (req): TokiResponse => {
  // The handler only sees uploads that already passed the native ext/size checks.
  if (req.form === null) {
    return reply.json({ error: "expected a multipart/form-data body" }, { status: 400 });
  }
  if (req.form.files.length === 0) {
    return reply.json({ error: "expected at least one file part" }, { status: 400 });
  }

  // With uploadDir set, each file lands on disk and `path` is populated instead of `data`.
  const saved = req.form.files.map((file) => ({
    field: file.field,
    filename: file.filename ?? null,
    contentType: file.contentType ?? null,
    size: file.size,
    path: file.path ?? null,
  }));

  return reply.json({ saved }, { status: 201 });
});

async function main(): Promise<void> {
  const server = await app.listen({
    port: PORT,
    parseForms: true,
    uploadDir: UPLOAD_DIR,
    allowedFileExtensions: ALLOWED_EXTENSIONS,
    maxFileSize: MAX_FILE_SIZE,
  });
  console.log(`READY http://${server.host}:${server.port}`);
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}

void main();
