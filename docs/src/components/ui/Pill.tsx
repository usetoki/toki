import type { ReactElement, ReactNode } from "react";
import styles from "./Pill.module.css";

interface PillProps {
  readonly children: ReactNode;
}

export function Pill({ children }: PillProps): ReactElement {
  return <span className={styles.pill}>{children}</span>;
}
