// run: node examples/forms.ts
import assert from "node:assert/strict";
import { createApp, reply } from "../dist/index.js";

const app = createApp({ logger: false });

app.post("/signup", (req) => {
  const form = req.form;
  if (!form) return reply.text("unsupported content type", 400);
  return { fields: form.fields };
});

app.post("/upload", (req) => {
  const form = req.form;
  if (!form) return reply.text("unsupported content type", 400);
  return {
    name: form.fields.name,
    files: form.files.map((f) => ({
      field: f.name,
      filename: f.filename,
      contentType: f.contentType,
      size: f.data.byteLength,
      text: Buffer.from(f.data).toString("utf8"),
    })),
  };
});

const urlencoded = await app.inject({
  method: "POST",
  url: "/signup",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  payload: "email=ada%40example.com&plan=pro",
});
assert.equal(urlencoded.statusCode, 200);
assert.deepEqual(urlencoded.json(), {
  fields: { email: "ada@example.com", plan: "pro" },
});

const boundary = "----tokiBoundary123";
const file = "id,name\n1,ada\n";
const multipart =
  `--${boundary}\r\n` +
  `Content-Disposition: form-data; name="name"\r\n\r\n` +
  `Ada\r\n` +
  `--${boundary}\r\n` +
  `Content-Disposition: form-data; name="doc"; filename="people.csv"\r\n` +
  `Content-Type: text/csv\r\n\r\n` +
  `${file}\r\n` +
  `--${boundary}--\r\n`;

const upload = await app.inject({
  method: "POST",
  url: "/upload",
  headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  payload: multipart,
});
assert.equal(upload.statusCode, 200);
const body = upload.json<{
  name: string;
  files: Array<{
    field: string;
    filename: string;
    contentType: string;
    size: number;
    text: string;
  }>;
}>();
assert.equal(body.name, "Ada");
assert.equal(body.files.length, 1);
assert.deepEqual(body.files[0], {
  field: "doc",
  filename: "people.csv",
  contentType: "text/csv",
  size: Buffer.byteLength(file),
  text: file,
});

console.log("forms example ok: urlencoded fields + multipart file parsed");
process.exit(0);
