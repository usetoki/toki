// Content negotiation off the Accept header, plus a 301 redirect via reply.redirect.
// Run: npx tsx examples/14-content-negotiation.ts
// curl -H 'accept: text/html' http://127.0.0.1:3014/resource    curl -i http://127.0.0.1:3014/old

import { Toki, reply, type TokiResponse } from "../ts";

const PORT = 3014;

const app = new Toki();

const RESOURCE = { id: 1, title: "Toki", tags: ["fast", "typed"] } as const;

// First recognized type wins; a real impl would parse q-values.
function negotiate(accept: string): "json" | "html" | "text" {
  for (const part of accept.split(",")) {
    switch (part.split(";")[0]?.trim().toLowerCase()) {
      case "application/json":
      case "*/*":
        return "json";
      case "text/html":
        return "html";
      case "text/plain":
        return "text";
    }
  }
  return "json";
}

app.get("/resource", (req): TokiResponse => {
  switch (negotiate(req.headers.get("accept") ?? "*/*")) {
    case "html":
      return reply.html(
        `<h1>${RESOURCE.title}</h1><ul>${RESOURCE.tags.map((t) => `<li>${t}</li>`).join("")}</ul>`,
      );
    case "text":
      return reply.text(`${RESOURCE.title}: ${RESOURCE.tags.join(", ")}`);
    case "json":
      return reply.json(RESOURCE);
  }
});

app.get("/old", () => reply.redirect("/resource", 301));

async function main(): Promise<void> {
  const server = await app.listen({ port: PORT });
  console.log(`READY http://${server.host}:${server.port}`);
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}

void main();
