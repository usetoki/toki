import type { ReactElement } from "react";
import { FEATURES } from "../../data/features";
import { SectionHeading } from "../ui/SectionHeading";
import styles from "./Features.module.css";

export function Features(): ReactElement {
  return (
    <section id="features" className={styles.section}>
      <div className="container">
        <SectionHeading
          eyebrow="Features"
          title="Everything a server needs, none of the weight"
          subtitle="A complete HTTP toolkit with the hot paths in native code and the developer surface in clean TypeScript."
        />
        <div className={styles.grid}>
          {FEATURES.map((feature) => (
            <article key={feature.title} className={styles.card}>
              <span className={styles.icon} aria-hidden="true">
                {feature.icon}
              </span>
              <h3 className={styles.cardTitle}>{feature.title}</h3>
              <p className={styles.cardText}>{feature.description}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
