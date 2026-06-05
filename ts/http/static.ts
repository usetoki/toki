import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import type { StaticEntry } from "../native/native.js";

/** Options for {@link Toki.static}. */
export interface StaticOptions {
  /** `Cache-Control` for served files. Default `"public, max-age=3600"`. */
  cacheControl?: string;
  /** Index file served for a directory URL, or `false` to disable. Default `"index.html"`. */
  index?: string | false;
  /** Skip files larger than this many bytes (they stay in memory). Default 50 MiB. */
  maxFileBytes?: number;
  /** Pre-compress compressible files. Default `true`. */
  compress?: boolean;
  /** Only compress files at least this many bytes. Default 1024. */
  compressMinBytes?: number;
  /** gzip level (0–9). Default 9 (best — computed once at startup). */
  gzipLevel?: number;
  /** brotli quality (0–11). Default 11 (best — computed once at startup). */
  brotliQuality?: number;
}

const DEFAULTS = {
  cacheControl: "public, max-age=3600",
  index: "index.html" as string | false,
  maxFileBytes: 50 * 1024 * 1024,
  compress: true,
  compressMinBytes: 1024,
  gzipLevel: 9,
  brotliQuality: 11,
};

// startup compression hint only; actual MIME is resolved natively
const COMPRESSIBLE_EXTS = new Set([
  "html",
  "htm",
  "css",
  "js",
  "mjs",
  "cjs",
  "json",
  "jsonld",
  "webmanifest",
  "map",
  "xml",
  "xhtml",
  "xsl",
  "svg",
  "svgz",
  "txt",
  "md",
  "markdown",
  "csv",
  "ics",
  "wasm",
  "atom",
  "rss",
]);

/** Builds static entries for `dir` served under `urlPrefix`; files read into memory once and pre-compressed at startup. */
export function buildStaticEntries(
  urlPrefix: string,
  dir: string,
  options: StaticOptions = {},
): StaticEntry[] {
  const config = { ...DEFAULTS, ...options };
  const prefix = urlPrefix.endsWith("/") ? urlPrefix.slice(0, -1) : urlPrefix;
  const entries: StaticEntry[] = [];

  for (const abs of walk(dir)) {
    const stats = statSync(abs);
    if (stats.size > config.maxFileBytes) {
      continue;
    }
    const rel = relative(dir, abs).split(sep).join("/");
    const url = `${prefix}/${rel}`;
    const body = readFileSync(abs);
    const ext = extname(abs).slice(1).toLowerCase();
    const variants = compressFile(ext, body, config);
    const entry: StaticEntry = {
      path: url,
      body,
      mtimeMs: stats.mtimeMs,
      cacheControl: config.cacheControl,
      ...variants,
    };
    entries.push(entry);

    // index file also answers its dir URL, with and without trailing slash
    if (config.index && abs.endsWith(`${sep}${config.index}`)) {
      const dirUrl = url.slice(0, url.length - (config.index.length + 1)) || "/";
      entries.push({ ...entry, path: dirUrl });
      if (dirUrl !== "/") {
        entries.push({ ...entry, path: `${dirUrl}/` });
      }
    }
  }

  return entries;
}

// gzip/brotli variants; drop any that don't actually shrink the body
function compressFile(
  ext: string,
  body: Buffer,
  config: typeof DEFAULTS,
): Pick<StaticEntry, "gzip" | "brotli"> {
  if (!config.compress || !COMPRESSIBLE_EXTS.has(ext) || body.length < config.compressMinBytes) {
    return {};
  }
  const out: { gzip?: Uint8Array; brotli?: Uint8Array } = {};
  const gzip = gzipSync(body, { level: config.gzipLevel });
  if (gzip.length < body.length) {
    out.gzip = gzip;
  }
  const brotli = brotliCompressSync(body, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: config.brotliQuality,
      [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
    },
  });
  if (brotli.length < body.length) {
    out.brotli = brotli;
  }
  return out;
}

function* walk(dir: string): Generator<string> {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, item.name);
    if (item.isDirectory()) {
      yield* walk(abs);
    } else if (item.isFile()) {
      yield abs;
    }
  }
}
