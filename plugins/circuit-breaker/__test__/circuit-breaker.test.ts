import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp, reply } from "@usetoki/toki";
import { Breaker, circuitBreaker } from "../dist/index.js";

function clock() {
  let t = 1000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}
const cfg = (over: Partial<ConstructorParameters<typeof Breaker>[0]> = {}, now = () => 0) => ({
  failureThreshold: 0.5,
  minimumRequests: 4,
  windowMs: 1000,
  resetTimeoutMs: 100,
  now,
  ...over,
});

// --- state machine (deterministic via an injected clock) --------------------

test("opens once the failure rate crosses the threshold", () => {
  const b = new Breaker(cfg());
  (b.allow(), b.success());
  (b.allow(), b.success());
  (b.allow(), b.failure());
  assert.equal(b.state, "closed"); // 1/3 failures, below 50%
  (b.allow(), b.failure());
  assert.equal(b.state, "open"); // 2/4 = 50%
});

test("does not open below the minimum request volume", () => {
  const b = new Breaker(cfg({ minimumRequests: 5 }));
  for (let i = 0; i < 4; i++) (b.allow(), b.failure());
  assert.equal(b.state, "closed"); // 100% failures, but only 4 < 5 calls
});

test("fast-fails while open, then admits a probe after the reset timeout", () => {
  const c = clock();
  const events: string[] = [];
  const b = new Breaker(
    cfg({ minimumRequests: 1, resetTimeoutMs: 100, onHalfOpen: () => events.push("half") }, c.now),
  );
  (b.allow(), b.failure());
  assert.equal(b.state, "open");
  assert.equal(b.allow(), false);
  assert.ok(b.cooldownSeconds() > 0);
  c.advance(100);
  assert.equal(b.allow(), true);
  assert.equal(b.state, "half-open");
  assert.deepEqual(events, ["half"]);
});

test("a successful probe closes, a failed probe re-opens", () => {
  const c = clock();
  const b = new Breaker(cfg({ minimumRequests: 1 }, c.now));
  (b.allow(), b.failure());
  c.advance(100);
  (b.allow(), b.success()); // probe ok
  assert.equal(b.state, "closed");

  (b.allow(), b.failure()); // open again (min 1)
  c.advance(100);
  (b.allow(), b.failure()); // probe fails
  assert.equal(b.state, "open");
  assert.equal(b.allow(), false);
});

test("only one probe is admitted while half-open", () => {
  const c = clock();
  const b = new Breaker(cfg({ minimumRequests: 1 }, c.now));
  (b.allow(), b.failure());
  c.advance(100);
  assert.equal(b.allow(), true); // the probe
  assert.equal(b.allow(), false); // a concurrent caller is rejected
});

test("a throwing transition hook does not corrupt the state machine", () => {
  const b = new Breaker(
    cfg({
      minimumRequests: 1,
      onOpen: () => {
        throw new Error("hook blew up");
      },
    }),
  );
  b.allow();
  b.failure(); // opens, and calls the throwing onOpen
  assert.equal(b.state, "open"); // state still updated despite the hook throwing
});

test("the rolling window resets stale counters", () => {
  const c = clock();
  const b = new Breaker(cfg({ minimumRequests: 3, windowMs: 1000 }, c.now));
  (b.allow(), b.failure());
  (b.allow(), b.failure()); // 2 failures, below volume
  c.advance(1000);
  (b.allow(), b.success());
  (b.allow(), b.success());
  assert.equal(b.state, "closed"); // the old failures expired with the window
});

// --- handler wrapper (real clock, short timeouts) ---------------------------

let healthy = false;
const app = createApp({ logger: false });
app.get(
  "/svc",
  circuitBreaker(
    () => {
      if (!healthy) throw new Error("upstream down");
      return reply.text("ok");
    },
    { failureThreshold: 0.5, minimumRequests: 2, resetTimeoutMs: 80 },
  ),
);
app.get(
  "/fb",
  circuitBreaker(
    () => {
      throw new Error("down");
    },
    {
      failureThreshold: 1,
      minimumRequests: 1,
      resetTimeoutMs: 1000,
      fallback: () => reply.text("degraded"),
    },
  ),
);
const handle = app.listen(0, { host: "127.0.0.1" });
after(() => handle.close());

test("the route fast-fails 503 once the breaker opens, and recovers via a probe", async () => {
  healthy = false;
  assert.equal((await app.inject({ url: "/svc" })).statusCode, 500); // handler threw
  assert.equal((await app.inject({ url: "/svc" })).statusCode, 500); // opens here
  const blocked = await app.inject({ url: "/svc" });
  assert.equal(blocked.statusCode, 503); // fast-fail, handler not called
  assert.ok(Number(blocked.headers["retry-after"]) >= 0);

  healthy = true;
  await new Promise((r) => setTimeout(r, 110)); // past the reset timeout
  assert.equal((await app.inject({ url: "/svc" })).statusCode, 200); // probe succeeds → closed
  assert.equal((await app.inject({ url: "/svc" })).statusCode, 200);
});

test("a fallback is served instead of an error", async () => {
  const a = await app.inject({ url: "/fb" });
  assert.equal(a.statusCode, 200);
  assert.equal(a.body, "degraded");
  const b = await app.inject({ url: "/fb" }); // breaker now open → still the fallback
  assert.equal(b.body, "degraded");
});
