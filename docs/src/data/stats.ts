import type { Stat } from "../types";

// Measured on loopback (Apple silicon) with real node:net / node:dgram / node:tls clients —
// the same harness shipped in the bench app. TCP/TLS figures are single-connection echo.
export const STATS: readonly Stat[] = [
  { value: "2.5 GB/s", label: "TCP throughput" },
  { value: "1.35 GB/s", label: "TLS 1.3 throughput" },
  { value: "~99k", label: "HTTP req/s, plaintext" },
  { value: "32k", label: "TCP accepts/sec" },
  { value: "0.03 ms", label: "round-trip p50" },
  { value: "~49 MB", label: "RSS, single thread" },
  { value: "11", label: "prebuilt platforms" },
  { value: "0", label: "runtime dependencies" },
];
