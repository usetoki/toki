import type { DocPage } from "../../types";

export const cookiePluginPage: DocPage = {
  slug: "plugin-cookie",
  title: "Cookie",
  description: "Signed and encrypted cookies — HMAC + AES-256-GCM with key rotation.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-cookie` adds tamper-proof and encrypted cookie values on top of toki's built-in `req.setCookie` / `req.cookies`. It's the crypto base the session plugins use, and handy on its own.",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-cookie`,
      },
    },
    {
      kind: "code",
      snippet: {
        filename: "cookie.ts",
        language: "ts",
        code: `import { createCookies } from "@usetoki/toki-cookie";

const cookies = createCookies({ secret: process.env.COOKIE_SECRET! }); // >= 16 bytes

app.get("/login", (req) => {
  req.setCookie("uid", cookies.sign("user-42"), { httpOnly: true, sameSite: "Lax" });
  return "ok";
});

app.get("/me", (req) => {
  const uid = cookies.unsign(req.cookies.uid ?? ""); // string, or null if tampered
  return { uid };
});`,
      },
    },
    {
      kind: "list",
      items: [
        "`sign` / `unsign` — HMAC-SHA256; the value stays readable, the tag proves integrity.",
        "`seal` / `unseal` — AES-256-GCM; the cookie is opaque. `unseal` returns `null` on tamper.",
        "`unsign` / `unseal` return `null` for a missing, tampered, or unknown-key cookie — never throw.",
      ],
    },
    { kind: "heading", id: "rotation", text: "Key rotation" },
    {
      kind: "paragraph",
      text: "Pass an array of secrets — the first signs/encrypts new cookies, the rest are still accepted, so you can roll a secret out without invalidating live cookies.",
    },
    {
      kind: "code",
      snippet: {
        filename: "rotate.ts",
        language: "ts",
        code: `createCookies({ secret: [newSecret, oldSecret] });`,
      },
    },
  ],
};
