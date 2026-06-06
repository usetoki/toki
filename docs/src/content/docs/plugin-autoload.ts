import type { DocPage } from "../../types";

export const autoloadPluginPage: DocPage = {
  slug: "plugin-autoload",
  title: "Autoload",
  description: "Filesystem routing — register a directory tree of route modules automatically.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-autoload` turns a directory of files into routes. Each file's path becomes its URL, and the file exports a handler per HTTP method (or a `default` plugin for routes that need their own hooks). No central route table to maintain.",
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
      kind: "code",
      snippet: {
        filename: "tree.txt",
        language: "bash",
        code: `routes/
  index.ts          ->  /
  health.ts         ->  /health
  users/index.ts    ->  /users
  users/[id].ts     ->  /users/:id
  files/[...path].ts -> /files/*`,
      },
    },
    {
      kind: "code",
      snippet: {
        filename: "app.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";
import { autoload } from "@usetoki/toki-autoload";

const app = createApp();
await autoload(app, { dir: new URL("./routes", import.meta.url).pathname, prefix: "/api" });
app.listen(3000);`,
      },
    },
    {
      kind: "code",
      snippet: {
        filename: "routes/users/[id].ts",
        language: "ts",
        code: `// GET /api/users/:id
export const get = (req) => db.user(req.params.id);
export const del = (req) => db.remove(req.params.id);`,
      },
    },
    {
      kind: "list",
      items: [
        "Method exports (`get`, `post`, `put`, `patch`, `delete`, `head`, `options`) register at the exact path — clean URLs, no trailing slash.",
        "`[id]` → `:id`, `[...rest]` → `*`, and an `index` file maps to its directory.",
        "A `default` export is treated as a plugin and registered under the path's prefix (use it for per-route hooks).",
        "Dotfiles, `_partials`, and test files are skipped; files load in sorted order.",
      ],
    },
  ],
};
