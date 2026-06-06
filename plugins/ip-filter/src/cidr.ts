// IP/CIDR matching on integer addresses. v4 is a 32-bit value, v6 a 128-bit BigInt;
// an IPv4-mapped v6 address (::ffff:1.2.3.4) collapses to plain v4 so a dual-stack
// peer matches IPv4 rules. No allocation on the match path beyond the BigInt math.

const V4_BITS = 32n;
const V6_BITS = 128n;

export interface Ip {
  readonly version: 4 | 6;
  readonly value: bigint;
}

export interface Cidr {
  readonly version: 4 | 6;
  readonly base: bigint;
  readonly prefix: number;
}

function parseV4(input: string): bigint | null {
  const parts = input.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseV6(input: string): bigint | null {
  const zone = input.indexOf("%");
  const ip = zone === -1 ? input : input.slice(0, zone);
  const halves = ip.split("::");
  if (halves.length > 2) return null;

  const groupsOf = (part: string): number[] | null => {
    if (part === "") return [];
    const tokens = part.split(":");
    const out: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.includes(".")) {
        if (i !== tokens.length - 1) return null; // an embedded IPv4 tail is last-only
        const v4 = parseV4(token);
        if (v4 === null) return null;
        out.push(Number(v4 >> 16n), Number(v4 & 0xffffn));
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(token)) return null;
        out.push(parseInt(token, 16));
      }
    }
    return out;
  };

  const head = groupsOf(halves[0]!);
  if (head === null) return null;

  let groups: number[];
  if (halves.length === 2) {
    const tail = groupsOf(halves[1]!);
    if (tail === null) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null; // "::" must elide at least one zero group
    groups = [...head, ...Array.from({ length: missing }, () => 0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(group);
  return value;
}

/** Parse an IP literal, or null if malformed. */
export function parseIp(input: string): Ip | null {
  const ip = input.trim();
  if (ip === "") return null;
  if (ip.includes(":")) {
    const v6 = parseV6(ip);
    if (v6 === null) return null;
    if (v6 >> 32n === 0xffffn) return { version: 4, value: v6 & 0xffffffffn }; // ::ffff:a.b.c.d
    return { version: 6, value: v6 };
  }
  const v4 = parseV4(ip);
  return v4 === null ? null : { version: 4, value: v4 };
}

function maskFor(prefix: number, bits: bigint): bigint {
  if (prefix === 0) return 0n;
  return ((1n << BigInt(prefix)) - 1n) << (bits - BigInt(prefix));
}

/** Parse `"ip"` or `"ip/prefix"`; a bare address means a single host (/32 or /128). */
export function parseCidr(input: string): Cidr | null {
  const slash = input.indexOf("/");
  const parsed = parseIp(slash === -1 ? input : input.slice(0, slash));
  if (parsed === null) return null;
  const bits = parsed.version === 4 ? V4_BITS : V6_BITS;
  let prefix = Number(bits);
  if (slash !== -1) {
    // require explicit digits — Number("") is 0, which would turn "1.2.3.4/" into a /0 match-all
    const text = input.slice(slash + 1);
    if (!/^\d+$/.test(text)) return null;
    const p = Number(text);
    if (p > Number(bits)) return null;
    prefix = p;
  }
  return { version: parsed.version, base: parsed.value & maskFor(prefix, bits), prefix };
}

/** True when `ip` falls inside `cidr` (same family required). */
export function inCidr(ip: Ip, cidr: Cidr): boolean {
  if (ip.version !== cidr.version) return false;
  if (cidr.prefix === 0) return true;
  const bits = cidr.version === 4 ? V4_BITS : V6_BITS;
  return (ip.value & maskFor(cidr.prefix, bits)) === cidr.base;
}
