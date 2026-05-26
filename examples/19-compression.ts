// Native response compression (br/gzip, negotiated) plus defaultHeaders on every response.
// Run: npx tsx examples/19-compression.ts
// curl --compressed -v http://127.0.0.1:3019/big 2>&1 | grep -i -E 'content-encoding|vary|x-powered-by'

import { Toki, reply } from "../ts";

const PORT = 3019;

const app = new Toki();

// Large enough to clear compressionMinSize and be worth encoding.
const ITEMS = Array.from({ length: 500 }, (_, id) => ({
  id,
  name: `item-${id}`,
  description: "the quick brown fox jumps over the lazy dog ".repeat(4),
}));

// Dynamic: compressed per request against the client's Accept-Encoding.
app.get("/big", () => reply.json({ count: ITEMS.length, items: ITEMS }));

// Dynamic but tiny: under compressionMinSize, so it goes out identity even when the client offers br/gzip.
app.get("/small", () => reply.json({ count: ITEMS.length, sample: ITEMS[0] }));

// Native: pre-compressed once at registration, so the body must clear compressionMinSize.
app.native.json("/manifest", { service: "toki", count: ITEMS.length, items: ITEMS });

async function main(): Promise<void> {
  const server = await app.listen({
    port: PORT,
    compression: true,
    compressionMinSize: 1024,
    defaultHeaders: { "x-powered-by": "toki" },
  });
  console.log(`READY http://${server.host}:${server.port}`);
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}

void main();
