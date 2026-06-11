import type { DocPage } from "../../types";

export const httpsPage: DocPage = {
  slug: "https",
  title: "HTTPS / TLS",
  description: "Terminate TLS directly in the native engine — no reverse proxy needed.",
  blocks: [
    {
      kind: "paragraph",
      text: "Pass a PEM certificate chain and private key as `tls` to `listen` and toki terminates HTTPS in the native engine: handshake, encryption, and decryption all run in Zig. No nginx or Caddy in front required.",
    },
    {
      kind: "code",
      snippet: {
        filename: "https.ts",
        language: "ts",
        code: `import { readFileSync } from "node:fs";
import { createApp, reply } from "@usetoki/toki";

const app = createApp();
app.get("/", () => reply.text("hello over https"));

app.listen(443, {
  tls: {
    cert: readFileSync("fullchain.pem"), // leaf first, then any intermediates
    key: readFileSync("privkey.pem"),
  },
});`,
      },
    },
    {
      kind: "paragraph",
      text: "`cert` and `key` accept a PEM string or a `Buffer`/`Uint8Array`. With Let's Encrypt that's `fullchain.pem` and `privkey.pem` straight from certbot. This is the same TLS 1.3 engine the raw TCP server uses — server-authenticated only here. There is no client-certificate (mTLS) support on the HTTP server; for that, terminate TLS on the raw TCP server instead (see the TCP page).",
    },
    { kind: "heading", id: "supported", text: "What's negotiated" },
    {
      kind: "table",
      headers: ["", ""],
      rows: [
        ["Protocols", "TLS 1.3 only"],
        ["Ciphers", "AEAD only — AES-GCM and ChaCha20-Poly1305"],
        ["Key exchange", "ECDHE (forward secrecy)"],
        ["Server keys", "RSA and EC (ECDSA)"],
        ["Client auth", "None — server-authenticated only (mTLS lives on the raw TCP server)"],
        ["ALPN", "`http/1.1`, plus `h2` when [HTTP/2](/docs/http2) is enabled"],
        ["SNI", "supported"],
      ],
    },
    {
      kind: "callout",
      tone: "warning",
      text: "TLS 1.3 only. A client that offers nothing newer than TLS 1.2 is rejected at the handshake — there is no 1.2 fallback. Every current browser, curl, and `node`/`fetch` speaks 1.3, so this only bites ancient clients.",
    },
    {
      kind: "callout",
      tone: "note",
      text: "Want HTTP/2? Add `http2: true` alongside `tls` and ALPN negotiates `h2` automatically, falling back to HTTP/1.1 for older clients. See [HTTP/2](/docs/http2).",
    },
    { kind: "heading", id: "loading", text: "Loading the cert and key" },
    {
      kind: "paragraph",
      text: "Read the PEM from disk in production — point at certbot's output or your own pair. In a container you often inject the material as environment variables instead; pass the strings straight through.",
    },
    {
      kind: "code",
      snippet: {
        filename: "from-env.ts",
        language: "ts",
        code: `import { createApp, reply } from "@usetoki/toki";

const cert = process.env.TLS_CERT;
const key = process.env.TLS_KEY;
if (!cert || !key) throw new Error("TLS_CERT and TLS_KEY must be set");

const app = createApp();
app.get("/", () => reply.text("hello over https"));

app.listen(443, { tls: { cert, key } }); // PEM strings, no files needed`,
      },
    },
    { kind: "heading", id: "redirect", text: "Redirecting HTTP to HTTPS" },
    {
      kind: "paragraph",
      text: "Serve HTTPS on 443 and run a tiny plain-HTTP listener on 80 that 301-redirects every request to its HTTPS URL. `setNotFoundHandler` catches every path the redirect server has no route for (i.e. all of them), so one handler covers the whole site. Run it in its own process; there is one `listen` per process. `req.hostname` is the `Host` header without the port and `req.path` is the path without the query, so rebuild the target from those.",
    },
    {
      kind: "code",
      snippet: {
        filename: "redirect.ts",
        language: "ts",
        code: `import { createApp, reply } from "@usetoki/toki";

// plain HTTP on :80 — bounce everything to https on the same host
const redirect = createApp();
redirect.setNotFoundHandler((req) => {
  const query = req.query.toString();
  const path = query ? \`\${req.path}?\${query}\` : req.path;
  return reply.redirect(\`https://\${req.hostname}\${path}\`, 301);
});

redirect.listen(80); // no tls — this listener is intentionally plaintext`,
      },
    },
    {
      kind: "callout",
      tone: "note",
      text: "A 301 is cached hard by browsers — use it only once you're sure HTTPS is permanent. During a migration, pass `302` to `reply.redirect` so you can back out without clients pinning the redirect.",
    },
    {
      kind: "callout",
      tone: "note",
      text: "`tls` is one field on the `listen` options object — it sits alongside `rateLimit`, `host`, `wsCompression`, and the rest, so HTTPS composes with every other server option. Omitting `tls` serves plain HTTP on the same port.",
    },
    { kind: "heading", id: "wss", text: "WebSockets over TLS (wss)" },
    {
      kind: "paragraph",
      text: "Nothing extra to do: the same `app.ws` route serves `wss://` once TLS is on. Frames are encrypted on the same connection.",
    },
    {
      kind: "code",
      snippet: {
        filename: "wss.ts",
        language: "ts",
        code: `app.ws("/chat", (socket) => {
  socket.on("message", (data, isBinary) => socket.send(data));
});

app.listen(443, { tls: { cert, key } });

// client: const ws = new WebSocket("wss://example.com/chat");`,
      },
    },
    { kind: "heading", id: "everything", text: "Streaming and static files" },
    {
      kind: "paragraph",
      text: "Streaming responses (`reply.stream`) and static files (`app.static`) ride over TLS unchanged. Every byte the engine sends is encrypted at the single write path, so no feature needs to know about TLS.",
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Behind a TLS-terminating proxy instead? Leave `tls` off and set `X-Forwarded-Proto` at the proxy. Direct TLS is for proxy-less, single-server deploys.",
    },
  ],
};
