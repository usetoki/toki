import assert from "node:assert/strict";
import { test } from "node:test";
import type { TokiRequest } from "@usetoki/toki";
import { inCidr, ipFilter, parseCidr, parseIp } from "../dist/index.js";

// a request stub — ipFilter only reads `ip` and `headers`
function request(ip: string, headers: Record<string, string> = {}): TokiRequest {
  return { ip, headers: new Headers(headers) } as unknown as TokiRequest;
}
const status = (out: ReturnType<ReturnType<typeof ipFilter>>): number | undefined =>
  out && typeof out === "object" && "status" in out
    ? (out as { status: number }).status
    : undefined;

// --- address + CIDR parsing -------------------------------------------------

test("parseIp handles IPv4, IPv6, and IPv4-mapped addresses", () => {
  assert.deepEqual(parseIp("192.168.0.1"), { version: 4, value: 0xc0a80001n });
  assert.equal(parseIp("::1")?.version, 6);
  assert.equal(parseIp("2001:db8::1")?.version, 6);
  // ::ffff:1.2.3.4 collapses to plain IPv4
  assert.deepEqual(parseIp("::ffff:1.2.3.4"), { version: 4, value: 0x01020304n });
  assert.equal(parseIp("256.0.0.1"), null);
  assert.equal(parseIp("not-an-ip"), null);
  assert.equal(parseIp("fffff::"), null);
});

test("inCidr matches within v4 and v6 ranges and rejects across families", () => {
  const net = parseCidr("10.0.0.0/8")!;
  assert.ok(inCidr(parseIp("10.255.1.2")!, net));
  assert.ok(!inCidr(parseIp("11.0.0.1")!, net));

  const host = parseCidr("192.168.1.50")!; // bare IP == /32
  assert.ok(inCidr(parseIp("192.168.1.50")!, host));
  assert.ok(!inCidr(parseIp("192.168.1.51")!, host));

  const v6 = parseCidr("2001:db8::/32")!;
  assert.ok(inCidr(parseIp("2001:db8:dead:beef::1")!, v6));
  assert.ok(!inCidr(parseIp("2001:db9::1")!, v6));

  // a v4 address never matches a v6 range
  assert.ok(!inCidr(parseIp("10.0.0.1")!, v6));
  // /0 matches anything of its family
  assert.ok(inCidr(parseIp("8.8.8.8")!, parseCidr("0.0.0.0/0")!));
});

test("parseCidr rejects malformed prefixes", () => {
  assert.equal(parseCidr("10.0.0.0/33"), null);
  assert.equal(parseCidr("2001:db8::/129"), null);
  assert.equal(parseCidr("10.0.0.0/-1"), null);
});

test("a trailing-slash CIDR is rejected, not silently treated as /0 match-all", () => {
  assert.equal(parseCidr("203.0.113.0/"), null);
  assert.equal(parseCidr("10.0.0.0/ "), null);
  // and an allow-list with such an entry fails loudly at setup rather than admitting everyone
  assert.throws(() => ipFilter({ allow: ["203.0.113.0/"] }), /invalid IP or CIDR/);
});

// --- middleware behavior ----------------------------------------------------

test("an allow-list is default-deny: only listed ranges pass", () => {
  const guard = ipFilter({ allow: ["10.0.0.0/8", "127.0.0.1"] });
  assert.equal(status(guard(request("10.1.2.3"))), undefined); // allowed → continue
  assert.equal(status(guard(request("127.0.0.1"))), undefined);
  assert.equal(status(guard(request("8.8.8.8"))), 403); // not listed → blocked
});

test("a deny-list blocks listed ranges and passes the rest", () => {
  const guard = ipFilter({ deny: ["192.168.0.0/16"] });
  assert.equal(status(guard(request("192.168.5.5"))), 403);
  assert.equal(status(guard(request("10.0.0.1"))), undefined);
});

test("deny wins over allow", () => {
  const guard = ipFilter({ allow: ["10.0.0.0/8"], deny: ["10.0.0.99"] });
  assert.equal(status(guard(request("10.0.0.1"))), undefined);
  assert.equal(status(guard(request("10.0.0.99"))), 403);
});

test("trustProxy filters on the left-most X-Forwarded-For address", () => {
  const guard = ipFilter({ allow: ["203.0.113.0/24"], trustProxy: true });
  // peer ip is the proxy; the real client is in XFF
  assert.equal(
    status(guard(request("10.0.0.1", { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))),
    undefined,
  );
  assert.equal(status(guard(request("10.0.0.1", { "x-forwarded-for": "8.8.8.8" }))), 403);
});

test("an unparseable address is blocked", () => {
  assert.equal(status(ipFilter({ deny: [] })(request("garbage"))), 403);
});

test("no lists is a no-op (everything passes)", () => {
  const guard = ipFilter();
  assert.equal(status(guard(request("1.2.3.4"))), undefined);
  assert.equal(status(guard(request("::1"))), undefined);
});

test("a custom status and message are used for blocks", () => {
  const guard = ipFilter({ deny: ["0.0.0.0/0"], statusCode: 401, message: "nope" });
  const out = guard(request("1.1.1.1"));
  assert.equal(status(out), 401);
  assert.equal((out as { body: string }).body, "nope");
});

test("an invalid rule throws at setup, not per request", () => {
  assert.throws(
    () => ipFilter({ allow: ["10.0.0.0/8", "garbage"] }),
    /invalid IP or CIDR "garbage"/,
  );
});
