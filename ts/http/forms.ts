/** An uploaded file from a multipart form. */
export interface FormFile {
  readonly name: string;
  readonly filename: string;
  readonly contentType: string;
  readonly data: Uint8Array;
}

export interface ParsedForm {
  // repeated field name keeps the last value
  readonly fields: Record<string, string>;
  readonly files: ReadonlyArray<FormFile>;
}

/** Parse a request body by content type; null for unrecognized types. */
export function parseForm(contentType: string, body: Uint8Array): ParsedForm | null {
  const type = contentType.toLowerCase();
  if (type.startsWith("application/x-www-form-urlencoded")) {
    return parseUrlencoded(body);
  }
  if (type.startsWith("multipart/form-data")) {
    const boundary = /boundary=("?)([^";]+)\1/i.exec(contentType)?.[2];
    return boundary ? parseMultipart(body, boundary) : { fields: {}, files: [] };
  }
  return null;
}

function parseUrlencoded(body: Uint8Array): ParsedForm {
  const params = new URLSearchParams(Buffer.from(body).toString("utf8"));
  const fields: Record<string, string> = {};
  for (const [name, value] of params) {
    fields[name] = value;
  }
  return { fields, files: [] };
}

const DASH_DASH = Buffer.from("--");
const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");

function parseMultipart(body: Uint8Array, boundary: string): ParsedForm {
  const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const opening = Buffer.from(`--${boundary}`);
  // A part's data ends at the next CRLF-prefixed boundary. Requiring the leading CRLF means
  // boundary bytes that appear inside a binary part (with no preceding CRLF) can't false-match.
  const separator = Buffer.from(`\r\n--${boundary}`);
  const fields: Record<string, string> = {};
  const files: FormFile[] = [];

  let pos = buf.indexOf(opening);
  if (pos === -1) return { fields, files };
  pos += opening.length;

  while (pos < buf.length) {
    // trailing `--` marks the final boundary
    if (buf[pos] === DASH_DASH[0] && buf[pos + 1] === DASH_DASH[1]) {
      break;
    }
    if (buf[pos] === CRLF[0] && buf[pos + 1] === CRLF[1]) {
      pos += 2;
    }
    const headerEnd = buf.indexOf(HEADER_END, pos);
    if (headerEnd === -1) {
      break;
    }
    const headerText = buf.toString("utf8", pos, headerEnd);
    const dataStart = headerEnd + HEADER_END.length;
    const next = buf.indexOf(separator, dataStart);
    if (next === -1) {
      break;
    }
    const data = buf.subarray(dataStart, next); // separator owns the trailing CRLF

    const name = /name="([^"]*)"/i.exec(headerText)?.[1] ?? "";
    const filename = /filename="([^"]*)"/i.exec(headerText)?.[1];
    if (filename !== undefined) {
      const contentType =
        /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1] ?? "application/octet-stream";
      files.push({ name, filename, contentType, data: new Uint8Array(data) });
    } else {
      fields[name] = data.toString("utf8");
    }
    pos = next + separator.length;
  }
  return { fields, files };
}
