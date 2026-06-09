import assert from "node:assert/strict";
import { test } from "node:test";
import type { RemoteInfo, UdpSocket } from "@usetoki/toki";
import {
  MemoryStore,
  tcpRateLimit,
  udpRateLimit,
  type Store,
  type StoreHit,
} from "../src/index.ts";

const fakeUdpSocket: UdpSocket = {
  bind: () => ({ port: 0 }),
  send: () => {},
  close: () => {},
};

const from = (address: string, port = 50000): RemoteInfo => ({ address, port });
const msg = (text: string): Buffer => Buffer.from(text);
const tick = () => new Promise<void>((r) => setImmediate(r));

test("delivers datagrams up to max and drops the rest silently", () => {
  const store = new MemoryStore();
  const delivered: string[] = [];
  const wrapped = udpRateLimit({ max: 2, windowMs: 60_000, store }, (m) =>
    delivered.push(m.toString()),
  );
  for (const text of ["a", "b", "c", "d"]) wrapped(msg(text), from("203.0.113.7"), fakeUdpSocket);
  assert.deepEqual(delivered, ["a", "b"]);
  store.close();
});

test("separate senders get separate budgets", () => {
  const store = new MemoryStore();
  let delivered = 0;
  const wrapped = udpRateLimit({ max: 1, windowMs: 60_000, store }, () => delivered++);
  wrapped(msg("x"), from("203.0.113.7"), fakeUdpSocket);
  wrapped(msg("x"), from("203.0.113.8"), fakeUdpSocket);
  wrapped(msg("x"), from("203.0.113.7"), fakeUdpSocket); // over for .7
  assert.equal(delivered, 2);
  store.close();
});

test("sender port does not split the default per-IP bucket", () => {
  const store = new MemoryStore();
  let delivered = 0;
  const wrapped = udpRateLimit({ max: 1, windowMs: 60_000, store }, () => delivered++);
  wrapped(msg("x"), from("203.0.113.7", 1111), fakeUdpSocket);
  wrapped(msg("x"), from("203.0.113.7", 2222), fakeUdpSocket); // new port, same IP → over
  assert.equal(delivered, 1);
  store.close();
});

test("keyGenerator can bucket on anything", () => {
  const store = new MemoryStore();
  let delivered = 0;
  const wrapped = udpRateLimit(
    { max: 1, windowMs: 60_000, store, keyGenerator: (rinfo) => `${rinfo.address}:${rinfo.port}` },
    () => delivered++,
  );
  wrapped(msg("x"), from("203.0.113.7", 1111), fakeUdpSocket);
  wrapped(msg("x"), from("203.0.113.7", 2222), fakeUdpSocket); // distinct key now
  assert.equal(delivered, 2);
  store.close();
});

test("skip bypasses the limiter", () => {
  const store = new MemoryStore();
  let delivered = 0;
  const wrapped = udpRateLimit(
    { max: 1, windowMs: 60_000, store, skip: (m) => m.toString() === "vip" },
    () => delivered++,
  );
  for (let i = 0; i < 4; i++) wrapped(msg("vip"), from("203.0.113.7"), fakeUdpSocket);
  assert.equal(delivered, 4);
  wrapped(msg("pleb"), from("203.0.113.7"), fakeUdpSocket); // first counted hit
  wrapped(msg("pleb"), from("203.0.113.7"), fakeUdpSocket); // over
  assert.equal(delivered, 5);
  store.close();
});

test("onLimit observes the drop with limit info", () => {
  const store = new MemoryStore();
  const overs: string[] = [];
  const wrapped = udpRateLimit(
    {
      max: 1,
      windowMs: 60_000,
      store,
      onLimit: (m, rinfo, info) => {
        overs.push(`${rinfo.address}:${m.toString()}`);
        assert.equal(info.limit, 1);
        assert.equal(info.remaining, 0);
        assert.ok(info.resetAt > Date.now() - 1000);
      },
    },
    () => {},
  );
  wrapped(msg("ok"), from("203.0.113.7"), fakeUdpSocket);
  wrapped(msg("blocked"), from("203.0.113.7"), fakeUdpSocket);
  assert.deepEqual(overs, ["203.0.113.7:blocked"]);
  store.close();
});

test("async store delivers after the verdict resolves", async () => {
  let resolveHit: ((hit: StoreHit) => void) | undefined;
  const store: Store = {
    hit: () => new Promise((resolve) => (resolveHit = resolve)),
  };
  const delivered: string[] = [];
  const wrapped = udpRateLimit({ max: 5, windowMs: 60_000, store }, (m) =>
    delivered.push(m.toString()),
  );
  wrapped(msg("late"), from("203.0.113.7"), fakeUdpSocket);
  assert.deepEqual(delivered, []);
  resolveHit?.({ count: 1, resetAt: Date.now() + 60_000 });
  await tick();
  assert.deepEqual(delivered, ["late"]);
});

test("async store over-limit drops after the verdict", async () => {
  const store: Store = {
    hit: () => Promise.resolve({ count: 9, resetAt: Date.now() + 60_000 }),
  };
  let delivered = 0;
  const wrapped = udpRateLimit({ max: 1, windowMs: 60_000, store }, () => delivered++);
  wrapped(msg("x"), from("203.0.113.7"), fakeUdpSocket);
  await tick();
  assert.equal(delivered, 0);
});

test("store failure fails open by default and closed on request", async () => {
  const bad: Store = { hit: () => Promise.reject(new Error("down")) };
  let delivered = 0;
  const open = udpRateLimit({ max: 1, windowMs: 60_000, store: bad }, () => delivered++);
  open(msg("x"), from("203.0.113.7"), fakeUdpSocket);
  await tick();
  assert.equal(delivered, 1);

  const closed = udpRateLimit(
    { max: 1, windowMs: 60_000, store: bad, onStoreError: "closed" },
    () => delivered++,
  );
  closed(msg("x"), from("203.0.113.7"), fakeUdpSocket);
  await tick();
  assert.equal(delivered, 1); // dropped
});

test("sync store throw fails open by default", () => {
  const bad: Store = {
    hit: () => {
      throw new Error("boom");
    },
  };
  let delivered = 0;
  const wrapped = udpRateLimit({ max: 1, windowMs: 60_000, store: bad }, () => delivered++);
  wrapped(msg("x"), from("203.0.113.7"), fakeUdpSocket);
  assert.equal(delivered, 1);
});

test("window reset readmits a sender", async () => {
  const store = new MemoryStore();
  let delivered = 0;
  const wrapped = udpRateLimit({ max: 1, windowMs: 50, store }, () => delivered++);
  wrapped(msg("x"), from("203.0.113.7"), fakeUdpSocket);
  wrapped(msg("x"), from("203.0.113.7"), fakeUdpSocket); // dropped
  await new Promise((r) => setTimeout(r, 60));
  wrapped(msg("x"), from("203.0.113.7"), fakeUdpSocket);
  assert.equal(delivered, 2);
  store.close();
});

test("one store shared across tcp and udp limiters is one budget", () => {
  const store = new MemoryStore();
  let tcpHandled = 0;
  let udpDelivered = 0;
  const overTcp = tcpRateLimit(
    { max: 2, windowMs: 60_000, store, keyGenerator: () => "203.0.113.7" },
    () => tcpHandled++,
  );
  const overUdp = udpRateLimit({ max: 2, windowMs: 60_000, store }, () => udpDelivered++);

  overUdp(msg("x"), from("203.0.113.7"), fakeUdpSocket); // hit 1
  // a fake socket close enough for the sync path of tcpRateLimit
  const socket = {
    remoteAddress: "203.0.113.7",
    remotePort: 1,
    authorized: false,
    destroyed: false,
    write: () => true,
    end: () => {},
    destroy() {
      this.destroyed = true;
    },
    on() {
      return this;
    },
    off() {
      return this;
    },
  };
  overTcp(socket as never); // hit 2
  overUdp(msg("x"), from("203.0.113.7"), fakeUdpSocket); // hit 3 → over the shared budget
  assert.equal(tcpHandled, 1);
  assert.equal(udpDelivered, 1);
  store.close();
});
