// Native form parsing (urlencoded + multipart) delivered on req.form via parseForms.
// Run: npx tsx examples/03-forms.ts
// curl -X POST http://127.0.0.1:3003/submit -d 'name=Ada&hobby=math&hobby=logic'
// curl -X POST http://127.0.0.1:3003/submit -F name=Ada -F file=@/etc/hostname

import { Toki, reply, type TokiResponse } from "../ts";

const PORT = 3003;

const app = new Toki();

app.post("/submit", (req): TokiResponse => {
  // null unless parseForms is on and the body is a recognized form type; raw bytes stay on req.body.
  if (req.form === null) {
    return reply.json({ error: "expected a form-encoded body" }, { status: 400 });
  }

  const fields: Record<string, string[]> = {};
  for (const { name, value } of req.form.fields) {
    (fields[name] ??= []).push(value);
  }

  const files = req.form.files.map((file) => ({
    field: file.field,
    filename: file.filename ?? null,
    size: file.size,
  }));

  return reply.json({ fields, files });
});

async function main(): Promise<void> {
  const server = await app.listen({ port: PORT, parseForms: true });
  console.log(`READY http://${server.host}:${server.port}`);
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}

void main();
