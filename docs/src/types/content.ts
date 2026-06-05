import type { Language } from "./theme";

/** A feature card on the landing page. */
export interface Feature {
  readonly icon: string;
  readonly title: string;
  readonly description: string;
}

/** A headline metric shown in the stats band. */
export interface Stat {
  readonly value: string;
  readonly label: string;
}

/** A copy-pasteable code sample rendered by CodeBlock. */
export interface Snippet {
  readonly filename: string;
  readonly language: Language;
  readonly code: string;
}

/** A labelled group of snippets shown as switchable tabs. */
export interface SnippetTab {
  readonly id: string;
  readonly label: string;
  readonly snippet: Snippet;
}

/** A row in the "native vs JavaScript" comparison. */
export interface BoundaryRow {
  readonly capability: string;
  readonly where: "Native (Zig)" | "TypeScript";
  readonly note: string;
}
