import assert from "node:assert/strict";
import { test } from "node:test";
import type { TcpSocket } from "@usetoki/toki";
import { MemoryStore, tcpRateLimit, type Store, type StoreHit } from "../src/index.ts";

// a scriptable stand-in for a native socket: records writes/ends/destroys and lets a
// test push data/end/close events through whatever listeners the adapter attached.
class FakeSocket implements TcpSocket {
  remoteAddress = "203.0.113.7";
  remotePort = 49152;
  authorized = false;
  writes: string[] = [];
  ended = false;
  destroyed = false;
  #listeners = new Map<string, Array<(...args: never[]) => void>>();

  write(data: Uint8Array | string): boolean {
    this.writes.push(data.toString());
    return true;
  }
  end(data?: Uint8Array | string): void {
    if (data !== undefined) this.writes.push(data.toString());
    this.ended = true;
  }
  destroy(): void {
    this.destroyed = true;
  }
  on(event: "data", listener: (chunk: Buffer) => void): this;
  on(event: "drain" | "end" | "close", listener: () => void): this;
  on(event: string, listener: (...args: never[]) => void): this {
    const bucket = this.#listeners.get(event) ?? [];
    bucket.push(listener);
    this.#listeners.set(event, bucket);
    return this;
  }
  off(event: "data" | "drain" | "end" | "close", listener: (...args: never[]) => void): this {
    const bucket = this.#listeners.get(event) ?? [];
    const i = bucket.indexOf(listener);
    if (i !== -1) bucket.splice(i, 1);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.#listeners.get(event) ?? []) (fn as (...a: unknown[]) => void)(...args);
  }
}

// an async store whose verdicts resolve only when the test says so
class GatedStore implements Store {
  #pending: Array<(hit: StoreHit) => void> = [];
  hits = 0;
  hit(): Promise<StoreHit> {
    this.hits++;
    return new Promise((resolve) => this.#pending.push(resolve));
  }
  release(count: number, resetAt = Date.now() + 60_000): void {
    for (const resolve of this.#pending.splice(0)) resolve({ count, resetAt });
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

test("admits connections up to max and destroys the rest", () => {
  const store = new MemoryStore();
  let handled = 0;
  const wrapped = tcpRateLimit({ max: 2, windowMs: 60_000, store }, () => handled++);
  const first = new FakeSocket();
  const second = new FakeSocket();
  const third = new FakeSocket();
  for (const s of [first, second, third]) wrapped(s);
  assert.equal(handled, 2);
  assert.equal(first.destroyed, false);
  assert.equal(second.destroyed, false);
  assert.equal(third.destroyed, true);
  store.close();
});

test("sync path hands the handler the bare socket", () => {
  const store = new MemoryStore();
  let received: TcpSocket | undefined;
  const wrapped = tcpRateLimit({ max: 1, windowMs: 60_000, store }, (s) => (received = s));
  const socket = new FakeSocket();
  wrapped(socket);
  assert.equal(received, socket); // no wrapper in the sync path
  store.close();
});

test("separate source addresses get separate budgets", () => {
  const store = new MemoryStore();
  let handled = 0;
  const wrapped = tcpRateLimit({ max: 1, windowMs: 60_000, store }, () => handled++);
  const a = new FakeSocket();
  const b = new FakeSocket();
  b.remoteAddress = "203.0.113.8";
  const a2 = new FakeSocket();
  wrapped(a);
  wrapped(b);
  wrapped(a2); // same IP as `a` → over
  assert.equal(handled, 2);
  assert.equal(a2.destroyed, true);
  assert.equal(b.destroyed, false);
  store.close();
});

test("keyGenerator overrides the per-IP default", () => {
  const store = new MemoryStore();
  let handled = 0;
  const wrapped = tcpRateLimit(
    { max: 1, windowMs: 60_000, store, keyGenerator: () => "everyone" },
    () => handled++,
  );
  const a = new FakeSocket();
  const b = new FakeSocket();
  b.remoteAddress = "198.51.100.1"; // different IP, same bucket
  wrapped(a);
  wrapped(b);
  assert.equal(handled, 1);
  assert.equal(b.destroyed, true);
  store.close();
});

test("skip bypasses the limiter entirely", () => {
  const store = new MemoryStore();
  let handled = 0;
  const wrapped = tcpRateLimit(
    { max: 1, windowMs: 60_000, store, skip: () => true },
    () => handled++,
  );
  for (let i = 0; i < 5; i++) wrapped(new FakeSocket());
  assert.equal(handled, 5);
  store.close();
});

test("onLimit replaces the default destroy", () => {
  const store = new MemoryStore();
  const wrapped = tcpRateLimit(
    {
      max: 1,
      windowMs: 60_000,
      store,
      onLimit: (socket, info) => {
        assert.equal(info.limit, 1);
        assert.equal(info.remaining, 0);
        assert.ok(info.retryAfter >= 0);
        socket.end("BUSY\n");
      },
    },
    () => {},
  );
  const a = new FakeSocket();
  const b = new FakeSocket();
  wrapped(a);
  wrapped(b);
  assert.equal(b.destroyed, false); // not destroyed — onLimit owns the goodbye
  assert.equal(b.ended, true);
  assert.deepEqual(b.writes, ["BUSY\n"]);
  store.close();
});

test("async store: bytes arriving before the verdict replay in order", async () => {
  const store = new GatedStore();
  const chunks: string[] = [];
  let handledSocket: TcpSocket | undefined;
  const wrapped = tcpRateLimit({ max: 5, windowMs: 60_000, store }, (socket) => {
    handledSocket = socket;
    socket.on("data", (chunk) => chunks.push(chunk.toString()));
  });
  const socket = new FakeSocket();
  wrapped(socket);
  // verdict still in flight; the peer is already talking
  socket.emit("data", Buffer.from("one"));
  socket.emit("data", Buffer.from("two"));
  assert.equal(handledSocket, undefined);
  store.release(1); // allowed
  await tick();
  assert.ok(handledSocket);
  assert.deepEqual(chunks, ["one", "two"]);
  // post-verdict traffic flows straight through
  socket.emit("data", Buffer.from("three"));
  assert.deepEqual(chunks, ["one", "two", "three"]);
});

test("async store: over-limit verdict destroys; handler never runs", async () => {
  const store = new GatedStore();
  let handled = 0;
  const wrapped = tcpRateLimit({ max: 1, windowMs: 60_000, store }, () => handled++);
  const socket = new FakeSocket();
  wrapped(socket);
  socket.emit("data", Buffer.from("early bytes"));
  store.release(2); // count 2 > max 1
  await tick();
  assert.equal(handled, 0);
  assert.equal(socket.destroyed, true);
});

test("async store: wrapper proxies peer fields and writes", async () => {
  const store = new GatedStore();
  let wrapperSocket: TcpSocket | undefined;
  const wrapped = tcpRateLimit({ max: 5, windowMs: 60_000, store }, (s) => (wrapperSocket = s));
  const socket = new FakeSocket();
  socket.remoteAddress = "192.0.2.99";
  socket.remotePort = 1234;
  wrapped(socket);
  store.release(1);
  await tick();
  assert.ok(wrapperSocket);
  assert.equal(wrapperSocket.remoteAddress, "192.0.2.99");
  assert.equal(wrapperSocket.remotePort, 1234);
  wrapperSocket.write("pong");
  assert.deepEqual(socket.writes, ["pong"]);
  wrapperSocket.end();
  assert.equal(socket.ended, true);
});

test("async store: end/close queued during the verdict still reach the handler", async () => {
  const store = new GatedStore();
  const events: string[] = [];
  const wrapped = tcpRateLimit({ max: 5, windowMs: 60_000, store }, (socket) => {
    socket.on("end", () => events.push("end"));
    socket.on("close", () => events.push("close"));
  });
  const socket = new FakeSocket();
  wrapped(socket);
  socket.emit("end");
  socket.emit("close"); // peer came and went before the store answered
  store.release(1);
  await tick();
  assert.deepEqual(events, ["end", "close"]);
});

test("async store failure fails open by default", async () => {
  const store: Store = {
    hit: () => Promise.reject(new Error("redis down")),
  };
  let handled = 0;
  const wrapped = tcpRateLimit({ max: 1, windowMs: 60_000, store }, () => handled++);
  const socket = new FakeSocket();
  wrapped(socket);
  await tick();
  assert.equal(handled, 1);
  assert.equal(socket.destroyed, false);
});

test("async store failure with onStoreError closed destroys", async () => {
  const store: Store = {
    hit: () => Promise.reject(new Error("redis down")),
  };
  let handled = 0;
  const wrapped = tcpRateLimit(
    { max: 1, windowMs: 60_000, store, onStoreError: "closed" },
    () => handled++,
  );
  const socket = new FakeSocket();
  wrapped(socket);
  await tick();
  assert.equal(handled, 0);
  assert.equal(socket.destroyed, true);
});

test("sync store throw fails open by default and closed on request", () => {
  const bad: Store = {
    hit: () => {
      throw new Error("boom");
    },
  };
  let handled = 0;
  const open = tcpRateLimit({ max: 1, windowMs: 60_000, store: bad }, () => handled++);
  const a = new FakeSocket();
  open(a);
  assert.equal(handled, 1);

  const closed = tcpRateLimit(
    { max: 1, windowMs: 60_000, store: bad, onStoreError: "closed" },
    () => handled++,
  );
  const b = new FakeSocket();
  closed(b);
  assert.equal(handled, 1);
  assert.equal(b.destroyed, true);
});

test("window reset readmits a previously limited address", async () => {
  const store = new MemoryStore();
  let handled = 0;
  const wrapped = tcpRateLimit({ max: 1, windowMs: 50, store }, () => handled++);
  wrapped(new FakeSocket());
  const blocked = new FakeSocket();
  wrapped(blocked);
  assert.equal(blocked.destroyed, true);
  await new Promise((r) => setTimeout(r, 60));
  const fresh = new FakeSocket();
  wrapped(fresh);
  assert.equal(handled, 2);
  assert.equal(fresh.destroyed, false);
  store.close();
});

test("one store shared by two limiters is one budget", () => {
  const store = new MemoryStore();
  let handled = 0;
  const first = tcpRateLimit({ max: 2, windowMs: 60_000, store }, () => handled++);
  const second = tcpRateLimit({ max: 2, windowMs: 60_000, store }, () => handled++);
  first(new FakeSocket());
  second(new FakeSocket()); // same IP, same store → second hit
  const over = new FakeSocket();
  first(over); // third hit on a max-2 budget
  assert.equal(handled, 2);
  assert.equal(over.destroyed, true);
  store.close();
});
