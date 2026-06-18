import type { ReactElement } from "react";
import { FOOTER_GROUPS } from "../../data/footer";
import { Logo } from "../ui/Logo";
import styles from "./Footer.module.css";

function isExternal(href: string): boolean {
  return href.startsWith("http");
}

export function Footer(): ReactElement {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <div className={styles.brand}>
          <Logo />
          <p className={styles.tagline}>A blazing-fast network framework for Node.js, powered by Zig.</p>
        </div>

        <div className={styles.groups}>
          {FOOTER_GROUPS.map((group) => (
            <nav key={group.title} className={styles.group} aria-label={group.title}>
              <h3 className={styles.groupTitle}>{group.title}</h3>
              {group.links.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  className={styles.link}
                  {...(isExternal(link.href) ? { target: "_blank", rel: "noreferrer" } : {})}
                >
                  {link.label}
                </a>
              ))}
            </nav>
          ))}
        </div>
      </div>

      <div className={styles.copy}>
        <span>© {new Date().getFullYear()} toki · MIT licensed</span>
        <span>Built with React + TypeScript</span>
      </div>
    </footer>
  );
}
