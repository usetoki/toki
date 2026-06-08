import type { DocPage } from "../../types";

export const pluginsPage: DocPage = {
  slug: "plugins",
  title: "Plugins & encapsulation",
  description: "Encapsulated registration with register(), prefixes, decorators, and async loading.",
  blocks: [
    {
      kind: "paragraph",
      text: "A plugin is a function that registers routes, hooks, middleware, decorators, and parsers into its own scope. `register(plugin, options?)` runs it against a fresh child scope — what it adds is inherited by its own children but does not leak to the parent. Plugins are how you split an app into self-contained features and how every first-party `@usetoki/*` package plugs in.",
    },
    {
      kind: "code",
      snippet: {
        filename: "shape.ts",
        language: "ts",
        code: `import type { TokiInstance, PluginOptions } from "@usetoki/toki";

// (instance: TokiInstance, opts: PluginOptions) => void | Promise<void>
function usersPlugin(app: TokiInstance, opts: PluginOptions) {
  app.addHook("preHandler", authenticate); // scoped to this plugin
  app.get("/", listUsers);
  app.get("/:id", getUser);
}

app.register(usersPlugin, { prefix: "/users" });`,
      },
    },
    { kind: "heading", id: "options", text: "Passing options" },
    {
      kind: "paragraph",
      text: "Everything after `prefix` on the options object is yours. The plugin reads it from its second argument, so the same plugin can be registered twice with different config.",
    },
    {
      kind: "code",
      snippet: {
        filename: "options.ts",
        language: "ts",
        code: `import type { TokiInstance } from "@usetoki/toki";
import { reply } from "@usetoki/toki";

interface RateOpts { max: number; windowMs: number }

function rateLimit(app: TokiInstance, opts: RateOpts) {
  const hits = new Map<string, number>();
  app.addHook("onRequest", (req) => {
    const n = (hits.get(req.ip) ?? 0) + 1;
    hits.set(req.ip, n);
    if (n > opts.max) return reply.json({ message: "slow down" }, 429);
  });
}

app.register(rateLimit, { prefix: "/api", max: 100, windowMs: 60_000 });`,
      },
    },
    { kind: "heading", id: "encapsulation", text: "Encapsulation" },
    {
      kind: "paragraph",
      text: "A plugin runs against a child scope. Anything that lives on a scope is encapsulated; only `decorate` (app-global) and `setNotFoundHandler` reach the whole app.",
    },
    {
      kind: "table",
      headers: ["Added in a plugin", "Visible to"],
      rows: [
        ["`addHook` / `use` (hooks, middleware)", "this plugin and its children"],
        ["`addContentTypeParser`", "this plugin and its children"],
        ["`onError` / `setErrorHandler`", "this plugin and its children"],
        ["`decorateRequest`", "requests handled in this scope"],
        ["`decorate`", "the whole app (not encapsulated)"],
        ["`setNotFoundHandler`", "the whole app (app-global)"],
      ],
    },
    {
      kind: "callout",
      tone: "note",
      text: "`prefix` nests: registering a plugin with `prefix: \"/v2\"` inside one already mounted at `/api` puts its routes under `/api/v2`. See [Decorators](/docs/decorators) for the `decorate` vs `decorateRequest` split.",
    },
    { kind: "heading", id: "decorate", text: "A plugin that adds a route and a decorator" },
    {
      kind: "paragraph",
      text: "`decorate(name, value)` attaches a value to the app instance — config, a client, a helper — so other parts of the app can read it off the instance. `decorateRequest(name, value)` attaches a property to every request the scope handles, which handlers and hooks read off `req`.",
    },
    {
      kind: "code",
      snippet: {
        filename: "decorate.ts",
        language: "ts",
        code: `import type { TokiInstance } from "@usetoki/toki";
import { reply } from "@usetoki/toki";

function clock(app: TokiInstance) {
  const startedAt = Date.now();
  app.decorate("startedAt", startedAt);             // app-global
  app.decorateRequest("now", () => Date.now());     // per request
  app.get("/uptime", () => reply.json({ ms: Date.now() - startedAt }));
}

app.register(clock);
// later, anywhere with the instance:
console.log((app as any).startedAt);`,
      },
    },
    { kind: "heading", id: "async", text: "Async plugins" },
    {
      kind: "paragraph",
      text: "A plugin may be async — for example to open a database connection before serving. Plugins load depth-first in registration order. Call `await app.ready()` before `listen()` to load them all; `listen()` loads synchronous plugins on its own and throws if it meets an async one that hasn't been loaded.",
    },
    {
      kind: "code",
      snippet: {
        filename: "async-plugin.ts",
        language: "ts",
        code: `import { createApp, reply } from "@usetoki/toki";

const app = createApp({ logger: "info" });

app.register(async (instance) => {
  const db = await connect(process.env.DATABASE_URL!);
  instance.decorate("db", db);
  instance.get("/health", () => reply.json({ db: db.ok }));
});

await app.ready();   // loads async plugins
app.listen(3000);`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "Forgetting `await app.ready()` with an async plugin throws at `listen()`: \"async plugin registered — call `await app.ready()` before `listen()`\". An all-sync app can skip `ready()` entirely.",
    },
    { kind: "heading", id: "ordering", text: "Load order and lifecycle" },
    {
      kind: "paragraph",
      text: "Plugins load when you call `ready()` or `listen()`, not at `register()` time, so registration order is what matters. Pair plugins with app-level `onReady` (runs once before serving) and `onClose` (runs at shutdown) for setup and teardown that isn't tied to one request.",
    },
    {
      kind: "code",
      snippet: {
        filename: "lifecycle.ts",
        language: "ts",
        code: `app.onReady(() => app.log.info("all plugins loaded"));
app.onClose(() => app.log.info("shutting down"));

const handle = app.listen(3000);
// ... later
handle.close(); // fires onClose hooks`,
      },
    },
    { kind: "heading", id: "official-plugins", text: "First-party plugins" },
    {
      kind: "paragraph",
      text: "The same `register` / `use` API powers the first-party `@usetoki/*` packages — each a separate npm install, versioned apart from the core. Most are plain middleware you `app.use` or attach as a route `preHandler`; the session plugins install load + save hooks, so you call them on a scope to confine them to one branch. The full catalog lives in [Official plugins](/docs/plugins-overview).",
    },
  ],
};
