// run: node examples/cookies.ts
import assert from "node:assert/strict";
import { createApp, parseCookies, reply, serializeCookie } from "../dist/index.js";

const app = createApp({ logger: false });

app.get("/session", (req) => {
  const sid = req.cookies.sid;
  if (!sid) {
    req.setCookie("sid", "abc123", { httpOnly: true, sameSite: "Lax", maxAge: 3600 });
    return { created: true };
  }
  return { sid };
});

app.post("/logout", (req) => {
  req.clearCookie("sid");
  return reply.empty();
});

assert.equal(serializeCookie("theme", "dark", { path: "/" }), "theme=dark; Path=/");
assert.deepEqual(parseCookies("sid=abc123; theme=dark"), { sid: "abc123", theme: "dark" });

const minted = await app.inject({ method: "GET", url: "/session" });
assert.equal(minted.statusCode, 200);
assert.deepEqual(minted.json(), { created: true });
const setCookie = minted.headers["set-cookie"];
assert.ok(Array.isArray(setCookie));
const mintedCookie = setCookie[0];
assert.ok(
  typeof mintedCookie === "string" &&
    /^sid=abc123/.test(mintedCookie) &&
    /HttpOnly/.test(mintedCookie),
);

const echoed = await app.inject({
  method: "GET",
  url: "/session",
  headers: { cookie: "sid=abc123" },
});
assert.deepEqual(echoed.json(), { sid: "abc123" });

const out = await app.inject({ method: "POST", url: "/logout", headers: { cookie: "sid=abc123" } });
assert.equal(out.statusCode, 204);
assert.ok(String(out.headers["set-cookie"]).includes("Max-Age=0"));

console.log("cookies example ok");
process.exit(0);
