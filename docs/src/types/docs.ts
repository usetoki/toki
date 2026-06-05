import type { Snippet } from "./content";

export interface HeadingBlock {
  readonly kind: "heading";
  readonly id: string;
  readonly text: string;
}

export interface ParagraphBlock {
  readonly kind: "paragraph";
  readonly text: string;
}

export interface CodeNode {
  readonly kind: "code";
  readonly snippet: Snippet;
}

export interface ListBlock {
  readonly kind: "list";
  readonly ordered?: boolean;
  readonly items: readonly string[];
}

export interface TableBlock {
  readonly kind: "table";
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface CalloutBlock {
  readonly kind: "callout";
  readonly tone: "note" | "warning" | "tip";
  readonly text: string;
}

export type DocBlock =
  | HeadingBlock
  | ParagraphBlock
  | CodeNode
  | ListBlock
  | TableBlock
  | CalloutBlock;

export interface DocPage {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly blocks: readonly DocBlock[];
}

export interface DocCategory {
  readonly title: string;
  readonly pages: readonly DocPage[];
}
