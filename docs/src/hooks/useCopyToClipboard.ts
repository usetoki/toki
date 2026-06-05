import { useCallback, useState } from "react";

export interface CopyState {
  readonly copied: boolean;
  readonly copy: (text: string) => void;
}

/** Copy text to the clipboard and flip `copied` true for `resetMs`. */
export function useCopyToClipboard(resetMs = 1800): CopyState {
  const [copied, setCopied] = useState<boolean>(false);

  const copy = useCallback(
    (text: string): void => {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), resetMs);
        })
        .catch(() => setCopied(false));
    },
    [resetMs],
  );

  return { copied, copy };
}
