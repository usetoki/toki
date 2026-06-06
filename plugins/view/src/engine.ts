/** Renders a compiled template against some data. May be async. */
export type Renderer = (data: Record<string, unknown>) => string | Promise<string>;

/** A template engine: compile a template's source (once) into a {@link Renderer}. */
export interface ViewEngine {
  compile(source: string, path: string): Renderer;
}

// Thin adapters over the popular engines. The engine itself is your dependency — pass the
// imported module/instance, and these bridge its compile API to ViewEngine.

/** [eta](https://eta.js.org): pass an `Eta` instance — `eta(new Eta({ views: "..." }))`. */
export function eta(instance: { renderString(source: string, data: object): string }): ViewEngine {
  return { compile: (source) => (data) => instance.renderString(source, data) };
}

/** [ejs](https://ejs.co): pass the `ejs` module — `ejs(await import("ejs"))`. */
export function ejs(lib: {
  compile(source: string, options?: object): (data: object) => string;
}): ViewEngine {
  return { compile: (source, path) => lib.compile(source, { filename: path }) };
}

/** [handlebars](https://handlebarsjs.com): pass `Handlebars` — `handlebars(await import("handlebars"))`. */
export function handlebars(lib: { compile(source: string): (data: object) => string }): ViewEngine {
  return { compile: (source) => lib.compile(source) };
}
