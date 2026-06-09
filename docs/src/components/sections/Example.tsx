import { useState } from "react";
import type { ReactElement } from "react";
import { EXAMPLE_TABS } from "../../data/snippets";
import { cn } from "../../lib/cn";
import { CodeBlock } from "../ui/CodeBlock";
import { SectionHeading } from "../ui/SectionHeading";
import styles from "./Example.module.css";

export function Example(): ReactElement {
  const [activeId, setActiveId] = useState<string>(EXAMPLE_TABS[0]?.id ?? "");
  const active = EXAMPLE_TABS.find((tab) => tab.id === activeId) ?? EXAMPLE_TABS[0];

  return (
    <section id="example" className={styles.section}>
      <div className="container">
        <SectionHeading
          eyebrow="Example"
          title="Familiar, fully-typed, fast"
          subtitle="Routing, validation, WebSockets, and middleware. The API stays out of your way."
        />
        <div className={styles.tabs} role="tablist" aria-label="Code examples">
          {EXAMPLE_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.id === activeId}
              className={cn(styles.tab, tab.id === activeId && styles.tabActive)}
              onClick={() => setActiveId(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {active !== undefined ? <CodeBlock snippet={active.snippet} /> : null}
      </div>
    </section>
  );
}
