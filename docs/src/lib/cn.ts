/** Join class names, dropping falsy values. Keeps JSX className expressions tidy. */
export function cn(...classes: ReadonlyArray<string | false | null | undefined>): string {
  return classes.filter((value): value is string => Boolean(value)).join(" ");
}
