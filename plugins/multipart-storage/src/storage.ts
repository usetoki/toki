import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

/** A file part handed to a {@link Storage}. `data` is a view into the request buffer. */
export interface IncomingFile {
  readonly field: string;
  readonly filename: string;
  readonly contentType: string;
  readonly data: Uint8Array;
}

/** A destination for uploaded files. Return whatever reference your app needs (a path, an S3 key, a URL). */
export interface Storage<T = unknown> {
  store(file: IncomingFile): Promise<T>;
}

export interface DiskFile {
  readonly field: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly path: string;
}

export interface DiskStorageOptions {
  /** Directory to write files into. */
  dir: string;
  /** Name a stored file. Default: a random hex name keeping the original extension. */
  filename?: (file: IncomingFile) => string;
}

/**
 * Write each part to a directory. The default name is random (the client's filename is
 * never trusted as a path), and the resolved target is confined to `dir` so a crafted
 * name can't escape it.
 */
export function diskStorage(options: DiskStorageOptions): Storage<DiskFile> {
  const dir = resolve(options.dir);
  return {
    async store(file) {
      const name = options.filename
        ? options.filename(file)
        : randomBytes(12).toString("hex") + safeExt(file.filename);
      const path = resolve(dir, name);
      if (path !== dir && !path.startsWith(dir + sep)) {
        throw new Error("disk storage: the filename escapes the storage directory");
      }
      await writeFile(path, file.data);
      return {
        field: file.field,
        filename: file.filename,
        contentType: file.contentType,
        size: file.data.byteLength,
        path,
      };
    },
  };
}

function safeExt(filename: string): string {
  const ext = extname(filename);
  return /^\.[A-Za-z0-9.]{1,16}$/.test(ext) ? ext : "";
}
