import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { after, test } from "node:test";
import { createApp, reply, type TokiRequest } from "@usetoki/toki";
import { createJwksResolver, JwtError, jwtAuth, signJwt, verifyJwt } from "../src/index.ts";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const ed = generateKeyPairSync("ed25519");

test("RS256, PS256, ES256 and EdDSA all round-trip", async () => {
  for (const [alg, keys] of [
    ["RS256", rsa],
    ["PS256", rsa],
    ["ES256", ec],
    ["EdDSA", ed],
  ] as const) {
    const token = signJwt({ sub: "user-1" }, keys.privateKey, { algorithm: alg });
    const payload = await verifyJwt(token, keys.publicKey, { algorithms: [alg] });
    assert.equal(payload.sub, "user-1", alg);
  }
});

test("a tampered signature is rejected", async () => {
  const token = signJwt({ sub: "u" }, ec.privateKey, { algorithm: "ES256" });
  await assert.rejects(
    () => verifyJwt(token.slice(0, -3) + "AAA", ec.publicKey, { algorithms: ["ES256"] }),
    JwtError,
  );
});

test("the wrong public key is rejected", async () => {
  const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const token = signJwt({ sub: "u" }, ec.privateKey, { algorithm: "ES256" });
  await assert.rejects(
    () => verifyJwt(token, other.publicKey, { algorithms: ["ES256"] }),
    /invalid signature/,
  );
});

test("expiry and not-before are enforced with optional tolerance", async () => {
  const expired = signJwt({ sub: "u" }, ec.privateKey, { algorithm: "ES256", expiresIn: -10 });
  await assert.rejects(
    () => verifyJwt(expired, ec.publicKey, { algorithms: ["ES256"] }),
    /expired/,
  );
  const tolerated = await verifyJwt(expired, ec.publicKey, {
    algorithms: ["ES256"],
    clockTolerance: 60,
  });
  assert.equal(tolerated.sub, "u");

  const future = signJwt({ sub: "u" }, ec.privateKey, { algorithm: "ES256", notBefore: 60 });
  await assert.rejects(
    () => verifyJwt(future, ec.publicKey, { algorithms: ["ES256"] }),
    /not yet valid/,
  );
});

test("issuer and audience are checked", async () => {
  const token = signJwt({}, ec.privateKey, {
    algorithm: "ES256",
    issuer: "https://issuer",
    audience: "api",
  });
  assert.ok(
    await verifyJwt(token, ec.publicKey, {
      algorithms: ["ES256"],
      issuer: "https://issuer",
      audience: "api",
    }),
  );
  await assert.rejects(
    () => verifyJwt(token, ec.publicKey, { algorithms: ["ES256"], issuer: "https://evil" }),
    /issuer/,
  );
  await assert.rejects(
    () => verifyJwt(token, ec.publicKey, { algorithms: ["ES256"], audience: "other" }),
    /audience/,
  );
});

test("algorithm confusion is rejected when the token alg is not allowed", async () => {
  const token = signJwt({ sub: "u" }, ec.privateKey, { algorithm: "ES256" });
  await assert.rejects(
    () => verifyJwt(token, ec.publicKey, { algorithms: ["RS256"] }),
    /not allowed/,
  );
});

test("a malformed token is rejected, not crashed", async () => {
  await assert.rejects(
    () => verifyJwt("not.a.jwt.token", ec.publicKey, { algorithms: ["ES256"] }),
    JwtError,
  );
  await assert.rejects(
    () => verifyJwt("only-one-part", ec.publicKey, { algorithms: ["ES256"] }),
    /malformed/,
  );
});

test("a JWKS resolver fetches once, caches, and rejects an unknown kid", async () => {
  const jwks = { keys: [{ ...ec.publicKey.export({ format: "jwk" }), kid: "key-1", use: "sig" }] };
  let fetches = 0;
  const fakeFetch = (async () => {
    fetches++;
    return { ok: true, json: async () => jwks } as unknown as Response;
  }) as typeof fetch;

  const resolver = createJwksResolver({ uri: "https://issuer/jwks", fetch: fakeFetch });
  const token = signJwt({ sub: "u" }, ec.privateKey, { algorithm: "ES256", keyid: "key-1" });
  assert.equal((await verifyJwt(token, resolver, { algorithms: ["ES256"] })).sub, "u");
  await verifyJwt(token, resolver, { algorithms: ["ES256"] });
  assert.equal(fetches, 1, "second verify uses the cache");

  const wrongKid = signJwt({ sub: "u" }, ec.privateKey, { algorithm: "ES256", keyid: "missing" });
  await assert.rejects(
    () => verifyJwt(wrongKid, resolver, { algorithms: ["ES256"] }),
    /no key for kid/,
  );
});

// --- jwtAuth middleware -----------------------------------------------------

const app = createApp({ logger: false });
app.get(
  "/protected",
  { preHandler: jwtAuth({ key: ec.publicKey, algorithms: ["ES256"] }) },
  (req: TokiRequest) => reply.json(req.user ?? null),
);
const handle = app.listen(0, { host: "127.0.0.1" });
after(() => handle.close());

test("jwtAuth accepts a valid Bearer token and sets req.user", async () => {
  const token = signJwt({ sub: "alice" }, ec.privateKey, { algorithm: "ES256" });
  const r = await app.inject({ url: "/protected", headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.statusCode, 200);
  assert.equal((r.json() as { sub: string }).sub, "alice");
});

test("jwtAuth rejects missing and invalid tokens with 401", async () => {
  assert.equal((await app.inject({ url: "/protected" })).statusCode, 401);
  const bad = await app.inject({ url: "/protected", headers: { authorization: "Bearer garbage" } });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.headers["www-authenticate"], "Bearer");
});

test("a non-finite expiresIn is rejected", () => {
  assert.throws(
    () => signJwt({}, ec.privateKey, { algorithm: "ES256", expiresIn: Infinity }),
    /finite/,
  );
});

test("a caller-supplied header.alg can't override the signing algorithm", () => {
  const token = signJwt({ sub: "u" }, "secret", {
    algorithm: "HS256",
    header: { alg: "HS512", kid: "k1" },
  });
  const headerSeg = token.split(".")[0]!;
  const decoded = JSON.parse(Buffer.from(headerSeg, "base64url").toString("utf8")) as {
    alg: string;
    kid?: string;
  };
  assert.equal(decoded.alg, "HS256"); // authoritative — the signature is HS256
  assert.equal(decoded.kid, "k1"); // extra header fields still merge
});

// --- algorithm confusion: HMAC over a public-key PEM --------------------------
// The classic attack: a service verifies RS256 with a public PEM but also allows HS256.
// An attacker forges an HS256 token whose "secret" is that published public PEM. The
// assertHmacKey guard must refuse a PEM as an HMAC key on both sign and verify.

const rsaPublicPem = rsa.publicKey.export({ type: "spki", format: "pem" }) as string;

test("verifying an HS256 token forged with a public-key PEM is rejected (algorithm-confusion)", async () => {
  // forge an HS256 token RAW: HMAC over base64url(header).base64url(payload) using the RSA
  // public PEM as the secret — exactly what a confused verifier would (wrongly) accept.
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ sub: "attacker" })}`;
  const sig = createHmac("sha256", rsaPublicPem).update(signingInput).digest("base64url");
  const forged = `${signingInput}.${sig}`;

  await assert.rejects(
    () => verifyJwt(forged, rsaPublicPem, { algorithms: ["RS256", "HS256"] }),
    /algorithm-confusion/,
    "must not accept an HMAC token keyed on the public PEM",
  );
});

test("signing with an HMAC algorithm and a PEM key throws (algorithm-confusion)", () => {
  assert.throws(
    () => signJwt({ sub: "u" }, rsaPublicPem, { algorithm: "HS256" }),
    /algorithm-confusion/,
  );
});

test("a normal HMAC secret string (not PEM) still signs and verifies", async () => {
  const token = signJwt({ sub: "ok" }, "a-plain-shared-secret", { algorithm: "HS256" });
  const payload = await verifyJwt(token, "a-plain-shared-secret", { algorithms: ["HS256"] });
  assert.equal(payload.sub, "ok");
});
