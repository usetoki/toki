// Turn a route file's path (relative to the routes dir) into a URL prefix.
//   index.ts            -> /
//   health.ts           -> /health
//   users/index.ts      -> /users
//   users/[id].ts       -> /users/:id
//   files/[...path].ts  -> /files/*
export function routePrefix(relativePath: string): string {
  const withoutExt = relativePath.replace(/\.[^./\\]+$/, "");
  const parts: string[] = [];
  for (const raw of withoutExt.split(/[\\/]/)) {
    if (raw === "" || raw === "index") continue;
    parts.push(segment(raw));
  }
  return `/${parts.join("/")}`;
}

function segment(name: string): string {
  const catchAll = /^\[\.\.\..+\]$/.test(name);
  if (catchAll) return "*";
  const param = /^\[(.+)\]$/.exec(name);
  return param ? `:${param[1]}` : name;
}

/** Join a base prefix with a derived one, collapsing slashes. */
export function joinPrefix(base: string, sub: string): string {
  const joined = `/${base}/${sub}`.replace(/\/{2,}/g, "/");
  return joined.length > 1 && joined.endsWith("/") ? joined.slice(0, -1) : joined;
}
