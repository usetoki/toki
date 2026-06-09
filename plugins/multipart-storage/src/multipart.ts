import type { TokiRequest } from "@usetoki/toki";
import { MultipartError } from "./errors.ts";
import { parts } from "./parser.ts";
import type { Storage } from "./storage.ts";

export interface MultipartOptions<T> {
  /** Where file parts are written. */
  storage: Storage<T>;
  /** Maximum number of files. Default `10`. */
  maxFiles?: number;
  /** Maximum bytes per file. Default `10485760` (10 MiB). */
  maxFileBytes?: number;
  /** Maximum number of non-file fields. Default `1000`. */
  maxFields?: number;
  /** Permitted content types — an exact (case-insensitive) list or a RegExp. */
  allowedTypes?: string[] | RegExp;
}

export interface ParsedUpload<T> {
  /** Non-file form fields. */
  fields: Record<string, string>;
  /** Whatever the storage returned for each stored file. */
  files: T[];
}

/**
 * Parse a `multipart/form-data` request: collect the plain fields and hand each file part
 * to `storage`, one at a time, as a view into the request buffer (no extra copy). Limits
 * are enforced as parts are read, so an oversized or disallowed upload is rejected with a
 * `MultipartError` before it reaches your storage.
 *
 * The request body is buffered by the engine up to `maxBodyBytes` (raise it in
 * `listen({ maxBodyBytes })` for large uploads).
 */
export async function multipart<T>(
  req: TokiRequest,
  options: MultipartOptions<T>,
): Promise<ParsedUpload<T>> {
  const boundary = /boundary=("?)([^";]+)\1/i.exec(req.headers.get("content-type") ?? "")?.[2];
  if (boundary === undefined || req.body === null) {
    throw new MultipartError(400, "expected a multipart/form-data body");
  }

  const maxFiles = options.maxFiles ?? 10;
  const maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024;
  const maxFields = options.maxFields ?? 1000;
  const fields: Record<string, string> = {};
  const files: T[] = [];
  let fieldCount = 0;

  for (const part of parts(req.body, boundary)) {
    if (part.filename === null) {
      if (++fieldCount > maxFields)
        throw new MultipartError(413, `too many fields (max ${maxFields})`);
      fields[part.name] = Buffer.from(part.data).toString("utf8");
      continue;
    }
    if (part.filename === "") continue; // empty file input, nothing was uploaded
    if (files.length >= maxFiles) throw new MultipartError(413, `too many files (max ${maxFiles})`);
    if (part.data.byteLength > maxFileBytes) {
      throw new MultipartError(413, `"${part.filename}" exceeds the ${maxFileBytes}-byte limit`);
    }
    if (!allowed(part.contentType, options.allowedTypes)) {
      throw new MultipartError(415, `content type "${part.contentType}" is not allowed`);
    }
    files.push(
      await options.storage.store({
        field: part.name,
        filename: part.filename,
        contentType: part.contentType,
        data: part.data,
      }),
    );
  }

  return { fields, files };
}

function allowed(contentType: string, types: string[] | RegExp | undefined): boolean {
  if (types === undefined) return true;
  if (types instanceof RegExp) return types.test(contentType);
  // compare the bare type, ignoring parameters like "; charset=utf-8"
  const lower = contentType.split(";")[0]!.trim().toLowerCase();
  return types.some((type) => type.toLowerCase() === lower);
}
