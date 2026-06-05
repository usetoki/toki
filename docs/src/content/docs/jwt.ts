import type { DocPage } from "../../types";

export const jwtPage: DocPage = {
  slug: "jwt",
  title: "JWT authentication",
  description: "Sign and verify JSON Web Tokens and guard routes with jwtAuth.",
  blocks: [
    {
      kind: "paragraph",
      text: "Toki ships JWT helpers: `signJwt` and `verifyJwt` for tokens, and `jwtAuth` — a middleware that verifies the `Authorization: Bearer` token and attaches the payload to the request.",
    },
    {
      kind: "code",
      snippet: {
        filename: "sign.ts",
        language: "ts",
        code: `import { signJwt, verifyJwt } from "@usetoki/toki";

const token = signJwt(
  { sub: "user-1", role: "admin" },
  { secret: process.env.JWT_SECRET!, expiresIn: "1h", algorithm: "HS256" },
);

const payload = verifyJwt(token, { secret: process.env.JWT_SECRET! });`,
      },
    },
    { kind: "heading", id: "guard", text: "Guarding routes" },
    {
      kind: "paragraph",
      text: "`jwtAuth(options)` rejects requests without a valid token (`401`) and decorates the request with the payload for downstream handlers.",
    },
    {
      kind: "code",
      snippet: {
        filename: "guard.ts",
        language: "ts",
        code: `import { jwtAuth } from "@usetoki/toki";

app.group("/api", (api) => {
  api.use(jwtAuth({ secret: process.env.JWT_SECRET! }));
  api.get("/me", (req) => reply.json(req.user)); // payload attached by jwtAuth
});`,
      },
    },
    { kind: "heading", id: "errors", text: "Errors" },
    {
      kind: "paragraph",
      text: "`verifyJwt` throws a `JwtError` on a malformed, expired, or invalid token. Catch it to shape your own response, or let `jwtAuth` turn it into a `401`.",
    },
    {
      kind: "callout",
      tone: "warning",
      text: "Keep your secret out of source control — read it from the environment. Tokens are signed, not encrypted; never put secrets in the payload.",
    },
  ],
};
