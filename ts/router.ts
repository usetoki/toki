/**
 * Normalize a path pattern to canonical Toki syntax: one leading slash, no trailing slash
 * (except root), collapsed empty segments. Parameter syntax (`:name`, trailing `*`) is preserved.
 */
export function normalizePattern(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return "/";
  }
  return `/${segments.join("/")}`;
}
