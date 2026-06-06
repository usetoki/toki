import type { DocPage } from "../../types";

export const ipFilterPluginPage: DocPage = {
  slug: "plugin-ip-filter",
  title: "IP filter",
  description: "Allow or deny requests by IP and CIDR — IPv4 and IPv6, no dependencies.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-ip-filter` is a plain middleware that allows or denies requests by IP or CIDR range. Mount it on a single route's `preHandler` or `app.use` it to guard a whole scope.",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-ip-filter`,
      },
    },
    {
      kind: "code",
      snippet: {
        filename: "ip-filter.ts",
        language: "ts",
        code: `import { ipFilter } from "@usetoki/toki-ip-filter";

// lock the admin area to an internal range
app.get("/admin", { preHandler: ipFilter({ allow: ["10.0.0.0/8", "127.0.0.1"] }) }, () => "ok");

// or block a few bad actors across a scope
app.use(ipFilter({ deny: ["203.0.113.7", "198.51.100.0/24"] }));`,
      },
    },
    {
      kind: "list",
      items: [
        "`allow` — a whitelist; when set, an address must match to pass (default-deny otherwise).",
        "`deny` — a blacklist; a match is always rejected, even if `allow` would admit it.",
        "`trustProxy` — filter on the left-most `X-Forwarded-For` address. Only enable behind a proxy you control.",
        '`statusCode` / `message` — the response for a blocked request (default `403` / `"Forbidden"`).',
      ],
    },
    {
      kind: "paragraph",
      text: 'Entries accept a bare IP (`"1.2.3.4"`, treated as `/32` or `/128`) or a CIDR (`"2001:db8::/32"`). An IPv4-mapped IPv6 peer (`::ffff:1.2.3.4`) matches IPv4 rules. Invalid entries throw at setup, and an address that can\'t be parsed is always blocked.',
    },
    {
      kind: "callout",
      tone: "note",
      text: "The `parseIp`, `parseCidr`, and `inCidr` helpers are exported for building your own checks.",
    },
  ],
};
