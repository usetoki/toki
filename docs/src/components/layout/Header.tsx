import type { ReactElement } from "react";
import { Link, useLocation } from "react-router-dom";
import { FIRST_DOC_SLUG } from "../../content/docs/registry";
import { GITHUB_URL, NAV_ITEMS, SECTION_IDS } from "../../data/nav";
import { useScrollSpy } from "../../hooks/useScrollSpy";
import { cn } from "../../lib/cn";
import { GitHubIcon } from "../ui/icons";
import { Logo } from "../ui/Logo";
import { ThemeToggle } from "../ui/ThemeToggle";
import styles from "./Header.module.css";

export function Header(): ReactElement {
  const location = useLocation();
  const onHome = location.pathname === "/";
  const activeId = useScrollSpy(SECTION_IDS);

  return (
    <header className={styles.header}>
      <div className={cn(styles.inner, onHome ? styles.innerHome : styles.innerDocs)}>
        <Link to="/" className={styles.brand} aria-label="toki — home">
          <Logo />
        </Link>

        {onHome ? (
          <nav className={styles.nav} aria-label="Sections">
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
        ) : null}

        <div className={styles.actions}>
          <Link
            to={`/docs/${FIRST_DOC_SLUG}`}
            className={cn(styles.docsLink, !onHome && styles.docsActive)}
          >
            Docs
          </Link>
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
