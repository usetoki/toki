// run: node examples/validation.ts
import assert from "node:assert/strict";
import { createApp } from "../ts/index.ts";

const app = createApp({ logger: false });

app.post(
  "/users/:team",
  {
    schema: {
      params: {
        type: "object",
        properties: {
          team: {
            type: "string",
            minLength: 2,
            errorMessage: { minLength: "team must be at least 2 characters" },
          },
        },
        required: ["team"],
        errorMessage: { required: { team: "team is required in the path" } },
      },
      query: {
        type: "object",
        properties: { invite: { type: "boolean" } },
      },
      body: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 3 },
          email: { type: "string", format: "email" },
          age: {
            type: "integer",
            minimum: 18,
            errorMessage: { minimum: "you must be at least 18" },
          },
        },
        required: ["name", "email"],
        errorMessage: {
          required: { name: "name is required", email: "email is required" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            team: { type: "string" },
            invited: { type: "boolean" },
          },
        },
      },
    },
  },
  (req) => ({
    id: "u_1",
    name: (req.json() as { name: string }).name,
    team: req.params.team,
    invited: req.query.get("invite") === "true",
    password: "never-serialized",
  }),
);

const ok = await app.inject({
  method: "POST",
  url: "/users/eng?invite=true",
  payload: { name: "Ada", email: "ada@toki.dev", age: 36 },
});
assert.equal(ok.statusCode, 200);
const body = ok.json<Record<string, unknown>>();
assert.deepEqual(body, { id: "u_1", name: "Ada", team: "eng", invited: true });
assert.equal("password" in body, false);

const missing = await app.inject({
  method: "POST",
  url: "/users/eng",
  payload: { email: "ada@toki.dev" },
});
assert.equal(missing.statusCode, 400);
const err = missing.json<{ error: string; errors: string[] }>();
assert.equal(err.error, "Bad Request");
assert.ok(err.errors.includes("name is required"));

const bad = await app.inject({
  method: "POST",
  url: "/users/eng",
  payload: { name: "Bo", email: "not-an-email", age: 15 },
});
assert.equal(bad.statusCode, 400);
const badErr = bad.json<{ errors: string[] }>();
assert.ok(badErr.errors.includes("you must be at least 18"));
assert.ok(badErr.errors.some((m) => m.includes("valid email")));

const noTeam = await app.inject({
  method: "POST",
  url: "/users/x",
  payload: { name: "Cy", email: "cy@toki.dev" },
});
assert.equal(noTeam.statusCode, 400);
assert.ok(noTeam.json<{ errors: string[] }>().errors.some((m) => m.includes("at least 2")));

console.log(
  "validation example ok: schema body/query/params + custom errors + response serialization",
);
process.exit(0);
