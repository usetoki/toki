// one rate-limited app per child process: the native limiter holds max/window in
// global state and the engine can't re-listen after close(), so each scenario
// runs fresh here and reports what it saw as JSON on stdout. spec is argv[2].
import { createApp, reply } from "../../ts/index.ts";

type Step = { hit: { url?: string; count: number } } | { sleep: number };
type Spec = { rateLimit?: { max: number; windowMs: number }; steps: Step[] };

const spec = JSON.parse(process.argv[2] ?? "{}") as Spec;

const app = createApp({ logger: false });
let handlerHits = 0;
app.get("/hit", () => {
  handlerHits += 1;
  return reply.text("ok");
});
app.get("/json", () => ({ ok: true }));

const listenOpts: { host: string; rateLimit?: { max: number; windowMs: number } } = {
  host: "127.0.0.1",
};
if (spec.rateLimit) listenOpts.rateLimit = spec.rateLimit;
const handle = app.listen(0, listenOpts);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: unknown[] = [];

for (const step of spec.steps ?? []) {
  if ("sleep" in step) {
    await sleep(step.sleep);
    continue;
  }
  const { url = "/hit", count } = step.hit;
  const statuses: number[] = [];
  let last: Awaited<ReturnType<typeof app.inject>> | null = null;
  for (let i = 0; i < count; i++) {
    last = await app.inject({ url });
    statuses.push(last.statusCode);
  }
  results.push({
    statuses,
    retryAfter: last?.headers["retry-after"] ?? null,
    body: last?.body ?? null,
    statusMessage: last?.statusMessage ?? null,
    contentType: last?.headers["content-type"] ?? null,
    handlerHits,
  });
}

handle.close();
process.stdout.write(JSON.stringify(results));
process.exit(0);
