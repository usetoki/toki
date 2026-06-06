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
    { kind: "heading", id: "official-plugins", text: "Official plugins" },
    {
      kind: "paragraph",
      text: "The same API powers 21 first-party packages, each a separate npm install and versioned apart from the core. The full catalog lives in [Official plugins](/docs/plugins-overview); at a glance they fall into four groups:",
    },
    {
      kind: "list",
      items: [
        "**Security & auth** — helmet, auth, jwt, csrf, ip-filter.",
        "**Sessions, cookies & state** — cookie, session, secure-session, cache, idempotency, ratelimiter (the stores back onto memory, Redis, or memcached).",
        "**HTTP features** — etag, range, sse, multipart-storage.",
        "**Infra & DX** — env, sensible, autoload, view, proxy, circuit-breaker.",
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "Most plugins are plain middleware you `app.use` or attach as a route `preHandler`. The session plugins install load + save hooks, so you call them on a scope — `session(app, { secret })` — to confine them to one branch of the app.",
    },
  ],
};
