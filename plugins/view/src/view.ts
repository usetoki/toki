import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { reply } from "@usetoki/toki";
import type { TokiResponse } from "@usetoki/toki";
import type { Renderer, ViewEngine } from "./engine.js";

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
  const ext = options.ext ?? "";
  const useCache = options.cache !== false;
  const contentType = options.contentType ?? "text/html; charset=utf-8";
  const locals = options.locals ?? {};
  const compiled = new Map<string, Renderer>();

  return async (template, data = {}) => {
    const path = templatePath(root, template, ext);
    let render = useCache ? compiled.get(path) : undefined;
    if (render === undefined) {
      render = options.engine.compile(await readFile(path, "utf8"), path);
      if (useCache) compiled.set(path, render);
    }
    const html = await render({ ...locals, ...data });
    return reply.bytes(encoder.encode(html), contentType);
  };
}

function templatePath(root: string, template: string, ext: string): string {
  const name = ext && !template.endsWith(ext) ? template + ext : template;
  const path = resolve(root, name);
  if (path !== root && !path.startsWith(root + sep)) {
    throw new Error(`view: template "${template}" escapes the root directory`);
  }
  return path;
}
