// Fixed-window in-memory rate limit: N requests per window per client, else 429 + Retry-After.
// Run: npx tsx examples/13-rate-limit.ts
// for i in $(seq 1 7); do curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3013/; done

import { Toki, reply, type Middleware, type TokiRequest } from "../ts";

const PORT = 3013;

interface Window {
  count: number;
  readonly resetAt: number;
}

function clientKey(req: TokiRequest): string {
  // Illustrative only: trust X-Forwarded-For just from known proxies in production.
  return req.headers.get("x-forwarded-for") ?? req.headers.get("x-client-id") ?? "anonymous";
}

function rateLimit(limit: number, windowMs: number): Middleware {
  const windows = new Map<string, Window>();

  return (req) => {
    const key = clientKey(req);
    const now = Date.now();
    let window = windows.get(key);
    if (window === undefined || now >= window.resetAt) {
      window = { count: 0, resetAt: now + windowMs };
      windows.set(key, window);
    }

    window.count += 1;
    req.setResponseHeader("x-ratelimit-limit", String(limit));
    req.setResponseHeader("x-ratelimit-remaining", String(Math.max(0, limit - window.count)));

    if (window.count > limit) {
      const retryAfter = Math.ceil((window.resetAt - now) / 1000);
      return reply.json(
        { error: "too many requests", retryAfter },
        { status: 429, headers: { "retry-after": String(retryAfter) } },
      );
    }
  };
}

const app = new Toki();

app.use(rateLimit(5, 10_000));
app.get("/", () => reply.json({ ok: true }));

async function main(): Promise<void> {
  const server = await app.listen({ port: PORT });
  console.log(`READY http://${server.host}:${server.port}`);
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}

void main();
