import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { reply } from "@usetoki/toki";
import type { TokiResponse } from "@usetoki/toki";
import type { Renderer, ViewEngine } from "./engine.ts";

export interface ViewOptions {
  engine: ViewEngine;
  /** Directory templates are resolved against. */
  root: string;
  /** Extension appended to a name without one, e.g. `".eta"`. Default `""`. */
  ext?: string;
  /** Cache compiled templates. Default `true`; set `false` in development to pick up edits. */
  cache?: boolean;
  /** Response content type. Default `"text/html; charset=utf-8"`. */
  contentType?: string;
  /** Data merged into every render — site name, helpers, the active user, etc. */
  locals?: Record<string, unknown>;
}

/** Render `template` with `data` into an HTML response. */
export type View = (template: string, data?: Record<string, unknown>) => Promise<TokiResponse>;

const encoder = new TextEncoder();

/**
 * Build a `view(template, data)` renderer over a template directory. Templates are read
 * and compiled once (cached by resolved path), then rendered with `locals` + `data`. The
 * template name is confined to `root`, so a value like `"../secrets"` can't escape it.
 */
export function createView(options: ViewOptions): View {
  const root = resolve(options.root);
  const realRoot = realRootOf(root);
  const ext = options.ext ?? "";
  const useCache = options.cache !== false;
  const contentType = options.contentType ?? "text/html; charset=utf-8";
  const locals = options.locals ?? {};
  // cache the compile *promise* so concurrent first-hits compile once, not N times
  const compiled = new Map<string, Promise<Renderer>>();

  return async (template, data = {}) => {
    const path = templatePath(root, realRoot, template, ext);
    let pending = useCache ? compiled.get(path) : undefined;
    if (pending === undefined) {
      pending = readFile(path, "utf8").then((source) => options.engine.compile(source, path));
      if (useCache) compiled.set(path, pending);
    }
    let render: Renderer;
    try {
      render = await pending;
    } catch (error) {
      if (useCache) compiled.delete(path); // don't pin a failed read/compile
      throw error;
    }
    const html = await render({ ...locals, ...data });
    return reply.bytes(encoder.encode(html), contentType);
  };
}

function realRootOf(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

function templatePath(root: string, realRoot: string, template: string, ext: string): string {
  const name = ext && !template.endsWith(ext) ? template + ext : template;
  const path = resolve(root, name);
  if (path !== root && !path.startsWith(root + sep)) {
    throw new Error(`view: template "${template}" escapes the root directory`);
  }
  // resolve symlinks too, so a link inside root can't point outside it
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return path; // doesn't exist — let readFile produce the missing-template error
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new Error(`view: template "${template}" resolves outside the root directory`);
  }
  return path;
}
