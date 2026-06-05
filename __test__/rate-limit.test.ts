import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

// each scenario runs in its own child: native limiter holds max/window in global state and can't re-listen after close()
const execFileP = promisify(execFile);
const worker = fileURLToPath(new URL("./fixtures/ratelimit-worker.ts", import.meta.url));

type Step = { hit: { url?: string; count: number } } | { sleep: number };
type Spec = { rateLimit?: { max: number; windowMs: number }; steps: Step[] };
type HitResult = {
  statuses: number[];
  retryAfter: string | null;
  body: string | null;
  statusMessage: string | null;
  contentType: string | null;
  handlerHits: number;
};

async function run(spec: Spec): Promise<HitResult[]> {
  const { stdout } = await execFileP("node", [worker, JSON.stringify(spec)], {
    timeout: 30_000,
  });
  const results = JSON.parse(stdout) as HitResult[];
  const expected = spec.steps.filter(
    (s): s is Extract<Step, { hit: unknown }> => "hit" in s,
  ).length;
  assert.equal(results.length, expected, `expected one result per hit step (${expected})`);
  return results;
}

function at(results: HitResult[], index: number): HitResult {
  const result = results[index];
  assert.ok(result, `missing result at index ${index}`);
  return result;
}

const hit = (count: number, url?: string): Step => ({
  hit: url === undefined ? { count } : { count, url },
});
const wait = (ms: number): Step => ({ sleep: ms });

test("native rate limiter allows up to max, then 429s", async () => {
  const r = at(await run({ rateLimit: { max: 3, windowMs: 60_000 }, steps: [hit(5)] }), 0);
  assert.deepEqual(r.statuses, [200, 200, 200, 429, 429]);
});

test("the 429 carries a Retry-After header and is served natively", async () => {
  const r = at(await run({ rateLimit: { max: 3, windowMs: 60_000 }, steps: [hit(4)] }), 0);
  assert.equal(r.statuses[3], 429);
  assert.equal(r.statusMessage, "Too Many Requests");
  assert.equal(r.body, "Too Many Requests");
  assert.equal(r.contentType, "text/plain; charset=utf-8");
  const retry = Number(r.retryAfter);
  assert.ok(retry > 0 && retry <= 60, `retry-after should be in (0,60], got ${retry}`);
});

test("a max of 1 allows exactly one request then rejects the rest", async () => {
  const r = at(await run({ rateLimit: { max: 1, windowMs: 60_000 }, steps: [hit(4)] }), 0);
  assert.deepEqual(r.statuses, [200, 429, 429, 429]);
});

test("the limiter never lets a 429'd request reach the handler", async () => {
  const r = at(await run({ rateLimit: { max: 2, windowMs: 60_000 }, steps: [hit(5)] }), 0);
  assert.deepEqual(r.statuses, [200, 200, 429, 429, 429]);
  assert.equal(r.handlerHits, 2, "only the two allowed requests should reach the handler");
});

test("the allowed boundary is inclusive: the max-th request still passes", async () => {
  const r = at(await run({ rateLimit: { max: 5, windowMs: 60_000 }, steps: [hit(6)] }), 0);
  assert.deepEqual(r.statuses, [200, 200, 200, 200, 200, 429]);
  assert.equal(r.statuses[4], 200, "the fifth (last allowed) request must pass");
  assert.equal(r.statuses[5], 429, "the sixth is the first rejection");
});

test("rejection is sticky: once over the limit every further hit is a 429", async () => {
  const r = at(await run({ rateLimit: { max: 2, windowMs: 60_000 }, steps: [hit(8)] }), 0);
  assert.deepEqual(r.statuses, [200, 200, 429, 429, 429, 429, 429, 429]);
});

test("Retry-After is a positive whole number bounded by the window seconds", async () => {
  const rejected = at(
    await run({
      rateLimit: { max: 1, windowMs: 5_000 },
      steps: [hit(1), hit(1)],
    }),
    1,
  );
  assert.equal(rejected.statuses[0], 429);
  assert.equal(typeof rejected.retryAfter, "string");
  assert.match(String(rejected.retryAfter), /^\d+$/, "Retry-After must be whole seconds");
  const n = Number(rejected.retryAfter);
  assert.ok(n >= 1 && n <= 5, `expected (0,5], got ${n}`);
});

test("Retry-After counts down as the window elapses", async () => {
  const counted = await run({
    rateLimit: { max: 1, windowMs: 4_000 },
    steps: [hit(1), hit(1), wait(1_500), hit(1)],
  });
  const early = at(counted, 1);
  const late = at(counted, 2);
  const first = Number(early.retryAfter);
  const later = Number(late.retryAfter);
  assert.equal(early.statuses[0], 429);
  assert.equal(late.statuses[0], 429);
  assert.ok(first >= 1 && first <= 4, `first=${first}`);
  assert.ok(later >= 1 && later <= 4, `later=${later}`);
  assert.ok(later <= first, `Retry-After should not grow: first=${first} later=${later}`);
});

test("every 429 in the same window carries a Retry-After header", async () => {
  const rejected = at(
    await run({
      rateLimit: { max: 1, windowMs: 60_000 },
      steps: [hit(1), hit(3)],
    }),
    1,
  );
  assert.deepEqual(rejected.statuses, [429, 429, 429]);
  assert.ok(Number(rejected.retryAfter) > 0, "the last rejection must carry Retry-After");
});

test("the window resets once it elapses, restoring the full quota", async () => {
  const counted = await run({
    rateLimit: { max: 2, windowMs: 1_000 },
    steps: [hit(3), wait(1_300), hit(3)],
  });
  const before = at(counted, 0);
  const after = at(counted, 1);
  assert.deepEqual(before.statuses, [200, 200, 429]);
  assert.deepEqual(after.statuses, [200, 200, 429], "the rolled-over window restores the cap");
});

test("a request inside the same window after a reject still counts toward the cap", async () => {
  const counted = await run({
    rateLimit: { max: 3, windowMs: 2_000 },
    steps: [hit(3), hit(2), wait(200), hit(1)],
  });
  const served = at(counted, 0);
  const rejected = at(counted, 1);
  const stillRejected = at(counted, 2);
  assert.deepEqual(served.statuses, [200, 200, 200]);
  assert.deepEqual(rejected.statuses, [429, 429]);
  assert.equal(stillRejected.statuses[0], 429, "the window has not elapsed yet");
});

test("quota is restored fully across two consecutive windows", async () => {
  const counted = await run({
    rateLimit: { max: 1, windowMs: 800 },
    steps: [hit(2), wait(1_000), hit(2), wait(1_000), hit(1)],
  });
  const w1 = at(counted, 0);
  const w2 = at(counted, 1);
  const w3 = at(counted, 2);
  assert.deepEqual(w1.statuses, [200, 429]);
  assert.deepEqual(w2.statuses, [200, 429]);
  assert.equal(w3.statuses[0], 200, "the third window starts fresh");
});

test("no rateLimit option means the limiter is off and never 429s", async () => {
  const r = at(await run({ steps: [hit(25)] }), 0);
  assert.ok(
    r.statuses.every((s) => s === 200),
    `every request should pass when the limiter is off, got ${r.statuses}`,
  );
  assert.equal(r.handlerHits, 25);
});

test("the limiter does not interfere with allowed responses' status or body", async () => {
  const r = at(await run({ rateLimit: { max: 10, windowMs: 60_000 }, steps: [hit(1)] }), 0);
  assert.deepEqual(r.statuses, [200]);
  assert.equal(r.body, "ok");
  assert.equal(r.contentType, "text/plain; charset=utf-8");
});

test("404s within quota route normally; only the cap produces a native 429", async () => {
  const counted = await run({
    rateLimit: { max: 2, windowMs: 60_000 },
    steps: [hit(2, "/nope"), hit(1, "/nope")],
  });
  const notFound = at(counted, 0);
  const over = at(counted, 1);
  assert.deepEqual(notFound.statuses, [404, 404], "missing routes 404 and each counts");
  assert.equal(over.statuses[0], 429, "the over-cap request short-circuits before routing");
  assert.equal(over.body, "Too Many Requests");
});
