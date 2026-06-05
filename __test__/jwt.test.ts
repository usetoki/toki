import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp, jwtAuth, JwtError, reply, signJwt, verifyJwt } from "../dist/index.js";

const SECRET = "super-secret-key";

// port 0 binds an ephemeral loopback port to avoid clashing with the rest of the suite
const app = createApp();
app.get("/open", () => reply.text("public"));
app.get("/me", { preHandler: jwtAuth({ secret: SECRET }) }, (req) => reply.json((req as any).user));
app.get("/admin", { preHandler: jwtAuth({ secret: SECRET, decorateAs: "principal" }) }, (req) =>
  reply.json((req as any).principal),
);
app.get(
  "/cookie-guard",
  {
    preHandler: jwtAuth({
      secret: SECRET,
      getToken: (req) => req.cookies.token ?? null,
    }),
  },
  (req) => reply.json((req as any).user),
);
const handle = app.listen(0, { host: "127.0.0.1" });
after(() => handle.close());

test("sign + verify round-trips the payload", () => {
  const token = signJwt({ sub: "u1", role: "admin" }, SECRET, { expiresIn: 3600 });
  const payload = verifyJwt(token, SECRET);
  assert.equal(payload.sub, "u1");
  assert.equal(payload.role, "admin");
  assert.ok(payload.iat && payload.exp && payload.exp > payload.iat);
});

test("a tampered token fails verification", () => {
  const token = signJwt({ sub: "u1" }, SECRET);
  const forged = `${token.slice(0, -2)}xx`;
  assert.throws(() => verifyJwt(forged, SECRET), /invalid signature/);
});

test("wrong secret is rejected", () => {
  const token = signJwt({ sub: "u1" }, SECRET);
  assert.throws(() => verifyJwt(token, "other"), /invalid signature/);
});

test("expired token is rejected", () => {
  const token = signJwt({ sub: "u1" }, SECRET, { expiresIn: -10 });
  assert.throws(() => verifyJwt(token, SECRET), /expired/);
});

test("jwtAuth guards a route and exposes the payload", async () => {
  const token = signJwt({ sub: "u42", name: "alice" }, SECRET);
  const ok = await app.inject({ url: "/me", headers: { Authorization: `Bearer ${token}` } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json<{ name: string }>().name, "alice");
});

test("jwtAuth rejects a missing or bad token with 401", async () => {
  assert.equal((await app.inject({ url: "/me" })).statusCode, 401);
  const bad = await app.inject({ url: "/me", headers: { Authorization: "Bearer not.a.jwt" } });
  assert.equal(bad.statusCode, 401);
});

test("unguarded routes are unaffected", async () => {
  const r = await app.inject({ url: "/open" });
  assert.equal(r.body, "public");
});

test("round-trip preserves nested and array claims", () => {
  const payload = {
    sub: "u9",
    scopes: ["read", "write"],
    meta: { tier: 2, flags: { beta: true } },
    count: 0,
    nil: null as unknown,
  };
  const decoded = verifyJwt(signJwt(payload, SECRET), SECRET);
  assert.deepEqual(decoded.scopes, ["read", "write"]);
  assert.deepEqual(decoded.meta, { tier: 2, flags: { beta: true } });
  assert.equal(decoded.count, 0);
  assert.equal(decoded.nil, null);
});

test("iat is always set; exp/nbf only when requested", () => {
  const bare = verifyJwt(signJwt({ sub: "x" }, SECRET), SECRET);
  assert.equal(typeof bare.iat, "number");
  assert.equal(bare.exp, undefined);
  assert.equal(bare.nbf, undefined);

  const full = verifyJwt(signJwt({ sub: "x" }, SECRET, { expiresIn: 60, notBefore: 0 }), SECRET);
  assert.equal(full.exp, full.iat! + 60);
  assert.equal(full.nbf, full.iat);
});

test("sign options promote to registered claims", () => {
  const token = signJwt({}, SECRET, {
    subject: "u-sub",
    issuer: "toki",
    audience: ["a", "b"],
  });
  const p = verifyJwt(token, SECRET);
  assert.equal(p.sub, "u-sub");
  assert.equal(p.iss, "toki");
  assert.deepEqual(p.aud, ["a", "b"]);
});

test("explicit payload claims override option-derived ones", () => {
  const fixed = verifyJwt(signJwt({ iat: 123 }, SECRET), SECRET);
  assert.equal(fixed.iat, 123);
});

test("each of HS256/384/512 round-trips and yields a distinct signature", () => {
  const sigs = (["HS256", "HS384", "HS512"] as const).map((algorithm) => {
    const token = signJwt({ sub: "u" }, SECRET, { algorithm });
    assert.equal(verifyJwt(token, SECRET).sub, "u");
    return token.split(".")[2];
  });
  assert.equal(new Set(sigs).size, 3);
});

test("empty payload still verifies and carries only iat", () => {
  const p = verifyJwt(signJwt({}, SECRET), SECRET);
  assert.equal(typeof p.iat, "number");
  assert.equal(p.sub, undefined);
});

test("tampering the payload segment breaks the signature", () => {
  const token = signJwt({ sub: "u1", role: "user" }, SECRET);
  const [h, , s] = token.split(".");
  const forgedBody = Buffer.from(JSON.stringify({ sub: "u1", role: "admin" })).toString(
    "base64url",
  );
  assert.throws(() => verifyJwt(`${h}.${forgedBody}.${s}`, SECRET), JwtError);
});

test("swapping the header (alg downgrade attempt) breaks verification", () => {
  const token = signJwt({ sub: "u1" }, SECRET, { algorithm: "HS512" });
  const [, body, s] = token.split(".");
  const forgedHeader = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
    "base64url",
  );
  assert.throws(() => verifyJwt(`${forgedHeader}.${body}.${s}`, SECRET), /invalid signature/);
});

test("a signature from a different token does not validate", () => {
  const a = signJwt({ sub: "a" }, SECRET);
  const b = signJwt({ sub: "b" }, SECRET);
  const [ha, ba] = a.split(".");
  const sb = b.split(".")[2];
  assert.throws(() => verifyJwt(`${ha}.${ba}.${sb}`, SECRET), /invalid signature/);
});

test("an empty signature segment is rejected", () => {
  const [h, b] = signJwt({ sub: "u1" }, SECRET).split(".");
  assert.throws(() => verifyJwt(`${h}.${b}.`, SECRET), /invalid signature/);
});

test("malformed tokens are rejected by shape, not signature", () => {
  assert.throws(() => verifyJwt("", SECRET), /malformed token/);
  assert.throws(() => verifyJwt("onlyonepart", SECRET), /malformed token/);
  assert.throws(() => verifyJwt("a.b", SECRET), /malformed token/);
  assert.throws(() => verifyJwt("a.b.c.d", SECRET), /malformed token/);
});

test("a non-JSON header is reported as a malformed header", () => {
  const garbage = Buffer.from("not json").toString("base64url");
  const tail = "x".repeat(8);
  assert.throws(() => verifyJwt(`${garbage}.${garbage}.${tail}`, SECRET), /malformed header/);
});

test("an unsupported algorithm in the header is rejected", () => {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ sub: "u1" })).toString("base64url");
  assert.throws(() => verifyJwt(`${header}.${body}.sig`, SECRET), /unsupported algorithm: none/);
});

test("a non-JSON payload (with a valid signature) is a malformed payload", async () => {
  const { createHmac } = await import("node:crypto");
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from("not json").toString("base64url");
  const data = `${header}.${body}`;
  const sig = createHmac("sha256", SECRET).update(data).digest("base64url");
  assert.throws(() => verifyJwt(`${data}.${sig}`, SECRET), /malformed payload/);
});

test("a token expiring exactly now is rejected (now >= exp)", () => {
  const token = signJwt({ sub: "u1" }, SECRET, { expiresIn: 0 });
  assert.throws(() => verifyJwt(token, SECRET), /token expired/);
});

test("clockTolerance keeps a just-expired token alive", () => {
  const token = signJwt({ sub: "u1" }, SECRET, { expiresIn: -5 });
  assert.throws(() => verifyJwt(token, SECRET), /token expired/);
  const p = verifyJwt(token, SECRET, { clockTolerance: 30 });
  assert.equal(p.sub, "u1");
});

test("a not-yet-active token is rejected, tolerated within skew", () => {
  const token = signJwt({ sub: "u1" }, SECRET, { notBefore: 5 });
  assert.throws(() => verifyJwt(token, SECRET), /not yet active/);
  assert.equal(verifyJwt(token, SECRET, { clockTolerance: 30 }).sub, "u1");
});

test("tokens without exp never expire", () => {
  const token = signJwt({ sub: "u1" }, SECRET);
  assert.equal(verifyJwt(token, SECRET).sub, "u1");
});

test("issuer mismatch is rejected, match passes", () => {
  const token = signJwt({}, SECRET, { issuer: "toki" });
  assert.throws(() => verifyJwt(token, SECRET, { issuer: "other" }), /issuer mismatch/);
  assert.equal(verifyJwt(token, SECRET, { issuer: "toki" }).iss, "toki");
});

test("audience is matched against a string or membership in an array", () => {
  const single = signJwt({}, SECRET, { audience: "web" });
  assert.equal(verifyJwt(single, SECRET, { audience: "web" }).aud, "web");
  assert.throws(() => verifyJwt(single, SECRET, { audience: "mobile" }), /audience mismatch/);

  const many = signJwt({}, SECRET, { audience: ["web", "mobile"] });
  assert.deepEqual(verifyJwt(many, SECRET, { audience: "mobile" }).aud, ["web", "mobile"]);
  assert.throws(() => verifyJwt(many, SECRET, { audience: "tv" }), /audience mismatch/);
});

test("algorithms allowlist rejects an otherwise-valid token signed with a disallowed alg", () => {
  const token = signJwt({ sub: "u1" }, SECRET, { algorithm: "HS256" });
  assert.throws(
    () => verifyJwt(token, SECRET, { algorithms: ["HS512"] }),
    /algorithm not allowed: HS256/,
  );
  assert.equal(verifyJwt(token, SECRET, { algorithms: ["HS256"] }).sub, "u1");
});

test("jwtAuth: a valid bearer token yields 200 and a typed user", async () => {
  const token = signJwt({ sub: "u7", name: "bob", role: "admin" }, SECRET);
  const r = await app.inject({ url: "/me", headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.statusCode, 200);
  const user = r.json<{ sub: string; name: string; role: string }>();
  assert.equal(user.sub, "u7");
  assert.equal(user.role, "admin");
});

test("jwtAuth: 'Bearer' scheme is matched case-insensitively", async () => {
  const token = signJwt({ name: "carol" }, SECRET);
  const r = await app.inject({ url: "/me", headers: { Authorization: `bEaReR ${token}` } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json<{ name: string }>().name, "carol");
});

test("jwtAuth: a missing Authorization header is 401 'missing token'", async () => {
  const r = await app.inject({ url: "/me" });
  assert.equal(r.statusCode, 401);
  const e = r.json<{ statusCode: number; error: string; message: string }>();
  assert.equal(e.statusCode, 401);
  assert.equal(e.error, "Unauthorized");
  assert.equal(e.message, "missing token");
});

test("jwtAuth: a non-Bearer scheme is treated as a missing token", async () => {
  const token = signJwt({ sub: "u1" }, SECRET);
  const r = await app.inject({ url: "/me", headers: { Authorization: `Basic ${token}` } });
  assert.equal(r.statusCode, 401);
  assert.equal(r.json<{ message: string }>().message, "missing token");
});

test("jwtAuth: an expired token surfaces the JwtError message in the 401 body", async () => {
  const token = signJwt({ sub: "u1" }, SECRET, { expiresIn: -10 });
  const r = await app.inject({ url: "/me", headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.statusCode, 401);
  assert.equal(r.json<{ message: string }>().message, "token expired");
});

test("jwtAuth: a wrong-secret token is 401 'invalid signature'", async () => {
  const token = signJwt({ sub: "u1" }, "the-other-secret");
  const r = await app.inject({ url: "/me", headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.statusCode, 401);
  assert.equal(r.json<{ message: string }>().message, "invalid signature");
});

test("jwtAuth: a malformed bearer value is 401 with a JwtError message", async () => {
  const three = await app.inject({ url: "/me", headers: { Authorization: "Bearer not.a.jwt" } });
  assert.equal(three.statusCode, 401);
  assert.equal(three.json<{ message: string }>().message, "malformed header");

  const one = await app.inject({ url: "/me", headers: { Authorization: "Bearer garbage" } });
  assert.equal(one.statusCode, 401);
  assert.equal(one.json<{ message: string }>().message, "malformed token");
});

test("jwtAuth: decorateAs attaches the payload to a custom property", async () => {
  const token = signJwt({ sub: "root", scope: "all" }, SECRET);
  const r = await app.inject({ url: "/admin", headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json<{ scope: string }>().scope, "all");
});

test("jwtAuth: a custom getToken can read the token from a cookie", async () => {
  const token = signJwt({ name: "dave" }, SECRET);
  const ok = await app.inject({ url: "/cookie-guard", headers: { Cookie: `token=${token}` } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json<{ name: string }>().name, "dave");

  const missing = await app.inject({ url: "/cookie-guard" });
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.json<{ message: string }>().message, "missing token");
});

test("jwtAuth: the guard runs per-request and never leaks across requests", async () => {
  const t1 = signJwt({ sub: "first" }, SECRET);
  const t2 = signJwt({ sub: "second" }, SECRET);
  const [r1, r2] = await Promise.all([
    app.inject({ url: "/me", headers: { Authorization: `Bearer ${t1}` } }),
    app.inject({ url: "/me", headers: { Authorization: `Bearer ${t2}` } }),
  ]);
  assert.equal(r1.json<{ sub: string }>().sub, "first");
  assert.equal(r2.json<{ sub: string }>().sub, "second");
});
