import type { DocPage } from "../../types";

export const http2Page: DocPage = {
  slug: "http2",
  title: "HTTP/2",
  description: "Multiplexing, flow control, and HPACK in the native engine — handlers unchanged.",
  blocks: [
    {
      kind: "paragraph",
      text: "Set `http2: true` on `listen` and toki serves HTTP/2. Over TLS it is negotiated with ALPN (`h2`); a client that doesn't offer h2 keeps HTTP/1.1 on the same port. In cleartext it accepts the h2c prior-knowledge preface. Frame parsing, stream multiplexing, flow control, and HPACK header compression all run in Zig — your routes, hooks, and `reply` builders are identical to HTTP/1.1.",
    },
    {
      kind: "code",
      snippet: {
        filename: "http2.ts",
        language: "ts",
        code: `import { readFileSync } from "node:fs";
import { createApp, reply } from "@usetoki/toki";

const app = createApp();
app.get("/", () => reply.text("hello over http/2"));
app.get("/users/:id", (req) => reply.json({ id: req.params.id }));

app.listen(443, {
  http2: true,
  tls: { cert: readFileSync("fullchain.pem"), key: readFileSync("privkey.pem") },
});`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Use TLS. Browsers only speak HTTP/2 over TLS, and ALPN picks h2 automatically. The cleartext h2c path exists for service-to-service calls and tooling (`curl --http2-prior-knowledge`, gRPC-style clients).",
    },
    { kind: "heading", id: "negotiation", text: "How it's selected" },
    {
      kind: "table",
      headers: ["Transport", "Selection"],
      rows: [
        ["TLS (`tls` + `http2`)", "ALPN offers `h2, http/1.1`; an h2 client gets HTTP/2, anyone else gets HTTP/1.1 — same port, same routes."],
        ["Cleartext, multiplex (default)", "A connection that opens with the HTTP/2 preface is served as h2c; everything else stays HTTP/1.1, on the same port."],
        ["Cleartext, exclusive (`http2Cleartext: \"exclusive\"`)", "h2c only — a connection that doesn't open with the preface gets a `GOAWAY` and is closed. For prior-knowledge-only deployments (gRPC, pure-h2 internal services)."],
      ],
    },
    {
      kind: "paragraph",
      text: "The decision is made once, at the start of the connection. Because cleartext h2c shares the port with HTTP/1.1 by default, the upgrade is by prior knowledge only — there is no `Upgrade: h2c` dance. Choose `exclusive` when the port should speak nothing but HTTP/2.",
    },
    { kind: "heading", id: "same-handlers", text: "Same handlers, same features" },
    {
      kind: "paragraph",
      text: "An HTTP/2 request is shaped into the exact same request object the HTTP/1.1 path builds, then dispatched through the same pipeline. So everything composes unchanged:",
    },
    {
      kind: "list",
      items: [
        "Routing, params, query, groups, the not-found handler.",
        "Every hook and middleware, sync or async.",
        "`reply.json` / `text` / `html` / `bytes`, and async (`Promise`) handlers.",
        "Streaming responses (`reply.stream`, SSE) — each chunk becomes a DATA frame under flow control.",
        "Static files (`app.static`) with ETag, `304`, and gzip/brotli negotiation.",
        "The `:authority` pseudo-header is exposed as `req.hostname`; split `cookie` fields are rejoined for `req.cookies`.",
      ],
    },
    { kind: "heading", id: "multiplexing", text: "Multiplexing and flow control" },
    {
      kind: "paragraph",
      text: "Many requests share one connection as independent streams; a slow handler never blocks the others. Both connection- and stream-level flow control are enforced in native code: large uploads are admitted under a receive window that is replenished with `WINDOW_UPDATE`, and large responses are sent within the peer's window, buffering the remainder until it opens.",
    },
    { kind: "heading", id: "options", text: "Options" },
    {
      kind: "table",
      headers: ["Option", "Default", "Meaning"],
      rows: [
        ["`http2`", "`false`", "Enable HTTP/2 (ALPN over TLS, h2c in cleartext)."],
        ["`http2Cleartext`", "`\"multiplex\"`", "Cleartext mode: `\"multiplex\"` shares the port with HTTP/1.1; `\"exclusive\"` serves h2c only. Ignored over TLS."],
        ["`http2InitialWindow`", "256 KiB", "Per-stream receive window we advertise (`SETTINGS_INITIAL_WINDOW_SIZE`); also the connection window we raise to. Larger lifts upload throughput at some memory cost."],
        ["`http2MaxConcurrentStreams`", "128", "`SETTINGS_MAX_CONCURRENT_STREAMS` — caps simultaneous streams per connection, the main per-connection memory bound."],
      ],
    },
    {
      kind: "paragraph",
      text: "These sit alongside `tls`, `maxBodyBytes`, `rateLimit`, and the rest on the same `listen` options object. `maxBodyBytes` still bounds a request body; an h2 upload that exceeds it gets a `413` followed by a graceful stream cancel.",
    },
    { kind: "heading", id: "safety", text: "Hardening" },
    {
      kind: "paragraph",
      text: "The engine bounds every peer-controlled resource: concurrent streams, the header-list size (with a CONTINUATION-flood guard), the dynamic HPACK table, the per-stream send buffer, and the aggregate in-flight request body per connection. A reset-without-progress flood (CVE-2023-44487) trips a `GOAWAY`, while a well-behaved client that cancels many streams over time is never throttled. With `headerTimeoutMs` set, a connection stalled mid-request — a partial frame or a stream that never finishes its body — is swept closed. Protocol violations map to the correct scope: a malformed request resets just its stream, a connection-level fault sends `GOAWAY` and closes. The engine passes the full h2spec conformance suite (146/146 as a dedicated h2c server) and survives a frame/HPACK fuzzer, all under a memory-checked build.",
    },
    {
      kind: "callout",
      tone: "note",
      text: "There is no TLS session resumption and no server push (clients have largely abandoned push). HTTP/2 over TLS still runs a full TLS 1.3 handshake per connection.",
    },
    { kind: "heading", id: "scope", text: "One server per process" },
    {
      kind: "paragraph",
      text: "Same rule as the rest of toki: the native engine holds one listening socket per process. Run more processes (or workers) with `reusePort: true` to use more cores; HTTP/2's multiplexing means each process already serves many concurrent requests per connection.",
    },
  ],
};
