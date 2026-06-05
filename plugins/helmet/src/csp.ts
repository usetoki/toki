/**
 * Content-Security-Policy directives. Keys are camelCase (`defaultSrc`) and emit
 * kebab-case (`default-src`). A list of sources joins with spaces; `true` emits a
 * bare, valueless directive (e.g. `upgrade-insecure-requests`).
 */
export interface CspDirectives {
  readonly [directive: string]: readonly string[] | string | true;
}

/** Helmet's baseline policy: lock everything to same-origin, deny plugins/inline scripts. */
export const DEFAULT_CSP: CspDirectives = {
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  fontSrc: ["'self'", "https:", "data:"],
  formAction: ["'self'"],
  frameAncestors: ["'self'"],
  imgSrc: ["'self'", "data:"],
  objectSrc: ["'none'"],
  scriptSrc: ["'self'"],
  scriptSrcAttr: ["'none'"],
  styleSrc: ["'self'", "https:", "'unsafe-inline'"],
  upgradeInsecureRequests: true,
};

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Serialize directives into a `Content-Security-Policy` header value. */
export function buildCsp(directives: CspDirectives): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(directives)) {
    const directive = kebab(name);
    if (value === true) {
      parts.push(directive);
      continue;
    }
    const sources = typeof value === "string" ? [value] : value;
    parts.push(sources.length === 0 ? directive : `${directive} ${sources.join(" ")}`);
  }
  return parts.join("; ");
}
