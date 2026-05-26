import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { reply, setCookie } from "../ts";
import { withServer, type RunningServer } from "./helpers";

describe("cookies", () => {
  let server: RunningServer;

  before(async () => {
    server = await withServer((app) => {
      // Reflect the parsed cookie map so tests can assert decoding.
      app.get("/read", (req) => reply.json({ cookies: req.cookies }));
      app.get("/read/:name", (req) =>
        reply.json({ value: req.cookies[req.params.name ?? ""] ?? null }),
      );

      app.get("/set-basic", () => reply.cookie(reply.text("ok"), "plain", "value"));
      app.get("/set-attrs", () =>
        reply.cookie(reply.text("ok"), "session", "tok en", {
          path: "/app",
          httpOnly: true,
          sameSite: "Lax",
          maxAge: 3600,
          secure: true,
        }),
      );
      app.get("/set-many", () => {
        const res = reply.text("ok");
        setCookie(res, "a", "1");
        setCookie(res, "b", "2", { httpOnly: true });
        return res;
      });
      app.get("/samesite-none", () =>
        reply.cookie(reply.text("ok"), "x", "y", { sameSite: "none" }),
      );
    });
  });

  after(() => server.close());

  test("parses a single cookie", async () => {
    const res = await fetch(`${server.base}/read`, { headers: { cookie: "a=1" } });
    assert.deepEqual(await res.json(), { cookies: { a: "1" } });
  });

  test("parses multiple cookies, keeping the first value of a repeated name", async () => {
    const res = await fetch(`${server.base}/read`, {
      headers: { cookie: "a=1; b=2; a=3" },
    });
    assert.deepEqual(await res.json(), { cookies: { a: "1", b: "2" } });
  });

  test("percent-decodes a cookie value", async () => {
    const res = await fetch(`${server.base}/read/token`, {
      headers: { cookie: "token=a%20b%2Fc" },
    });
    assert.deepEqual(await res.json(), { value: "a b/c" });
  });

  test("strips one layer of surrounding double quotes", async () => {
    const res = await fetch(`${server.base}/read/q`, { headers: { cookie: 'q="quoted"' } });
    assert.deepEqual(await res.json(), { value: "quoted" });
  });

  test("a missing cookie reads as null", async () => {
    const res = await fetch(`${server.base}/read/absent`, { headers: { cookie: "other=1" } });
    assert.deepEqual(await res.json(), { value: null });
  });

  test("no Cookie header yields an empty map", async () => {
    const res = await fetch(`${server.base}/read`);
    assert.deepEqual(await res.json(), { cookies: {} });
  });

  test("a basic Set-Cookie has the percent-encoded value", async () => {
    const res = await fetch(`${server.base}/set-basic`);
    assert.deepEqual(res.headers.getSetCookie(), ["plain=value"]);
    await res.body?.cancel();
  });

  test("Set-Cookie attributes are serialized in order", async () => {
    const res = await fetch(`${server.base}/set-attrs`);
    const [cookie] = res.headers.getSetCookie();
    // value is percent-encoded; attributes follow in the serializer's fixed order.
    assert.equal(
      cookie,
      "session=tok%20en; Max-Age=3600; Path=/app; HttpOnly; Secure; SameSite=Lax",
    );
    await res.body?.cancel();
  });

  test("repeated Set-Cookie headers each survive the round trip", async () => {
    const res = await fetch(`${server.base}/set-many`);
    assert.deepEqual(res.headers.getSetCookie(), ["a=1", "b=2; HttpOnly"]);
    await res.body?.cancel();
  });

  test("a lowercase sameSite is normalized to title case", async () => {
    const res = await fetch(`${server.base}/samesite-none`);
    assert.deepEqual(res.headers.getSetCookie(), ["x=y; SameSite=None"]);
    await res.body?.cancel();
  });
});
