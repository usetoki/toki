// Native fast path: routes answered entirely in Rust, headers baked in at registration.
// Run: npx tsx examples/11-native-fastpath.ts
// curl -i http://127.0.0.1:3011/health    curl -i http://127.0.0.1:3011/config

import { Toki, reply } from "../ts";

const PORT = 3011;

const app = new Toki();

app.native.text("/health", "ok");

// Set extra headers via `headers`; Content-Type/Length are emitted by the native layer.
app.native.json(
  "/config",
  { feature: { search: true, beta: false }, region: "local" },
  { headers: { "cache-control": "public, max-age=60", "access-control-allow-origin": "*" } },
);

app.native.route("GET", "/version", "toki/0.0.0", {
  contentType: "text/plain; charset=utf-8",
  headers: { "cache-control": "no-store" },
});

// Dynamic route for contrast: crosses into JS, so it can compute per-request data.
app.get("/dynamic", (req) => reply.json({ now: Date.now(), requestId: req.id }));

async function main(): Promise<void> {
  const server = await app.listen({ port: PORT });
  console.log(`READY http://${server.host}:${server.port}`);
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}

void main();
