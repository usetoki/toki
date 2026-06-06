import type { DocPage } from "../../types";

export const autoloadPluginPage: DocPage = {
  slug: "plugin-autoload",
  title: "Autoload",
  description: "Filesystem routing — register a directory tree of route modules automatically.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-autoload` turns a directory of files into routes. Each file's path becomes its URL, and the file exports one handler per HTTP method — or a `default` plugin for routes that need their own hooks. Reach for it when a central route table gets tedious to maintain and you'd rather see your URLs in the file tree. Files load in sorted order, so registration is deterministic.",
    },
    {
      kind: "heading",
      id: "install",
      text: "Install",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-autoload`,
      },
    },
    {
      kind: "heading",
      id: "the-mapping",
      text: "How files map to URLs",
    },
    {
      kind: "code",
      snippet: {
        filename: "tree.txt",
        language: "bash",
        code: `routes/
  index.ts            ->  /
  health.ts           ->  /health
  users/index.ts      ->  /users
  users/[id].ts       ->  /users/:id
  files/[...path].ts  ->  /files/*`,
      },
    },
    {
      kind: "list",
      items: [
        "A plain name maps to itself; an `index` file maps to its directory.",
        "`[id]` becomes a param `:id`; `[...rest]` becomes a catch-all `*` (and must be the last segment).",
        "Routes register at the exact path — clean URLs, no trailing slash.",
      ],
    },
    {
      kind: "heading",
      id: "quick-start",
      text: "Quick start",
    },
    {
      kind: "code",
      snippet: {
        filename: "app.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";
import { autoload } from "@usetoki/toki-autoload";

const app = createApp();
await autoload(app, {
  dir: new URL("./routes", import.meta.url).pathname,
  prefix: "/api",
});
app.listen(3000);`,
      },
    },
    {
      kind: "heading",
      id: "method-handlers",
      text: "Method handlers",
    },
    {
      kind: "paragraph",
      text: "A route file exports a function per method: `get`, `post`, `put`, `patch`, `head`, `options`, and `delete`. Because `delete` is a reserved word you can't write `export const delete` — define the function and re-export it under the name.",
    },
    {
      kind: "code",
      snippet: {
        filename: "routes/users/[id].ts",
        language: "ts",
        code: `// GET/PATCH/DELETE /api/users/:id
export const get = (req) => db.user(req.params.id);
export const patch = async (req) => db.update(req.params.id, await req.json());

const remove = (req) => db.remove(req.params.id);
export { remove as delete }; // 'delete' is reserved — alias it on export`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "A file that exports neither a method handler nor a `default` plugin throws at load time. That catches a typo like `getr` before the server starts, instead of silently serving nothing.",
    },
    {
      kind: "heading",
      id: "per-route-plugins",
      text: "Per-route plugins",
    },
    {
      kind: "paragraph",
      text: "When a route needs its own hooks — auth, a body limit, a rate limiter — default-export a plugin. It's registered under the file's path as its prefix, so its hooks apply to just that subtree.",
    },
    {
      kind: "code",
      snippet: {
        filename: "routes/admin/index.ts",
        language: "ts",
        code: `import type { TokiInstance } from "@usetoki/toki";

// registered with prefix "/api/admin"
export default function admin(instance: TokiInstance) {
  instance.addHook("onRequest", requireAdmin);
  instance.get("/", () => db.adminDashboard());
  instance.get("/users", () => db.allUsers());
}`,
      },
    },
    {
      kind: "heading",
      id: "what-gets-skipped",
      text: "What gets skipped",
    },
    {
      kind: "paragraph",
      text: "By default autoload loads `.js` and `.mjs` files and skips dotfiles, `_partials`, test files (`.test.` / `.spec.`), `.d.ts`, and source maps. Symlinks to files are followed; broken links are ignored. Override either with `extensions` and `ignore`.",
    },
    {
      kind: "code",
      snippet: {
        filename: "ts-dev.ts",
        language: "ts",
        code: `await autoload(app, {
  dir: routesDir,
  extensions: [".ts", ".js"], // running TS directly (e.g. tsx)
  ignore: (rel) => rel.includes("__fixtures__"),
});`,
      },
    },
    {
      kind: "heading",
      id: "options",
      text: "Options",
    },
    {
      kind: "table",
      headers: ["Option", "Type", "Default", "Notes"],
      rows: [
        ["dir", "string", "—", "Required. Directory of route modules to load."],
        ["prefix", "string", '"/"', "Base prefix prepended to every derived route."],
        ["extensions", "string[]", '[".js", ".mjs"]', "File extensions to load."],
        ["ignore", "(rel: string) => boolean", "dotfiles, `_*`, tests, `.d.ts`, `.map`", "Skip a file by its path relative to `dir`."],
        ["options", "PluginOptions", "—", "Options handed to a module that default-exports a plugin."],
      ],
    },
    {
      kind: "callout",
      tone: "tip",
      text: "`autoload` is async — `await` it before `listen` so every route is registered first. It's just sugar over `instance.route` / `instance.register`, so it composes with normally-registered routes and prefixes.",
    },
  ],
};
