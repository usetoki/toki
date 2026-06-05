import type { ReactElement } from "react";
import { cn } from "../../lib/cn";
import styles from "./SectionHeading.module.css";

interface SectionHeadingProps {
  readonly eyebrow?: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly align?: "left" | "center";
}

export function SectionHeading({
  eyebrow,
  title,
  subtitle,
  align = "center",
}: SectionHeadingProps): ReactElement {
  return (
    <div className={cn(styles.heading, align === "center" && styles.center)}>
      {eyebrow !== undefined ? <span className={styles.eyebrow}>{eyebrow}</span> : null}
      <h2 className={styles.title}>{title}</h2>
      {subtitle !== undefined ? <p className={styles.subtitle}>{subtitle}</p> : null}
    </div>
  );
}
