import { useState } from "react";
import type { ReactElement } from "react";
import { Outlet, useParams } from "react-router-dom";
import { findDocPage } from "../../content/docs/registry";
import { cn } from "../../lib/cn";
import { DocSidebar } from "./DocSidebar";
import { DocToc } from "./DocToc";
import styles from "./DocLayout.module.css";

export function DocLayout(): ReactElement {
  const { slug } = useParams<{ slug: string }>();
  const page = slug !== undefined ? findDocPage(slug) : undefined;
  const [menuOpen, setMenuOpen] = useState<boolean>(false);

  return (
    <div className={styles.shell}>
      <button
        type="button"
        className={styles.menuButton}
        onClick={() => setMenuOpen((open) => !open)}
        aria-expanded={menuOpen}
      >
        {menuOpen ? "Close menu" : "Documentation menu"}
      </button>

      <aside className={cn(styles.sidebar, menuOpen && styles.sidebarOpen)}>
        <DocSidebar onNavigate={() => setMenuOpen(false)} />
      </aside>

      <div className={styles.content}>
        <Outlet />
      </div>

      <DocToc page={page} />
    </div>
  );
}
