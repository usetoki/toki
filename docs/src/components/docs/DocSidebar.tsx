import type { ReactElement } from "react";
import { NavLink } from "react-router-dom";
import { DOC_CATEGORIES } from "../../content/docs/registry";
import { cn } from "../../lib/cn";
import styles from "./DocSidebar.module.css";

interface DocSidebarProps {
  readonly onNavigate?: () => void;
}

export function DocSidebar({ onNavigate }: DocSidebarProps): ReactElement {
  return (
    <nav className={styles.sidebar} aria-label="Documentation">
      {DOC_CATEGORIES.map((category) => (
        <div key={category.title} className={styles.group}>
          <span className={styles.groupTitle}>{category.title}</span>
          <ul className={styles.list}>
            {category.pages.map((page) => (
              <li key={page.slug}>
                <NavLink
                  to={`/docs/${page.slug}`}
                  onClick={onNavigate}
                  className={({ isActive }) => cn(styles.link, isActive && styles.active)}
                >
                  {page.title}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
