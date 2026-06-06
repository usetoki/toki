import type { DocPage } from "../../types";

export const viewPluginPage: DocPage = {
  slug: "plugin-view",
  title: "View",
  description: "Server-side template rendering with eta, ejs, or handlebars.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-view` renders templates to an HTML response. Reach for it when you serve server-rendered pages — a marketing site, an admin panel, transactional email previews — instead of shipping JSON to a client framework. It's engine-agnostic: bring eta, ejs, or handlebars (your dependency, not ours). It loads files, compiles them once, caches the compiled result, and confines every template name to the views directory so a name can never escape it.",
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
        code: `npm install @usetoki/toki-view eta`,
      },
    },
    {
      kind: "heading",
      id: "quick-start",
      text: "Quick start",
    },
    {
      kind: "paragraph",
      text: "`createView(options)` returns a `view(template, data)` function. Call it from a handler and return its result — it renders the template with your `locals` merged under `data` and produces an HTML response.",
    },
    {
      kind: "code",
      snippet: {
        filename: "app.ts",
        language: "ts",
        code: `import { Eta } from "eta";
import { createApp } from "@usetoki/toki";
import { createView, eta } from "@usetoki/toki-view";

const view = createView({
  engine: eta(new Eta()),
  root: new URL("./views", import.meta.url).pathname,
  ext: ".eta",
  locals: { site: "Toki" }, // merged into every render
});

const app = createApp();
app.get("/users/:id", async (req) => view("profile", { user: await db.user(req.params.id) }));
app.listen(3000);`,
      },
    },
    {
      kind: "paragraph",
      text: "Inside `views/profile.eta` you reach `it.site` and `it.user`. `data` wins on key collisions, so a per-request `user` overrides any `locals.user`.",
    },
    {
      kind: "heading",
      id: "engines",
      text: "Choosing an engine",
    },
    {
      kind: "paragraph",
      text: "Three thin adapters bridge the popular engines to toki's `ViewEngine` interface. Pass the imported instance or module — the adapter wires up its compile API.",
    },
    {
      kind: "code",
      snippet: {
        filename: "engines.ts",
        language: "ts",
        code: `import { createView, eta, ejs, handlebars } from "@usetoki/toki-view";
import { Eta } from "eta";

// eta — pass an Eta instance
createView({ engine: eta(new Eta()), root, ext: ".eta" });

// ejs — pass the module (it gets the file path for includes)
createView({ engine: ejs(await import("ejs")), root, ext: ".ejs" });

// handlebars — pass the module
createView({ engine: handlebars(await import("handlebars")), root, ext: ".hbs" });`,
      },
    },
    {
      kind: "heading",
      id: "dev-vs-prod",
      text: "Development vs production",
    },
    {
      kind: "paragraph",
      text: "Compiled templates are cached by resolved path, so each file is read and compiled once. In development, turn the cache off so edits show up without a restart; leave it on in production.",
    },
    {
      kind: "code",
      snippet: {
        filename: "view.ts",
        language: "ts",
        code: `const view = createView({
  engine: eta(new Eta()),
  root: viewsDir,
  ext: ".eta",
  cache: process.env.NODE_ENV === "production", // recompile on every edit in dev
});`,
      },
    },
    {
      kind: "heading",
      id: "custom-engine",
      text: "A custom engine",
    },
    {
      kind: "paragraph",
      text: "`ViewEngine` is one method. `compile(source, path)` returns a `Renderer` — a function from data to a string (or a promise of one). Anything that turns a string template into HTML fits.",
    },
    {
      kind: "code",
      snippet: {
        filename: "mustache.ts",
        language: "ts",
        code: `import Mustache from "mustache";
import type { ViewEngine } from "@usetoki/toki-view";

const mustache: ViewEngine = {
  compile: (source) => (data) => Mustache.render(source, data),
};

const view = createView({ engine: mustache, root: viewsDir, ext: ".mustache" });`,
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
        ["engine", "ViewEngine", "—", "Required. An adapter (`eta`/`ejs`/`handlebars`) or your own."],
        ["root", "string", "—", "Required. Directory templates resolve against; names can't escape it."],
        ["ext", "string", '""', "Extension appended to a name without one, e.g. `\".eta\"`."],
        ["cache", "boolean", "true", "Cache compiled templates; set `false` in dev to pick up edits."],
        ["contentType", "string", '"text/html; charset=utf-8"', "Response content type."],
        ["locals", "Record<string, unknown>", "{}", "Data merged into every render; `data` overrides it."],
      ],
    },
    {
      kind: "callout",
      tone: "warning",
      text: "Template names are confined to `root`. A name like `\"../secrets\"`, an absolute path, or a symlink that points outside `root` is rejected before any file is read. A missing template surfaces as the underlying read error, and a failed compile is never pinned in the cache.",
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Concurrent first-hits on the same template compile once, not N times — the cache stores the compile promise, so the second request awaits the first.",
    },
  ],
};
