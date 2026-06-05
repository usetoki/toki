import type { ReactElement } from "react";
import { GITHUB_URL, NAV_ITEMS, SECTION_IDS } from "../../data/nav";
import { useScrollSpy } from "../../hooks/useScrollSpy";
import { cn } from "../../lib/cn";
import { GitHubIcon } from "../ui/icons";
import { Logo } from "../ui/Logo";
import { ThemeToggle } from "../ui/ThemeToggle";
import styles from "./Header.module.css";

export function Header(): ReactElement {
  const activeId = useScrollSpy(SECTION_IDS);

  return (
    <header className={styles.header}>
      <div className={cn("container", styles.inner)}>
        <a href="#top" className={styles.brand} aria-label="toki — home">
          <Logo />
        </a>

        <nav className={styles.nav} aria-label="Primary">
          {NAV_ITEMS.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className={cn(styles.link, activeId === item.id && styles.active)}
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className={styles.actions}>
          <ThemeToggle />
          <a
            className={styles.github}
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="toki on GitHub"
          >
            <GitHubIcon width={20} height={20} />
          </a>
        </div>
      </div>
    </header>
  );
}
