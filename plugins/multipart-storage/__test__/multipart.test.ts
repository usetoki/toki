import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { TokiRequest } from "@usetoki/toki";
import {
  diskStorage,
  type IncomingFile,
  MultipartError,
  multipart,
  type Storage,
} from "../dist/index.js";

const BOUNDARY = "----tokitest";

interface Part {
  name: string;
  filename?: string;
  contentType?: string;
  value: string;
}
function body(parts: Part[]): Uint8Array {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let head = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) head += `; filename="${part.filename}"`;
    head += "\r\n";
    if (part.contentType) head += `Content-Type: ${part.contentType}\r\n`;
    chunks.push(Buffer.from(`${head}\r\n${part.value}\r\n`));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}
function request(
  parts: Part[],
  contentType = `multipart/form-data; boundary=${BOUNDARY}`,
): TokiRequest {
  return {
    headers: new Headers({ "content-type": contentType }),
    body: body(parts),
  } as unknown as TokiRequest;
}

const memory = (): {
  storage: Storage<{ filename: string; size: number }>;
  files: IncomingFile[];
} => {
  const files: IncomingFile[] = [];
  return {
    files,
    storage: {
      async store(file) {
        files.push(file);
        return { filename: file.filename, size: file.data.byteLength };
      },
    },
  };
};

test("parses fields and hands files to storage", async () => {
  const { storage, files } = memory();
  const result = await multipart(
    request([
      { name: "title", value: "hello" },
      { name: "doc", filename: "a.txt", contentType: "text/plain", value: "FILEDATA" },
    ]),
    { storage },
  );
  assert.deepEqual(result.fields, { title: "hello" });
  assert.deepEqual(result.files, [{ filename: "a.txt", size: 8 }]);
  assert.equal(Buffer.from(files[0]!.data).toString(), "FILEDATA");
});

test("diskStorage writes the part to disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "toki-upload-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const result = await multipart(
    request([
      { name: "doc", filename: "report.pdf", contentType: "application/pdf", value: "PDFBYTES" },
    ]),
    { storage: diskStorage({ dir }) },
  );
  const stored = result.files[0]!;
  assert.equal(stored.size, 8);
  assert.match(stored.path, /\.pdf$/);
  assert.equal(readFileSync(stored.path, "utf8"), "PDFBYTES");
});

test("enforces the file count limit", async () => {
  const { storage } = memory();
  await assert.rejects(
    () =>
      multipart(
        request([
          { name: "a", filename: "1.txt", value: "x" },
          { name: "b", filename: "2.txt", value: "y" },
        ]),
        { storage, maxFiles: 1 },
      ),
    (e) => e instanceof MultipartError && e.statusCode === 413,
  );
});

test("enforces the per-file size limit", async () => {
  const { storage } = memory();
  await assert.rejects(
    () =>
      multipart(request([{ name: "f", filename: "big.bin", value: "0123456789" }]), {
        storage,
        maxFileBytes: 4,
      }),
    (e) => e instanceof MultipartError && e.statusCode === 413,
  );
});

test("enforces the content-type allow-list", async () => {
  const { storage } = memory();
  await assert.rejects(
    () =>
      multipart(
        request([
          { name: "f", filename: "x.exe", contentType: "application/x-msdownload", value: "MZ" },
        ]),
        {
          storage,
          allowedTypes: ["image/png", "image/jpeg"],
        },
      ),
    (e) => e instanceof MultipartError && e.statusCode === 415,
  );
});

test("a non-multipart request is rejected", async () => {
  const { storage } = memory();
  await assert.rejects(
    () => multipart(request([{ name: "x", value: "y" }], "application/json"), { storage }),
    (e) => e instanceof MultipartError && e.statusCode === 400,
  );
});

test("an empty file input is skipped", async () => {
  const { storage, files } = memory();
  const result = await multipart(request([{ name: "avatar", filename: "", value: "" }]), {
    storage,
  });
  assert.equal(result.files.length, 0);
  assert.equal(files.length, 0);
});

test("file data containing the boundary bytes is not truncated", async () => {
  const { storage, files } = memory();
  const payload = `AAAA--${BOUNDARY}BBBB`; // the boundary appears inside the data (no CRLF before it)
  await multipart(request([{ name: "f", filename: "x.bin", value: payload }]), { storage });
  assert.equal(Buffer.from(files[0]!.data).toString(), payload);
});

test("the content-type allow-list ignores MIME parameters", async () => {
  const { storage } = memory();
  const result = await multipart(
    request([
      { name: "f", filename: "a.png", contentType: "image/png; charset=binary", value: "X" },
    ]),
    { storage, allowedTypes: ["image/png"] },
  );
  assert.equal(result.files.length, 1);
});

test("enforces the field count limit", async () => {
  const { storage } = memory();
  await assert.rejects(
    () =>
      multipart(
        request([
          { name: "a", value: "1" },
          { name: "b", value: "2" },
        ]),
        { storage, maxFields: 1 },
      ),
    (e) => e instanceof MultipartError && e.statusCode === 413,
  );
});
