import { readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { Handler, PluginOptions, RouteMethod, TokiInstance, TokiPlugin } from "@usetoki/toki";
import { joinPrefix, routePrefix } from "./route-path.js";

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

export interface AutoloadOptions {
  /** Directory of route modules to load. */
  dir: string;
  /** Base prefix prepended to every derived route. Default `"/"`. */
  prefix?: string;
  /** File extensions to load. Default `[".js", ".mjs"]`. */
  extensions?: string[];
  /** Skip a file (given its path relative to `dir`). Default: dotfiles, `_*`, tests, `.d.ts`. */
  ignore?: (relativePath: string) => boolean;
  /** Options handed to a module that default-exports a plugin. */
  options?: PluginOptions;
}

/**
 * Register a directory tree of route modules. A file maps to a URL by its path —
 * `users/index.ts` → `/users`, `users/[id].ts` → `/users/:id`, `files/[...p].ts` →
 * `/files/*`. A module exports one handler per method (`export const get = …`,
 * `export const post = …`), or a `default` plugin `(instance, opts) => void` for routes
 * that need their own hooks. Files load in sorted order for deterministic registration.
 */
export async function autoload(instance: TokiInstance, options: AutoloadOptions): Promise<void> {
  const extensions = options.extensions ?? [".js", ".mjs"];
  const ignore = options.ignore ?? defaultIgnore;
  const base = options.prefix ?? "/";

  const files = (await walk(options.dir))
    .map((file) => ({ file, rel: relative(options.dir, file) }))
    .filter(({ file, rel }) => extensions.some((ext) => file.endsWith(ext)) && !ignore(rel))
    .sort((a, b) => a.rel.localeCompare(b.rel));

  for (const { file, rel } of files) {
    const module = (await import(pathToFileURL(file).href)) as Record<string, unknown> & {
      default?: TokiPlugin;
    };
    const path = joinPrefix(base, routePrefix(rel));

    if (typeof module.default === "function") {
      instance.register(module.default, { ...options.options, prefix: path });
      continue;
    }

    let registered = 0;
    for (const method of METHODS) {
      const handler = module[method];
      if (typeof handler === "function") {
        instance.route(method.toUpperCase() as RouteMethod, path, handler as Handler);
        registered += 1;
      }
    }
    if (registered === 0) {
      throw new Error(
        `autoload: ${rel} exports neither a default plugin nor a method handler (get, post, …)`,
      );
    }
  }
}

function defaultIgnore(relativePath: string): boolean {
  const name = basename(relativePath);
  return (
    name.startsWith("_") ||
    name.startsWith(".") ||
    /\.(test|spec)\./.test(name) ||
    name.endsWith(".d.ts") ||
    name.endsWith(".map")
  );
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}
