// run: node examples/content-type-parser.ts
import assert from "node:assert/strict";
import { createApp } from "../dist/index.js";

const app = createApp({ logger: false });

app.addContentTypeParser("text/csv", (_req, body) => {
  const [header, ...lines] = Buffer.from(body).toString("utf8").trim().split("\n");
  const cols = header!.split(",");
  return lines.map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
  });
});

app.post("/people", async (req) => {
  const rows = await req.parseBody<Array<Record<string, string>>>();
  return { count: rows.length, rows };
});

const res = await app.inject({
  method: "POST",
  url: "/people",
  headers: { "content-type": "text/csv" },
  payload: "id,name\n1,ada\n2,grace\n",
});
assert.equal(res.statusCode, 200);
assert.deepEqual(res.json(), {
  count: 2,
  rows: [
    { id: "1", name: "ada" },
    { id: "2", name: "grace" },
  ],
});

console.log("content-type-parser example ok: text/csv parsed into 2 rows");
process.exit(0);
