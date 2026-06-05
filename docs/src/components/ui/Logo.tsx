import type { ReactElement } from "react";
import styles from "./Logo.module.css";

export function Logo(): ReactElement {
  return (
    <span className={styles.logo}>
      toki
    </span>
  );
}
