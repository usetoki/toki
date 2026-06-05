import type { ReactElement } from "react";
import { GITHUB_URL } from "../../data/nav";
import { HELLO_SNIPPET, INSTALL_SNIPPET } from "../../data/snippets";
import { cn } from "../../lib/cn";
import { ButtonLink } from "../ui/Button";
import { CodeBlock } from "../ui/CodeBlock";
import { ArrowRightIcon, GitHubIcon } from "../ui/icons";
import { Pill } from "../ui/Pill";
import styles from "./Hero.module.css";

export function Hero(): ReactElement {
  return (
    <section className={styles.hero}>
      <div className={styles.glow} aria-hidden="true" />
      <div className={cn("container", styles.inner)}>
        <div className={styles.copy}>
          <Pill>⚡ Native HTTP engine in Zig</Pill>
          <h1 className={styles.title}>
            A <span className={styles.grad}>blazing-fast</span> HTTP framework for Node.js
          </h1>
          <p className={styles.lede}>
            A clean, fully-typed TypeScript API on top of a native engine written in Zig. Parsing,
            routing, static files, and compression run in native code — your handlers stay in
            JavaScript.
          </p>
          <div className={styles.install}>
            <CodeBlock snippet={INSTALL_SNIPPET} />
          </div>
          <div className={styles.actions}>
            <ButtonLink href="#quickstart" variant="primary">
              Get started
              <ArrowRightIcon width={16} height={16} />
            </ButtonLink>
            <ButtonLink href={GITHUB_URL} variant="outline" target="_blank" rel="noreferrer">
              <GitHubIcon width={18} height={18} />
              GitHub
            </ButtonLink>
          </div>
        </div>

        <div className={styles.preview}>
          <img
            className={styles.logo}
            src={`${import.meta.env.BASE_URL}toki-logo.png`}
            alt="toki"
            width={150}
            height={150}
          />
          <CodeBlock snippet={HELLO_SNIPPET} />
        </div>
      </div>
    </section>
  );
}
