import type { Language } from "../types";

export type TokenKind =
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "fn"
  | "type"
  | "punct"
  | "plain";

export interface Token {
  readonly value: string;
  readonly kind: TokenKind;
}

const KEYWORDS: ReadonlySet<string> = new Set([
  "const", "let", "var", "function", "return", "import", "export", "from", "as",
  "async", "await", "if", "else", "for", "while", "do", "new", "class", "extends",
  "implements", "interface", "type", "void", "null", "undefined", "true", "false",
  "this", "typeof", "instanceof", "in", "of", "default", "switch", "case", "break",
  "continue", "yield", "public", "private", "readonly", "static",
]);

const TS_PATTERN = new RegExp(
  [
    "(?<comment>//[^\\n]*|/\\*[\\s\\S]*?\\*/)",
    "(?<string>`(?:\\\\.|[^`\\\\])*`|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*')",
    "(?<number>\\b\\d[\\d_]*(?:\\.\\d+)?\\b)",
    "(?<word>[A-Za-z_$][\\w$]*)",
    "(?<punct>[{}()\\[\\].,;:=<>+\\-*/%!&|?@]+)",
  ].join("|"),
  "g",
);

const BASH_PATTERN = new RegExp(
  [
    "(?<comment>#[^\\n]*)",
    "(?<string>\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*')",
    "(?<flag>--?[A-Za-z][\\w-]*)",
  ].join("|"),
  "g",
);

function tokenizeTs(code: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  TS_PATTERN.lastIndex = 0;
  for (let match = TS_PATTERN.exec(code); match !== null; match = TS_PATTERN.exec(code)) {
    if (match.index > cursor) tokens.push({ value: code.slice(cursor, match.index), kind: "plain" });
    const groups = match.groups ?? {};
    const text = match[0];
    let kind: TokenKind = "plain";
    if (groups.comment !== undefined) kind = "comment";
    else if (groups.string !== undefined) kind = "string";
    else if (groups.number !== undefined) kind = "number";
    else if (groups.punct !== undefined) kind = "punct";
    else if (groups.word !== undefined) {
      if (KEYWORDS.has(text)) kind = "keyword";
      else if (code[TS_PATTERN.lastIndex] === "(") kind = "fn";
      else if (/^[A-Z]/.test(text)) kind = "type";
    }
    tokens.push({ value: text, kind });
    cursor = TS_PATTERN.lastIndex;
  }
  if (cursor < code.length) tokens.push({ value: code.slice(cursor), kind: "plain" });
  return tokens;
}

function tokenizeBash(code: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  BASH_PATTERN.lastIndex = 0;
  for (let match = BASH_PATTERN.exec(code); match !== null; match = BASH_PATTERN.exec(code)) {
    if (match.index > cursor) tokens.push({ value: code.slice(cursor, match.index), kind: "plain" });
    const groups = match.groups ?? {};
    const kind: TokenKind =
      groups.comment !== undefined ? "comment" : groups.string !== undefined ? "string" : "keyword";
    tokens.push({ value: match[0], kind });
    cursor = BASH_PATTERN.lastIndex;
  }
  if (cursor < code.length) tokens.push({ value: code.slice(cursor), kind: "plain" });
  return tokens;
}

export function tokenize(code: string, language: Language): readonly Token[] {
  return language === "bash" ? tokenizeBash(code) : tokenizeTs(code);
}
