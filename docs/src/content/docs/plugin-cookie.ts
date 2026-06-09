import type { DocPage } from "../../types";

export const cookiePluginPage: DocPage = {
  slug: "plugin-cookie",
  title: "Cookie",
  description: "Signed and encrypted cookies — HMAC + AES-256-GCM with key rotation.",
  blocks: [
    {
      kind: "paragraph",
      text: "toki core already gives you `req.setCookie` / `req.cookies` for plain cookies. `@usetoki/toki-cookie` adds the crypto: sign a value so the client can't tamper with it, or seal it so the client can't even read it. It's the base the session plugins are built on, and it's useful on its own for things like a signed `uid` or an encrypted feature flag.",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-cookie`,
      },
    },

    { kind: "heading", id: "sign", text: "Sign — tamper-proof, still readable" },
    {
      kind: "paragraph",
      text: "`sign` HMACs the value and appends the tag. The value stays plain in the cookie (anyone can read it) but `unsign` rejects anything that's been altered. Use it when the value isn't secret but must be trusted, like a user id.",
    },
    {
      kind: "code",
      snippet: {
        filename: "sign.ts",
        language: "ts",
        code: `import { createApp, reply } from "@usetoki/toki";
import { createCookies } from "@usetoki/toki-cookie";

const cookies = createCookies({ secret: process.env.COOKIE_SECRET! }); // >= 16 bytes

const app = createApp();

app.post("/login", (req) => {
  req.setCookie("uid", cookies.sign("user-42"), { httpOnly: true, sameSite: "Lax" });
  return reply.text("ok");
});

app.get("/me", (req) => {
  const uid = cookies.unsign(req.cookies.uid ?? ""); // "user-42", or null if tampered
  if (uid === null) return reply.status(401).text("unauthorized");
  return reply.json({ uid });
});`,
      },
    },

    { kind: "heading", id: "seal", text: "Seal — opaque, encrypted" },
    {
      kind: "paragraph",
      text: "`seal` encrypts with AES-256-GCM, so the cookie is an opaque blob the client can neither read nor forge. Reach for it when the value itself is sensitive.",
    },
    {
      kind: "code",
      snippet: {
        filename: "seal.ts",
        language: "ts",
        code: `const cookies = createCookies({ secret: process.env.COOKIE_SECRET! });

app.post("/checkout", (req) => {
  const cart = JSON.stringify({ items: 3, currency: "USD" });
  req.setCookie("cart", cookies.seal(cart), { httpOnly: true, secure: true });
  return reply.text("ok");
});

app.get("/cart", (req) => {
  const raw = cookies.unseal(req.cookies.cart ?? ""); // decrypted string, or null
  return reply.json(raw ? JSON.parse(raw) : { items: 0 });
});`,
      },
    },
    {
      kind: "list",
      items: [
        "`sign(value)` / `unsign(signed)` — HMAC-SHA256. The value stays readable; the tag proves integrity.",
        "`seal(value)` / `unseal(sealed)` — AES-256-GCM. The cookie is opaque.",
        "`unsign` / `unseal` return `null` for a missing, tampered, or unknown-key cookie — they never throw, so you always branch on the result.",
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "Signing and sealing keys are derived from your secret with HKDF. The secret is never used raw, and the sign/seal keys can't cross-contaminate. You still own the cookie attributes (`httpOnly`, `secure`, `sameSite`, `maxAge`) via `req.setCookie`.",
    },

    { kind: "heading", id: "rotation", text: "Key rotation" },
    {
      kind: "paragraph",
      text: "Pass an array of secrets. The first signs and encrypts new cookies; the rest are still accepted on the way in. So you roll a secret by prepending a new one, deploying, then dropping the oldest once the old cookies have aged out — no live session is invalidated mid-flight.",
    },
    {
      kind: "code",
      snippet: {
        filename: "rotate.ts",
        language: "ts",
        code: `// new cookies use newSecret; cookies signed/sealed with oldSecret still verify.
createCookies({ secret: [process.env.COOKIE_SECRET_NEW!, process.env.COOKIE_SECRET_OLD!] });`,
      },
    },

    { kind: "heading", id: "options", text: "Options" },
    {
      kind: "table",
      headers: ["Field", "Type", "Default", "Notes"],
      rows: [
        [
          "`secret`",
          "`string \\| string[] \\| Buffer \\| Buffer[]`",
          "—",
          "One or more secrets, each ≥ 16 bytes. First is current; the rest are accepted for rotation.",
        ],
      ],
    },
    {
      kind: "callout",
      tone: "warning",
      text: "A secret shorter than 16 bytes throws at `createCookies` time, not mid-request. Keep secrets in env/secret storage, never in the repo, and rotate them the moment one might have leaked.",
    },
  ],
};
