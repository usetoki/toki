# @usetoki/toki-ip-filter

Allow or deny requests by IP and CIDR for [toki](https://usetoki.github.io/toki/).
IPv4 and IPv6, no dependencies. A plain middleware: mount it on a route or a whole scope.

```bash
npm install @usetoki/toki-ip-filter
```

## Usage

```ts
import { createApp } from "@usetoki/toki";
import { ipFilter } from "@usetoki/toki-ip-filter";

const app = createApp();

// lock the admin area to an internal range
app.get("/admin", { preHandler: ipFilter({ allow: ["10.0.0.0/8", "127.0.0.1"] }) }, () => "ok");

// or guard a whole scope, blocking a few bad actors
app.use(ipFilter({ deny: ["203.0.113.7", "198.51.100.0/24"] }));
```

## Rules

- **`allow`** — a whitelist. When set, an address must match one of its ranges to pass
  (default-deny for everything else).
- **`deny`** — a blacklist. A match is always rejected, even if `allow` would admit it.
- **`trustProxy`** — filter on the left-most `X-Forwarded-For` address. Only enable this
  behind a proxy you control, or clients can spoof their IP.
- **`statusCode`** / **`message`** — the response for a blocked request (default `403` /
  `"Forbidden"`).

Entries accept a bare IP (`"1.2.3.4"`, treated as `/32` or `/128`) or a CIDR
(`"10.0.0.0/8"`, `"2001:db8::/32"`). An IPv4-mapped IPv6 peer (`::ffff:1.2.3.4`) matches
IPv4 rules. An invalid entry throws at setup, not mid-request, and an address that can't
be parsed is always blocked.

The `parseIp`, `parseCidr`, and `inCidr` helpers are exported for building your own checks.
