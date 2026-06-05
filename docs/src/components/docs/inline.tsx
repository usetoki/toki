import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import styles from "./DocContent.module.css";

// Inline markup inside paragraphs / list items / table cells: `code` and [label](href).
const INLINE_PATTERN = /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;

export function renderInline(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  INLINE_PATTERN.lastIndex = 0;

  for (let match = INLINE_PATTERN.exec(text); match !== null; match = INLINE_PATTERN.exec(text)) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));

    const codeText = match[1];
    const linkLabel = match[2];
    const linkHref = match[3];

    if (codeText !== undefined) {
      nodes.push(
        <code key={key++} className={styles.inlineCode}>
          {codeText}
        </code>,
      );
    } else if (linkLabel !== undefined && linkHref !== undefined) {
      nodes.push(
        linkHref.startsWith("/") ? (
          <Link key={key++} className={styles.inlineLink} to={linkHref}>
            {linkLabel}
          </Link>
        ) : (
          <a
            key={key++}
            className={styles.inlineLink}
            href={linkHref}
            target="_blank"
            rel="noreferrer"
          >
            {linkLabel}
          </a>
        ),
      );
    }
    cursor = INLINE_PATTERN.lastIndex;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}
