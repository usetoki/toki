import type { DocPage } from "../../types";

export const viewPluginPage: DocPage = {
  slug: "plugin-view",
  title: "View",
  description: "Server-side template rendering with eta, ejs, or handlebars.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-view` renders templates to HTML. It's engine-agnostic — bring eta, ejs, or handlebars (your dependency, not ours) — handles file loading and compiled-template caching, and confines template names to the views directory so a name can never escape it.",
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
app.get("/users/:id", async (req) => view("profile", { user: await db.user(req.params.id) }));`,
      },
    },
    {
      kind: "list",
      items: [
        "Engine adapters: `eta(instance)`, `ejs(module)`, `handlebars(module)` — or implement the one-method `ViewEngine` interface yourself.",
        "`view(template, data)` returns an HTML response; `data` overrides `locals`.",
        "Templates are compiled once and cached; set `cache: false` in development to pick up edits.",
        'A template name like `"../secret"` is rejected — names stay inside `root`.',
      ],
    },
  ],
};
