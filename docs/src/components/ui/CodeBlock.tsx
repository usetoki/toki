import { useMemo } from "react";
import type { ReactElement } from "react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { tokenize } from "../../lib/highlight";
import type { TokenKind } from "../../lib/highlight";
import type { Snippet } from "../../types";
import { CheckIcon, CopyIcon } from "./icons";
import styles from "./CodeBlock.module.css";

interface CodeBlockProps {
  readonly snippet: Snippet;
}

function classFor(kind: TokenKind): string | undefined {
  return kind === "plain" ? undefined : styles[kind];
}

export function CodeBlock({ snippet }: CodeBlockProps): ReactElement {
  const { copied, copy } = useCopyToClipboard();
  const tokens = useMemo(
    () => tokenize(snippet.code, snippet.language),
    [snippet.code, snippet.language],
  );

  return (
    <figure className={styles.block}>
      <div className={styles.bar}>
        <span className={styles.dots} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className={styles.filename}>{snippet.filename}</span>
        <button
          type="button"
          className={styles.copy}
          onClick={() => copy(snippet.code)}
          aria-label={copied ? "Copied" : "Copy code"}
        >
          {copied ? <CheckIcon width={15} height={15} /> : <CopyIcon width={15} height={15} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className={styles.pre}>
        <code>
          {tokens.map((token, index) => (
            <span key={index} className={classFor(token.kind)}>
              {token.value}
            </span>
          ))}
        </code>
      </pre>
    </figure>
  );
}
