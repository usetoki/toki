// Reading a typed JSON body and validating it, returning 400 on bad input.
// Run: npx tsx examples/02-json-payload.ts
// curl -X POST http://127.0.0.1:3002/users -H 'content-type: application/json' -d '{"name":"Ada","age":36}'

import { Toki, reply, type TokiResponse } from "../ts";

const PORT = 3002;

interface User {
  readonly name: string;
  readonly age: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateUser(input: Record<string, unknown>): User | string[] {
  const errors: string[] = [];
  const { name, age } = input;
  if (typeof name !== "string" || name.trim().length === 0) {
    errors.push("name must be a non-empty string");
  }
  if (typeof age !== "number" || !Number.isInteger(age) || age < 0) {
    errors.push("age must be a non-negative integer");
  }
  return errors.length > 0 ? errors : { name: name as string, age: age as number };
}

const app = new Toki();

app.post("/users", (req): TokiResponse => {
  let payload: unknown;
  try {
    payload = req.json();
  } catch {
    return reply.json({ error: "invalid JSON body" }, { status: 400 });
  }
  // req.json() asserts no shape, so a bare null/array/primitive is a clean 400 here
  // rather than a TypeError (500) inside validateUser.
  if (!isRecord(payload)) {
    return reply.json({ error: "expected a JSON object" }, { status: 400 });
  }

  const result = validateUser(payload);
  if (Array.isArray(result)) {
    return reply.json({ error: "validation failed", details: result }, { status: 400 });
  }
  return reply.json({ created: result }, { status: 201 });
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
