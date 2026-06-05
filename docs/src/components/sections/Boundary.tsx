import type { ReactElement } from "react";
import { BOUNDARY_ROWS } from "../../data/boundary";
import { cn } from "../../lib/cn";
import { SectionHeading } from "../ui/SectionHeading";
import styles from "./Boundary.module.css";

export function Boundary(): ReactElement {
  return (
    <section id="boundary" className={styles.section}>
      <div className="container">
        <SectionHeading
          eyebrow="Native vs JavaScript"
          title="The boundary is drawn on purpose"
          subtitle="Heavy byte-work runs in Zig. V8-primitive parsing stays in JavaScript, where it is measurably faster than crossing the N-API boundary."
        />
        <div className={styles.table}>
          {BOUNDARY_ROWS.map((row) => (
            <div key={row.capability} className={styles.row}>
              <span className={styles.cap}>{row.capability}</span>
              <span
                className={cn(
                  styles.tag,
                  row.where === "Native (Zig)" ? styles.native : styles.ts,
                )}
              >
                {row.where}
              </span>
              <span className={styles.note}>{row.note}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
