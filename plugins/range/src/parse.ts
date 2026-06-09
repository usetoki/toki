/** A resolved byte range (inclusive), `"invalid"` for an unsatisfiable one, or `null` to serve the whole entity. */
export type RangeSpec = { readonly start: number; readonly end: number } | "invalid" | null;

/**
 * Parse a `Range` header against the entity `size`. Supports a single `bytes=` range in
 * all three forms: `start-end`, `start-`, `-suffix`. Anything else (a multi-range
 * request, a malformed value) returns `null` and the caller serves the full entity, which
 * is always a valid response to a Range request.
 */
export function parseRange(header: string, size: number): RangeSpec {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;

  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "" && endText === "") return null;

  let start: number;
  let end: number;
  if (startText === "") {
    const suffix = Number(endText);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText === "" ? size - 1 : Math.min(Number(endText), size - 1);
  }

  if (size === 0 || start > end || start >= size) return "invalid";
  return { start, end };
}
