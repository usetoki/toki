import type { DocPage } from "../../types";

export const ipFilterPluginPage: DocPage = {
  slug: "plugin-ip-filter",
  title: "IP filter",
  description: "Allow or deny requests by IP and CIDR — IPv4 and IPv6, no dependencies.",
  blocks: [
    {
      kind: "paragraph",
      text: "`@usetoki/toki-ip-filter` allows or denies requests by IP address or CIDR range. Reach for it to lock an admin panel to your office network, gate an internal API to a VPC range, or drop a handful of abusive addresses. It parses both IPv4 and IPv6 (and IPv4-mapped IPv6), has no dependencies, and validates every rule once at setup rather than mid-request.",
    },
    {
      kind: "code",
      snippet: {
        filename: "install.sh",
        language: "bash",
        code: `npm install @usetoki/toki-ip-filter`,
      },
    },
    { kind: "heading", id: "quick-start", text: "Quick start" },
    {
      kind: "paragraph",
      text: "Mount it on a single route's `preHandler`, or `app.use` it to guard a whole scope. An `allow` list is default-deny — anything not matched is rejected. A `deny` list is default-allow — only matches are rejected.",
    },
    {
      kind: "code",
      snippet: {
        filename: "ip-filter.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";
import { ipFilter } from "@usetoki/toki-ip-filter";

const app = createApp();

// lock the admin area to an internal range + localhost
app.get("/admin", { preHandler: ipFilter({ allow: ["10.0.0.0/8", "127.0.0.1"] }) }, () => "ok");

// or block a few bad actors across a whole scope
app.use(ipFilter({ deny: ["203.0.113.7", "198.51.100.0/24"] }));

app.listen(3000);`,
      },
    },
    { kind: "heading", id: "precedence", text: "How allow and deny combine" },
    {
      kind: "paragraph",
      text: "You can set both. `deny` always wins: a denied address is rejected even if `allow` would admit it. Use this to carve a hole out of an otherwise-trusted range.",
    },
    {
      kind: "code",
      snippet: {
        filename: "combine.ts",
        language: "ts",
        code: `// trust the office network, but a known-compromised host inside it stays out
app.use(
  ipFilter({
    allow: ["10.0.0.0/8"],
    deny: ["10.4.2.99"],
  }),
);`,
      },
    },
    {
      kind: "list",
      items: [
        "No `allow` and no `deny` set → everything passes (the filter is a no-op).",
        "`allow` only → default-deny; an address must match `allow` to pass.",
        "`deny` only → default-allow; only `deny` matches are rejected.",
        "Both set → must match `allow` **and** not match `deny`.",
      ],
    },
    { kind: "heading", id: "behind-proxy", text: "Behind a proxy" },
    {
      kind: "paragraph",
      text: "By default the filter uses the socket peer (`req.ip`). Behind a load balancer or CDN that's the proxy's address, not the client's. Set `trustProxy: true` to filter on the left-most `X-Forwarded-For` address instead.",
    },
    {
      kind: "code",
      snippet: {
        filename: "proxy.ts",
        language: "ts",
        code: `app.use(ipFilter({ allow: ["203.0.113.0/24"], trustProxy: true }));`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "Only set `trustProxy` when a proxy you control terminates the connection. `X-Forwarded-For` is client-supplied — if requests can reach your app directly, an attacker spoofs the header and walks straight past the filter.",
    },
    { kind: "heading", id: "options", text: "Options" },
    {
      kind: "table",
      headers: ["Option", "Default", "Notes"],
      rows: [
        ["`allow`", "—", "allow-list of IPs/CIDRs; when set, an address must match to pass"],
        ["`deny`", "—", "deny-list of IPs/CIDRs; a match is always rejected"],
        ["`trustProxy`", "`false`", "filter on the left-most `X-Forwarded-For` address"],
        ["`statusCode`", "`403`", "status for a blocked request"],
        ["`message`", "`\"Forbidden\"`", "body for a blocked request"],
      ],
    },
    { kind: "heading", id: "rule-syntax", text: "Rule syntax" },
    {
      kind: "paragraph",
      text: 'Each entry is a bare IP (`\"1.2.3.4\"`, treated as `/32`; `\"2001:db8::1\"`, treated as `/128`) or a CIDR (`\"10.0.0.0/8\"`, `\"2001:db8::/32\"`). An IPv4-mapped IPv6 peer (`::ffff:1.2.3.4`) matches your IPv4 rules, so a dual-stack server behaves as you\'d expect.',
    },
    {
      kind: "callout",
      tone: "warning",
      text: "An invalid entry throws at setup, so a typo fails loud at boot instead of silently letting traffic through. A request whose address can't be parsed is always blocked.",
    },
    { kind: "heading", id: "helpers", text: "Exported helpers" },
    {
      kind: "paragraph",
      text: "`parseIp`, `parseCidr`, and `inCidr` are exported if you want to build your own checks — geo-routing, audit logging, a custom allow-list in a handler. `parseIp` and `parseCidr` return `null` on malformed input rather than throwing.",
    },
    {
      kind: "code",
      snippet: {
        filename: "helpers.ts",
        language: "ts",
        code: `import { parseIp, parseCidr, inCidr } from "@usetoki/toki-ip-filter";

const range = parseCidr("10.0.0.0/8");
const ip = parseIp("10.4.2.7");

if (range && ip && inCidr(ip, range)) {
  // request is inside the internal network
}`,
      },
    },
  ],
};
