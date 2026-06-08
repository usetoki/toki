import type { BoundaryRow } from "../types";

export const BOUNDARY_ROWS: readonly BoundaryRow[] = [
  {
    capability: "HTTP/1.1 parsing",
    where: "Native (Zig)",
    note: "Zero-copy head parser on the read buffer",
  },
  {
    capability: "Routing",
    where: "Native (Zig)",
    note: "O(1) exact map + dynamic :param / * matching",
  },
  {
    capability: "Static files",
    where: "Native (Zig)",
    note: "MIME, ETag, gzip/brotli, served without JS",
  },
  {
    capability: "Compression",
    where: "Native (Zig)",
    note: "Negotiated per Accept-Encoding on the threadpool",
  },
  {
    capability: "WebSocket frames",
    where: "Native (Zig)",
    note: "Masking, fragmentation, validation in Zig",
  },
  {
    capability: "TLS 1.3 termination",
    where: "Native (Zig)",
    note: "Handshake + record layer for HTTPS and raw TCP, incl. mTLS",
  },
  {
    capability: "TCP / UDP sockets",
    where: "Native (Zig)",
    note: "libuv accept loop, backpressure, record-batched reads",
  },
  {
    capability: "Query / headers / JSON",
    where: "TypeScript",
    note: "V8 primitives beat ~20 N-API calls per request",
  },
  {
    capability: "Handler pipeline",
    where: "TypeScript",
    note: "Hooks, middleware, plugins, error handling",
  },
  {
    capability: "Schema validation",
    where: "TypeScript",
    note: "Custom messages, response serialization",
  },
  {
    capability: "Secure-UDP crypto",
    where: "TypeScript",
    note: "Per-datagram AES-256-GCM and Noise-XX sessions",
  },
];
