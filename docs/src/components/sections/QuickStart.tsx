import type { ReactElement } from "react";
import { HELLO_SNIPPET, INSTALL_SNIPPET } from "../../data/snippets";
import { CodeBlock } from "../ui/CodeBlock";
import { SectionHeading } from "../ui/SectionHeading";
import styles from "./QuickStart.module.css";

interface Step {
  readonly num: string;
  readonly title: string;
  readonly text: string;
}

const STEPS: readonly Step[] = [
  { num: "01", title: "Install", text: "Add the package — the right native prebuild is fetched for your platform." },
  { num: "02", title: "Write a server", text: "Define routes with a clean, typed API; params, query, and JSON are inferred." },
  { num: "03", title: "Listen", text: "Bind a port and serve on Node's own loop. No build step, no config." },
];

export function QuickStart(): ReactElement {
  return (
    <section id="quickstart" className={styles.section}>
      <div className="container">
        <SectionHeading align="left" eyebrow="Quick start" title="Up and running in three steps" />
        <div className={styles.grid}>
          <ol className={styles.steps}>
            {STEPS.map((step) => (
              <li key={step.num} className={styles.step}>
                <span className={styles.num}>{step.num}</span>
                <div className={styles.stepBody}>
                  <h3 className={styles.stepTitle}>{step.title}</h3>
                  <p className={styles.stepText}>{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className={styles.code}>
            <CodeBlock snippet={INSTALL_SNIPPET} />
            <CodeBlock snippet={HELLO_SNIPPET} />
          </div>
        </div>
      </div>
    </section>
  );
}
