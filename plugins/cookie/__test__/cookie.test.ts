import assert from "node:assert/strict";
import { test } from "node:test";
import { createCookies } from "../dist/index.js";

const SECRET = "0123456789abcdef-secret-key"; // >= 16 bytes
const ROTATED = "fedcba9876543210-newer-secret";

test("a signed value round-trips and stays readable", () => {
  const c = createCookies({ secret: SECRET });
  const token = c.sign("user-42");
  assert.ok(token.startsWith("user-42."), "value is kept in the clear before the tag");
  assert.equal(c.unsign(token), "user-42");
});

test("a tampered signed value is rejected", () => {
  const c = createCookies({ secret: SECRET });
  const token = c.sign("admin");
  assert.equal(c.unsign(token.replace("admin", "root")), null);
  assert.equal(c.unsign(token.slice(0, -1) + "X"), null); // flipped signature char
  assert.equal(c.unsign("no-dot-here"), null);
  assert.equal(c.unsign(""), null);
});

test("a sealed value round-trips and is opaque", () => {
  const c = createCookies({ secret: SECRET });
  const token = c.seal("top-secret");
  assert.ok(!token.includes("top-secret"));
  assert.equal(c.unseal(token), "top-secret");
});

test("each seal uses a fresh IV but both decrypt", () => {
  const c = createCookies({ secret: SECRET });
  const a = c.seal("same");
  const b = c.seal("same");
  assert.notEqual(a, b);
  assert.equal(c.unseal(a), "same");
  assert.equal(c.unseal(b), "same");
});

test("a tampered or truncated sealed value is rejected, never throws", () => {
  const c = createCookies({ secret: SECRET });
  const token = c.seal("payload");
  const flipped = Buffer.from(token, "base64url");
  flipped[flipped.length - 1] = (flipped.at(-1) ?? 0) ^ 0xff;
  assert.equal(c.unseal(flipped.toString("base64url")), null);
  assert.equal(c.unseal("AAAA"), null);
  assert.equal(c.unseal(""), null);
  assert.equal(c.unseal("!!!not-base64!!!"), null);
});

test("a different secret cannot read another's cookies", () => {
  const a = createCookies({ secret: SECRET });
  const b = createCookies({ secret: ROTATED });
  assert.equal(b.unsign(a.sign("x")), null);
  assert.equal(b.unseal(a.seal("x")), null);
});

test("key rotation: old cookies verify while new ones are minted with the new key", () => {
  const old = createCookies({ secret: SECRET });
  const signed = old.sign("session-1");
  const sealed = old.seal("session-1");

  // new secret first, old kept for rotation
  const rotated = createCookies({ secret: [ROTATED, SECRET] });
  assert.equal(rotated.unsign(signed), "session-1", "old signature still trusted");
  assert.equal(rotated.unseal(sealed), "session-1", "old ciphertext still decrypts");

  // a freshly minted cookie uses the new key, which the old-only ring rejects
  assert.equal(old.unsign(rotated.sign("session-2")), null);
  assert.equal(old.unseal(rotated.seal("session-2")), null);
});

test("empty and unicode values round-trip", () => {
  const c = createCookies({ secret: SECRET });
  assert.equal(c.unsign(c.sign("")), "");
  const emoji = "héllo-🌍-世界";
  assert.equal(c.unseal(c.seal(emoji)), emoji);
});

test("a secret shorter than 16 bytes is rejected at construction", () => {
  assert.throws(() => createCookies({ secret: "too-short" }), /16 bytes/);
  assert.throws(() => createCookies({ secret: [] }), /at least one secret/);
});
