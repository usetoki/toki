import type { DocPage } from "../../types";

export const pluginsPage: DocPage = {
  slug: "plugins",
  title: "Plugins & encapsulation",
  description: "Encapsulated registration with register(), prefixes, and async loading.",
  blocks: [
    {
      kind: "paragraph",
      text: "A plugin is a function that registers routes, hooks, decorators, and parsers into its own encapsulated scope. `register(plugin, options?)` runs it against a fresh child scope — what it adds is inherited by its children but does not leak to the parent.",
    },
    {
      kind: "code",
      snippet: {
        filename: "plugin.ts",
        language: "ts",
        code: `import type { TokiInstance } from "@usetoki/toki";

function usersPlugin(app: TokiInstance) {
  app.addHook("preHandler", authenticate); // scoped to this plugin
  app.get("/", listUsers);
  app.get("/:id", getUser);
}

app.register(usersPlugin, { prefix: "/users" });`,
      },
    },
    { kind: "heading", id: "encapsulation", text: "Encapsulation" },
    {
      kind: "list",
      items: [
        "Hooks, middleware, content-type parsers, and the error handler are scoped to the plugin and its children.",
        "`decorateRequest` is scoped; `decorate` (app-global) is not — see [Decorators](/docs/decorators).",
        "`prefix` mounts the plugin's routes under a path; it nests with parent prefixes.",
      ],
    },
    { kind: "heading", id: "async", text: "Async plugins" },
    {
      kind: "paragraph",
      text: "A plugin may be async (e.g. to open a database connection). Call `await app.ready()` before `listen()` to load all plugins; `listen()` loads synchronous plugins on its own and throws if it meets an async one.",
    },
    {
      kind: "code",
      snippet: {
        filename: "async-plugin.ts",
        language: "ts",
        code: `app.register(async (instance) => {
  const db = await connect(process.env.DATABASE_URL);
  instance.decorate("db", db);
  instance.get("/health", () => reply.json({ db: db.ok }));
});

await app.ready();
app.listen(3000);`,
      },
    },
  ],
};
