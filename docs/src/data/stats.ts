import type { Stat } from "../types";

export const STATS: readonly Stat[] = [
  { value: "~99k", label: "req/s, plaintext" },
  { value: "~49 MB", label: "RSS, single thread" },
  { value: "11", label: "prebuilt platforms" },
  { value: "0", label: "runtime dependencies" },
];
