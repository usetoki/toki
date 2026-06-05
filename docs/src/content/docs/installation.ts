import type { DocPage } from "../../types";

export const installationPage: DocPage = {
  slug: "installation",
  title: "Installation",
  description: "Install toki and the prebuilt native engine for your platform.",
  blocks: [
    {
      kind: "paragraph",
      text: "Install the package from npm. The matching native prebuild is pulled in automatically as an optional dependency — there is no compile step on install.",
    },
    {
      kind: "code",
      snippet: { filename: "terminal", language: "bash", code: "npm install @usetoki/toki" },
    },
    { kind: "heading", id: "requirements", text: "Requirements" },
    {
      kind: "list",
      items: [
        "Node.js 22 or newer (native `.ts` type-stripping and the N-API version toki targets).",
        "A supported platform (below). On anything else, build from source.",
      ],
    },
    { kind: "heading", id: "platforms", text: "Supported platforms" },
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
    { kind: "heading", id: "imports", text: "Importing" },
    {
      kind: "paragraph",
      text: "Toki is an ES module with full type declarations. Import named exports directly:",
    },
    {
      kind: "code",
      snippet: {
        filename: "app.ts",
        language: "ts",
        code: `import { createApp, reply, cors, compression } from "@usetoki/toki";`,
      },
    },
    {
      kind: "callout",
      tone: "tip",
      text: "On Alpine (musl) Linux, toki detects the libc at load time and picks the musl prebuild automatically.",
    },
  ],
};
