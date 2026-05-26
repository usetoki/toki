// Native static serving via app.static: content-type, ETag/304, and Range/206 handled in Rust.
// Run: npx tsx examples/12-static-files.ts
// curl -i http://127.0.0.1:3012/static/data.json    curl -i -H 'Range: bytes=0-3' http://127.0.0.1:3012/static/data.json

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Toki } from "../ts";

const PORT = 3012;

const app = new Toki();

async function main(): Promise<void> {
  // Self-contained sample content in a fresh temp dir.
  const baseDir = await mkdtemp(join(tmpdir(), "toki-static-"));
  await Promise.all([
    writeFile(join(baseDir, "index.html"), "<h1>Static index</h1>\n"),
    writeFile(join(baseDir, "data.json"), `${JSON.stringify({ hello: "world" })}\n`),
  ]);

  app.static("/static", baseDir, { cacheControl: "public, max-age=3600" });

  const server = await app.listen({ port: PORT });
  console.log(`READY http://${server.host}:${server.port} (serving ${baseDir})`);
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}

void main();
