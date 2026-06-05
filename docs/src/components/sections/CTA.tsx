import type { ReactElement } from "react";
import { GITHUB_URL, NPM_URL } from "../../data/nav";
import { cn } from "../../lib/cn";
import { ButtonLink } from "../ui/Button";
import { ArrowRightIcon, GitHubIcon } from "../ui/icons";
import styles from "./CTA.module.css";

export function CTA(): ReactElement {
  return (
    <section className={styles.section}>
      <div className={cn("container", styles.card)}>
        <div className={styles.glow} aria-hidden="true" />
        <h2 className={styles.title}>Build something blazing fast</h2>
        <p className={styles.text}>
          Install toki and serve your first route in under a minute.
        </p>
        <div className={styles.actions}>
          <ButtonLink href={NPM_URL} variant="primary" target="_blank" rel="noreferrer">
            Install from npm
            <ArrowRightIcon width={16} height={16} />
          </ButtonLink>
          <ButtonLink href={GITHUB_URL} variant="outline" target="_blank" rel="noreferrer">
            <GitHubIcon width={18} height={18} />
            Star on GitHub
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
