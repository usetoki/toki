/** One parsed part. `data` is a view into the request buffer — no copy is made. */
export interface RawPart {
  readonly name: string;
  readonly filename: string | null;
  readonly contentType: string;
  readonly data: Uint8Array;
}

const DASH_DASH = 0x2d;
const CR = 0x0d;
const LF = 0x0a;

/**
 * Iterate the parts of a `multipart/form-data` body. Each part's `data` is a subarray of
 * the original buffer, so a part is handed off (e.g. written to storage) without being
 * copied into a new allocation first.
 */
export function* parts(body: Uint8Array, boundary: string): Generator<RawPart> {
  const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const opening = Buffer.from(`--${boundary}`);
  // A part's data ends at the next CRLF-prefixed boundary. Requiring the leading CRLF means
  // boundary bytes that appear inside a binary file (with no preceding CRLF) can't false-match.
  const separator = Buffer.from(`\r\n--${boundary}`);

  let pos = buf.indexOf(opening);
  if (pos === -1) return;
  pos += opening.length;

  while (pos < buf.length) {
    if (buf[pos] === DASH_DASH && buf[pos + 1] === DASH_DASH) break; // closing boundary
    if (buf[pos] === CR && buf[pos + 1] === LF) pos += 2;

    const headerEnd = buf.indexOf("\r\n\r\n", pos);
    if (headerEnd === -1) break;
    const headerText = buf.toString("utf8", pos, headerEnd);
    const dataStart = headerEnd + 4;

    const next = buf.indexOf(separator, dataStart);
    if (next === -1) break;
    const data = buf.subarray(dataStart, next); // separator owns the trailing CRLF

    const filename = /filename="([^"]*)"/i.exec(headerText);
    yield {
      name: /name="([^"]*)"/i.exec(headerText)?.[1] ?? "",
      filename: filename ? (filename[1] ?? "") : null,
      contentType:
        /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1] ?? "application/octet-stream",
      data,
    };
    pos = next + separator.length;
  }
}
