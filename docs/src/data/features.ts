import type { Feature } from "../types";

export const FEATURES: readonly Feature[] = [
  {
    icon: "⚡",
    title: "Native engine",
    description:
      "HTTP/1.1 parsing, routing, and I/O run in Zig on Node's own libuv loop. Handlers are called synchronously, with no thread hop.",
  },
  {
    icon: "🔌",
    title: "Raw TCP",
    description:
      "createTcpServer opens a libuv-backed listener for your own wire protocol: pooled connections, real backpressure, half-close, low memory.",
  },
  {
    icon: "🔐",
    title: "TLS 1.3 & mTLS",
    description:
      "Native TLS 1.3 termination (ECDHE + AEAD) for HTTPS and raw TCP, no reverse proxy, with mutual-TLS client certificates on raw sockets.",
  },
  {
    icon: "📡",
    title: "UDP, secured",
    description:
      "createUdpServer for datagrams, plus per-packet AES-256-GCM under a shared key or a Noise-XX session with mutual auth and forward secrecy.",
  },
  {
    icon: "🔭",
    title: "WebSockets",
    description:
      "Full RFC 6455 in native code: framing, masking, fragmentation, ping/pong, close codes, subprotocols, and permessage-deflate.",
  },
  {
    icon: "🧩",
    title: "Fully typed API",
    description:
      "A clean, strict TypeScript surface: routes, hooks, middleware, plugins, and schemas, with real editor autocompletion and no any.",
  },
  {
    icon: "🗜️",
    title: "Compression",
    description:
      "Dynamic gzip + brotli negotiated per Accept-Encoding, plus pre-computed encodings for static assets — off the event loop.",
  },
  {
    icon: "🗂️",
    title: "Static files",
    description:
      "MIME, ETag / 304, HEAD, range-safe serving with pre-built gzip/brotli variants, all resolved in native code.",
  },
  {
    icon: "🌊",
    title: "Streaming",
    description:
      "reply.stream over chunked transfer encoding with native backpressure, so producers pause when the socket fills.",
  },
  {
    icon: "🛡️",
    title: "Hardened",
    description:
      "Schema validation, JWT, a native per-IP rate limiter, a slowloris guard, and request-smuggling protection by default.",
  },
  {
    icon: "🪶",
    title: "Tiny footprint",
    description:
      "A single-threaded server in ~49 MB RSS, roughly half of node:http, with no worker threads and no thread-safe function shims.",
  },
  {
    icon: "🧪",
    title: "Testable",
    description:
      "app.inject() runs a real request in-process over loopback, so the full native path is exercised without binding a public port.",
  },
];
