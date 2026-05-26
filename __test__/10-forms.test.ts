import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";

import { reply, type FormFile } from "../ts";
import { makeTempDir, removeTempDir, withServer, type RunningServer } from "./helpers";

// Shapes the /form handler reflects, so tests assert against plain JSON.
interface ReflectedField {
  readonly name: string;
  readonly value: string;
}
interface ReflectedFile {
  readonly field: string;
  readonly filename: string | null;
  readonly contentType: string | null;
  readonly size: number;
  readonly hasData: boolean;
  readonly path: string | null;
  readonly dataUtf8: string | null;
}

function reflectForm(req: {
  form: { fields: ReadonlyArray<ReflectedField>; files: ReadonlyArray<FormFile> } | null;
}) {
  if (req.form === null) {
    return reply.json({ error: "not a form" }, { status: 400 });
  }
  const files: ReflectedFile[] = req.form.files.map((file) => ({
    field: file.field,
    filename: file.filename ?? null,
    contentType: file.contentType ?? null,
    size: file.size,
    hasData: file.data !== undefined && file.data !== null,
    path: file.path ?? null,
    dataUtf8: file.data ? Buffer.from(file.data).toString("utf8") : null,
  }));
  return reply.json({
    fields: req.form.fields.map((f) => ({ name: f.name, value: f.value })),
    files,
  });
}

function multipart(boundary: string, parts: string[]): string {
  let body = "";
  for (const part of parts) {
    body += `--${boundary}\r\n${part}\r\n`;
  }
  body += `--${boundary}--\r\n`;
  return body;
}

describe("forms (inline, no uploadDir)", () => {
  let server: RunningServer;

  before(async () => {
    server = await withServer(
      (app) => {
        app.post("/form", (req) => reflectForm(req));
      },
      { parseForms: true },
    );
  });

  after(() => server.close());

  test("parses urlencoded fields, including repeated and empty values", async () => {
    const res = await fetch(`${server.base}/form`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=Ada&hobby=math&hobby=logic&empty=",
    });
    const body = (await res.json()) as { fields: ReflectedField[]; files: ReflectedFile[] };
    assert.deepEqual(body.fields, [
      { name: "name", value: "Ada" },
      { name: "hobby", value: "math" },
      { name: "hobby", value: "logic" },
      { name: "empty", value: "" },
    ]);
    assert.equal(body.files.length, 0);
  });

  test("decodes percent escapes and plus in urlencoded values", async () => {
    const res = await fetch(`${server.base}/form`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "path=%2Ftmp%2Ffile&phrase=hello+world",
    });
    const body = (await res.json()) as { fields: ReflectedField[] };
    assert.deepEqual(body.fields, [
      { name: "path", value: "/tmp/file" },
      { name: "phrase", value: "hello world" },
    ]);
  });

  test("parses multipart text fields", async () => {
    const boundary = "X";
    const res = await fetch(`${server.base}/form`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: multipart(boundary, [
        'Content-Disposition: form-data; name="a"\r\n\r\nfirst',
        'Content-Disposition: form-data; name="b"\r\n\r\nsecond',
      ]),
    });
    const body = (await res.json()) as { fields: ReflectedField[]; files: ReflectedFile[] };
    assert.deepEqual(body.fields, [
      { name: "a", value: "first" },
      { name: "b", value: "second" },
    ]);
    assert.equal(body.files.length, 0);
  });

  test("returns file bytes inline via data when no uploadDir is set", async () => {
    const boundary = "Y";
    const res = await fetch(`${server.base}/form`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: multipart(boundary, [
        'Content-Disposition: form-data; name="doc"; filename="hi.txt"\r\nContent-Type: text/plain\r\n\r\nhello world',
      ]),
    });
    const body = (await res.json()) as { files: ReflectedFile[] };
    assert.equal(body.files.length, 1);
    const file = body.files[0]!;
    assert.equal(file.field, "doc");
    assert.equal(file.filename, "hi.txt");
    assert.equal(file.contentType, "text/plain");
    assert.equal(file.size, "hello world".length);
    assert.equal(file.hasData, true);
    assert.equal(file.path, null);
    assert.equal(file.dataUtf8, "hello world");
  });

  test("a non-form content-type leaves req.form null", async () => {
    const res = await fetch(`${server.base}/form`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "not a form" });
  });

  test("a malformed multipart body is rejected natively with 400", async () => {
    const res = await fetch(`${server.base}/form`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=X" },
      body: "this is not multipart at all",
    });
    assert.equal(res.status, 400);
    assert.equal(await res.text(), "Bad Request");
  });
});

describe("forms with uploadDir + limits", () => {
  let server: RunningServer;
  let uploadDir: string;

  before(async () => {
    uploadDir = makeTempDir("uploads");
    server = await withServer(
      (app) => {
        app.post("/upload", (req) => reflectForm(req));
      },
      {
        parseForms: true,
        uploadDir,
        allowedFileExtensions: ["txt", "png"],
        maxFileSize: 32,
      },
    );
  });

  after(() => {
    server.close();
    removeTempDir(uploadDir);
  });

  test("writes an uploaded file to disk and reports its path with the bytes on disk", async () => {
    const boundary = "Z";
    const res = await fetch(`${server.base}/upload`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: multipart(boundary, [
        'Content-Disposition: form-data; name="f"; filename="note.txt"\r\n\r\nsaved to disk',
      ]),
    });
    const body = (await res.json()) as { files: ReflectedFile[] };
    const file = body.files[0]!;
    assert.equal(file.hasData, false);
    assert.ok(file.path);
    assert.ok(file.path!.startsWith(uploadDir));
    // The stored name is generated, never the client filename.
    assert.ok(!file.path!.includes("note.txt"));
    assert.ok(file.path!.endsWith(".txt"));
    const onDisk = await readFile(file.path!, "utf8");
    assert.equal(onDisk, "saved to disk");
  });

  test("a disallowed extension is rejected with 415", async () => {
    const boundary = "E";
    const res = await fetch(`${server.base}/upload`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: multipart(boundary, [
        'Content-Disposition: form-data; name="f"; filename="evil.exe"\r\n\r\nMZ',
      ]),
    });
    assert.equal(res.status, 415);
    assert.equal(await res.text(), "Unsupported Media Type");
  });

  test("an oversize file is rejected with 413", async () => {
    const boundary = "O";
    const res = await fetch(`${server.base}/upload`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: multipart(boundary, [
        `Content-Disposition: form-data; name="f"; filename="big.txt"\r\n\r\n${"x".repeat(64)}`,
      ]),
    });
    assert.equal(res.status, 413);
    assert.equal(await res.text(), "Payload Too Large");
  });

  test("a traversal filename is stored safely inside the upload dir", async () => {
    const boundary = "T";
    const res = await fetch(`${server.base}/upload`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: multipart(boundary, [
        'Content-Disposition: form-data; name="f"; filename="../../etc/passwd.txt"\r\n\r\npwned',
      ]),
    });
    const body = (await res.json()) as { files: ReflectedFile[] };
    const file = body.files[0]!;
    assert.ok(file.path!.startsWith(uploadDir));
    assert.ok(!file.path!.includes(".."));
    assert.ok(!file.path!.includes("etc"));
    const onDisk = await readFile(file.path!, "utf8");
    assert.equal(onDisk, "pwned");
  });
});
