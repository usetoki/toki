import type { ReactElement } from "react";
import { cn } from "../../lib/cn";
import type { DocBlock } from "../../types";
import { CodeBlock } from "../ui/CodeBlock";
import { renderInline } from "./inline";
import styles from "./DocContent.module.css";

interface BlockProps {
  readonly block: DocBlock;
}

function Block({ block }: BlockProps): ReactElement {
  switch (block.kind) {
    case "heading":
      return (
        <h2 id={block.id} className={styles.h2}>
          <a href={`#${block.id}`} className={styles.anchor} aria-label={block.text}>
            #
          </a>
          {block.text}
        </h2>
      );
    case "paragraph":
      return <p className={styles.p}>{renderInline(block.text)}</p>;
    case "code":
      return (
        <div className={styles.code}>
          <CodeBlock snippet={block.snippet} />
        </div>
      );
    case "list":
      return block.ordered === true ? (
        <ol className={styles.ol}>
          {block.items.map((item, index) => (
            <li key={index}>{renderInline(item)}</li>
          ))}
        </ol>
      ) : (
        <ul className={styles.ul}>
          {block.items.map((item, index) => (
            <li key={index}>{renderInline(item)}</li>
          ))}
        </ul>
      );
    case "table":
      return (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {block.headers.map((header, index) => (
                  <th key={index}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{renderInline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "callout":
      return <div className={cn(styles.callout, styles[block.tone])}>{renderInline(block.text)}</div>;
  }
}

interface DocContentProps {
  readonly blocks: readonly DocBlock[];
}

export function DocContent({ blocks }: DocContentProps): ReactElement {
  return (
    <div className={styles.content}>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
}
