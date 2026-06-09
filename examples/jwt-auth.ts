// run: node examples/jwt-auth.ts

import assert from "node:assert/strict";
import { createApp, jwtAuth, signJwt } from "../ts/index.ts";

const SECRET = "dev-secret";

const app = createApp();

app.get("/me", { preHandler: jwtAuth({ secret: SECRET }) }, (req) => {
  const user = (req as unknown as { user: { sub?: string; role?: string } }).user;
  return { sub: user.sub, role: user.role };
});

const token = signJwt({ role: "admin" }, SECRET, { subject: "ada", expiresIn: 3600 });

const ok = await app.inject({
  method: "GET",
  url: "/me",
  headers: { authorization: `Bearer ${token}` },
});
assert.equal(ok.statusCode, 200);
assert.deepEqual(ok.json(), { sub: "ada", role: "admin" });

const denied = await app.inject({ method: "GET", url: "/me" });
assert.equal(denied.statusCode, 401);
assert.equal(denied.json<{ error: string }>().error, "Unauthorized");

console.log("jwt-auth: signed token grants access, missing token -> 401");
process.exit(0);
