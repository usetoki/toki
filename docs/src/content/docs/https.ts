import type { DocPage } from "../../types";

export const httpsPage: DocPage = {
  slug: "https",
  title: "HTTPS / TLS",
  description: "Terminate TLS directly in the native engine — no reverse proxy needed.",
  blocks: [
    {
      kind: "paragraph",
      text: "Pass a PEM certificate chain and private key as `tls` to `listen` and toki terminates HTTPS in the native engine — handshake, encryption, and decryption all run in Zig. No nginx or Caddy in front required.",
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
      text: "`cert` and `key` accept a PEM string or a `Buffer`/`Uint8Array`. With Let's Encrypt that's `fullchain.pem` and `privkey.pem` straight from certbot.",
    },
    { kind: "heading", id: "supported", text: "What's negotiated" },
    {
      kind: "table",
      headers: ["", ""],
      rows: [
        ["Protocols", "TLS 1.3 and TLS 1.2"],
        ["Ciphers", "AEAD only — AES-GCM and ChaCha20-Poly1305"],
        ["Key exchange", "ECDHE (forward secrecy)"],
        ["Server keys", "RSA and EC (ECDSA)"],
        ["ALPN", "`http/1.1`"],
        ["SNI", "supported"],
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "HTTP/2 is intentionally out of scope. ALPN advertises `http/1.1`; if you need h2, put it behind a reverse proxy.",
    },
    { kind: "heading", id: "wss", text: "WebSockets over TLS (wss)" },
    {
      kind: "paragraph",
      text: "Nothing extra to do — the same `app.ws` route serves `wss://` once TLS is on. Frames are encrypted on the same connection.",
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
      text: "Streaming responses (`reply.stream`) and static files (`app.static`) ride over TLS unchanged — every byte the engine sends is encrypted at the single write path, so no feature needs to know about TLS.",
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Behind a TLS-terminating proxy instead? Leave `tls` off and set `X-Forwarded-Proto` at the proxy. Direct TLS is for proxy-less, single-server deploys.",
    },
  ],
};
