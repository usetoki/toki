import type { ReactElement } from "react";
import { STATS } from "../../data/stats";
import { cn } from "../../lib/cn";
import styles from "./Stats.module.css";

export function Stats(): ReactElement {
  return (
    <section className={styles.section}>
      <div className={cn("container", styles.grid)}>
        {STATS.map((stat) => (
          <div key={stat.label} className={styles.stat}>
            <span className={styles.value}>{stat.value}</span>
            <span className={styles.label}>{stat.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
