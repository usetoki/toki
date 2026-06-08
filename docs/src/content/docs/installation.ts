import type { DocPage } from "../../types";

export const installationPage: DocPage = {
  slug: "installation",
  title: "Installation",
  description: "Install toki and the prebuilt native engine for your platform.",
  blocks: [
    {
      kind: "paragraph",
      text: "Install the package from npm. The matching native prebuild is pulled in automatically as an optional dependency — there is no compile step on install, and no `node-gyp`.",
    },
    {
      kind: "code",
      snippet: { filename: "terminal", language: "bash", code: "npm install @usetoki/toki" },
    },
    { kind: "heading", id: "requirements", text: "Requirements" },
    {
      kind: "list",
      items: [
        "Node.js 20 or newer to install and run (the N-API version toki's addon targets).",
        "Node.js 22 or newer to run TypeScript files directly with `node server.ts` (native type-stripping). On 20, compile first or use a loader.",
        "A supported platform (below). On anything else, build from source.",
      ],
    },
    {
      kind: "callout",
      tone: "tip",
      text: "Node 22 strips types behind a flag; 23.6+ runs `.ts` with no flag at all. If `node server.ts` errors on the type annotations, you are on an older runtime — upgrade, or run a compiled `.js`.",
    },
    { kind: "heading", id: "platforms", text: "Supported platforms" },
    {
      kind: "paragraph",
      text: "A prebuilt binary ships for each target below as a separate `@usetoki/toki-<platform>` package. `npm install` resolves the one that matches your machine; the others are skipped.",
    },
    {
      kind: "table",
      headers: ["OS", "Architectures"],
      rows: [
        ["Linux (glibc)", "x64, arm64, arm (gnueabihf)"],
        ["Linux (musl)", "x64, arm64"],
        ["macOS", "arm64, x64"],
        ["Windows", "x64, arm64, ia32"],
        ["FreeBSD", "x64"],
      ],
    },
    {
      kind: "callout",
      tone: "tip",
      text: "On Alpine (musl) Linux, toki detects the libc at load time and picks the musl prebuild automatically — no extra config.",
    },
    { kind: "heading", id: "hello-world", text: "Hello, world" },
    {
      kind: "paragraph",
      text: "Save this as `server.ts`:",
    },
    {
      kind: "code",
      snippet: {
        filename: "server.ts",
        language: "ts",
        code: `import { createApp, reply } from "@usetoki/toki";

const app = createApp();

app.get("/", () => reply.text("Hello, World!"));

app.listen(3000);
console.log("listening on http://127.0.0.1:3000");`,
      },
    },
    {
      kind: "paragraph",
      text: "Run it with Node directly — no bundler, no `ts-node`:",
    },
    {
      kind: "code",
      snippet: { filename: "terminal", language: "bash", code: "node server.ts" },
    },
    {
      kind: "paragraph",
      text: "Then `curl http://127.0.0.1:3000/` returns `Hello, World!`. Continue with the [quick start](/docs/quick-start) to add params, a JSON body, and a hook.",
    },
    { kind: "heading", id: "imports", text: "Importing" },
    {
      kind: "paragraph",
      text: "Toki is an ES module with full type declarations. Import named exports directly — there is no default export:",
    },
    {
      kind: "code",
      snippet: {
        filename: "app.ts",
        language: "ts",
        code: `import { createApp, reply, compression, corsHeaders } from "@usetoki/toki";

// types come along for free
import type { Handler, ServerOptions, TokiResponse } from "@usetoki/toki";`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "Toki is ESM-only. In a CommonJS project, use a dynamic `await import(\"@usetoki/toki\")`, or set `\"type\": \"module\"` in your `package.json`.",
    },
    { kind: "heading", id: "plugins", text: "Plugins" },
    {
      kind: "paragraph",
      text: "Official plugins (auth, cache, sessions, rate limiting, view rendering, and more) are published as `@usetoki/toki-<name>` packages and installed per-plugin — you pull in only what you use. Each declares `@usetoki/toki` as a peer dependency, so it shares your installed core.",
    },
    {
      kind: "code",
      snippet: {
        filename: "terminal",
        language: "bash",
        code: "npm install @usetoki/toki-cache @usetoki/toki-jwt",
      },
    },
    {
      kind: "paragraph",
      text: "See the [plugins overview](/docs/plugins-overview) for the catalog and [Plugins](/docs/plugins) for how registration and encapsulation work.",
    },
  ],
};
