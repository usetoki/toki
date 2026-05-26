// HMAC-signed session cookie: set on /login, verify on /me, clear on /logout.
// Run: npx tsx examples/05-cookies-session.ts
// curl -i -c jar.txt http://127.0.0.1:3005/login && curl -i -b jar.txt http://127.0.0.1:3005/me

import { createHmac, timingSafeEqual } from "node:crypto";

import { Toki, reply, type TokiResponse } from "../ts";

const PORT = 3005;
const COOKIE_NAME = "session";
const SECRET = process.env["SESSION_SECRET"] ?? "dev-only-secret-change-me";

const app = new Toki();

const hmac = (value: string): string => createHmac("sha256", SECRET).update(value).digest("hex");

function sign(value: string): string {
  return `${value}.${hmac(value)}`;
}

function unsign(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot === -1) {
    return null;
  }
  const value = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(hmac(value));
  // timingSafeEqual throws on length mismatch, so gate on length first.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }
  return value;
}

app.get("/login", (): TokiResponse => {
  const token = sign(`user-${Date.now()}`);
  return reply.cookie(reply.json({ loggedIn: true }), COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 3600,
  });
});

app.get("/me", (req): TokiResponse => {
  const token = req.cookies[COOKIE_NAME];
  const session = token === undefined ? null : unsign(token);
  if (session === null) {
    return reply.json({ error: "no valid session" }, { status: 401 });
  }
  return reply.json({ session });
});

app.get("/logout", (): TokiResponse => {
  return reply.cookie(reply.json({ loggedOut: true }), COOKIE_NAME, "", {
    httpOnly: true,
    path: "/",
    maxAge: 0,
  });
});

async function main(): Promise<void> {
  const server = await app.listen({ port: PORT });
  console.log(`READY http://${server.host}:${server.port}`);
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}

void main();
