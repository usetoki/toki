import type { DocPage } from "../../types";

export const decoratorsPage: DocPage = {
  slug: "decorators",
  title: "Decorators",
  description:
    "Attach shared services to the app and per-request values to every request, with plugin scoping.",
  blocks: [
    {
      kind: "paragraph",
      text: "Decorators attach reusable values without reaching for module globals. `decorate` adds an app-global property: a database client, a config object, a service. `decorateRequest` reserves a property on every request handled in a scope, which a hook then fills in per request.",
    },
    {
      kind: "table",
      headers: ["Method", "Attaches to", "Scope"],
      rows: [
        ["`app.decorate(name, value)`", "the app instance", "Global — set once at startup."],
        [
          "`app.decorateRequest(name, value)`",
          "every request in the scope",
          "Encapsulated — stays within the scope and its children.",
        ],
      ],
    },
    { kind: "heading", id: "app", text: "App decorators" },
    {
      kind: "paragraph",
      text: "`app.decorate(name, value)` sets a property on the application instance. It is app-global regardless of which scope calls it, so it suits shared services you build once: a database client, a cache, a typed config. Reach it through the `app` instance in your handlers.",
    },
    {
      kind: "code",
      snippet: {
        filename: "decorate.ts",
        language: "ts",
        code: `const app = createApp();
const database = await connect(process.env.DATABASE_URL);

app.decorate("db", database);

app.get("/users", () => {
  // reachable via the app instance
  return reply.json(app.db.listUsers());
});`,
      },
    },
    {
      kind: "paragraph",
      text: "TypeScript doesn't know about the new property. Cast the app, or declare a typed alias once and reuse it; that beats casting at every call site.",
    },
    {
      kind: "code",
      snippet: {
        filename: "typed-app.ts",
        language: "ts",
        code: `import { createApp, type Toki } from "@usetoki/toki";

interface AppDecorations {
  db: Database;
  config: Config;
}
type App = Toki & AppDecorations;

const app = createApp() as App;
app.decorate("db", database);
app.decorate("config", config);

app.get("/health", () => reply.json({ region: app.config.region }));`,
      },
    },
    { kind: "heading", id: "request", text: "Request decorators" },
    {
      kind: "paragraph",
      text: "`decorateRequest(name, value)` reserves a property on every request handled in the scope, seeded with the value you give. The value is the default shape, not shared mutable state: toki applies it per request, and a hook overwrites it with the real value. Request decorators are scoped, so a plugin's decorations stay within that plugin.",
    },
    {
      kind: "paragraph",
      text: "The classic use is authentication: decorate the request with a `user`, then fill it in an `onRequest` hook from the session or token. Handlers read a typed `req.user` instead of re-parsing the token each time.",
    },
    {
      kind: "code",
      snippet: {
        filename: "decorate-user.ts",
        language: "ts",
        code: `interface AuthedRequest extends TokiRequest {
  user: User | null;
}

app.decorateRequest("user", null);

app.addHook("onRequest", (req) => {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  (req as AuthedRequest).user = token ? verifyUser(token) : null;
});

app.get("/me", (req) => {
  const { user } = req as AuthedRequest;
  if (!user) return reply.empty(401);
  return reply.json(user);
});`,
      },
    },
    {
      kind: "paragraph",
      text: "Decorate with a primitive default to time a request: reserve the slot, stamp it in `onRequest`, read it in `onResponse`.",
    },
    {
      kind: "code",
      snippet: {
        filename: "decorate-timing.ts",
        language: "ts",
        code: `app.decorateRequest("startedAt", 0);

app.addHook("onRequest", (req) => {
  (req as { startedAt: number }).startedAt = performance.now();
});

app.addHook("onResponse", (req) => {
  const ms = performance.now() - (req as { startedAt: number }).startedAt;
  req.log.info("served", { ms });
});`,
      },
    },
    { kind: "heading", id: "scoping", text: "Scoping & encapsulation" },
    {
      kind: "paragraph",
      text: "`decorateRequest` lives on the scope. A plugin registered with `register` gets a child scope; its request decorators apply to its own routes (and its children) and are merged across the scope ancestry. A route sees decorations from the root down to its own scope, but not from sibling plugins. `decorate`, by contrast, always lands on the root app no matter who calls it.",
    },
    {
      kind: "code",
      snippet: {
        filename: "scoped-plugin.ts",
        language: "ts",
        code: `function billing(scope: TokiInstance) {
  // only routes inside this plugin get req.account
  scope.decorateRequest("account", null);
  scope.addHook("onRequest", (req) => {
    (req as { account: Account | null }).account = loadAccount(req);
  });
  scope.get("/invoices", (req) => reply.json(listInvoices(req)));
}

app.register(billing, { prefix: "/billing" });

// req.account is undefined here — a different scope
app.get("/", () => reply.text("ok"));`,
      },
    },
    { kind: "heading", id: "double", text: "Guarding against double-decorate" },
    {
      kind: "paragraph",
      text: "Decorating the same name twice silently overwrites the first value; there is no built-in guard. When two plugins might both claim `db` or `user`, check first and fail loudly so the clash surfaces at boot, not as a confusing runtime bug.",
    },
    {
      kind: "code",
      snippet: {
        filename: "guard.ts",
        language: "ts",
        code: `function decorateOnce(app: Toki, name: string, value: unknown): void {
  if (name in app) {
    throw new Error(\`decorator "\${name}" is already defined\`);
  }
  app.decorate(name, value);
}

decorateOnce(app, "db", database);
decorateOnce(app, "db", other); // throws: caught at startup`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Decorating a request with a default value keeps the request object's shape stable across requests, which helps V8 keep your handlers on a fast hidden class. Reserve the slot with `decorateRequest` rather than assigning a fresh ad-hoc property inside a hook.",
    },
    {
      kind: "callout",
      tone: "warning",
      text: "`decorate` is app-global: calling it from inside a plugin still sets the property on the root app, not the plugin scope. For values that must stay encapsulated per scope, use `decorateRequest` (or close over a local in the plugin) instead.",
    },
  ],
};
