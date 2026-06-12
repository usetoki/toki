import assert from "node:assert/strict";
import { after, test } from "node:test";
import { connectTcp, createTcpServer } from "../ts/index.ts";

// ipv6Only binds a plain IPv6 listener with no dual-stack v4-mapped accepts. A host without an
// IPv6 loopback skips the body. Own file: the engine is process-global, so this can't share a
// listener with the v4 tests.

test("ipv6Only binds an IPv6 listener and accepts an IPv6 connection", async () => {
  let resolveGot!: (s: string) => void;
  const got = new Promise<string>((r) => (resolveGot = r));
  const server = createTcpServer(
    (sock) => {
      sock.on("data", (c) => resolveGot(c.toString()));
    },
    { ipv6Only: true },
  );
  let bound: { port: number };
  try {
    bound = server.listen(0, "::1");
  } catch {
    return; // host without IPv6 loopback; nothing to assert
  }
  after(() => server.close());

  const client = await connectTcp("::1", bound.port, {});
  client.write("v6");
  assert.equal(await got, "v6");
  client.destroy();
});
