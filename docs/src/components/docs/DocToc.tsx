import type { ReactElement } from "react";
import type { DocPage, HeadingBlock } from "../../types";
import styles from "./DocToc.module.css";

interface DocTocProps {
  readonly page: DocPage | undefined;
}

function isHeading(block: DocPage["blocks"][number]): block is HeadingBlock {
  return block.kind === "heading";
}

export function DocToc({ page }: DocTocProps): ReactElement | null {
  const headings = page?.blocks.filter(isHeading) ?? [];
  if (headings.length === 0) return null;

  return (
    <aside className={styles.toc} aria-label="On this page">
      <span className={styles.title}>On this page</span>
      <ul className={styles.list}>
        {headings.map((heading) => (
          <li key={heading.id}>
            <a className={styles.link} href={`#${heading.id}`}>
              {heading.text}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}
