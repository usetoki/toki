import type { ReactElement } from "react";
import { Link } from "react-router-dom";
import { FIRST_DOC_SLUG } from "../../content/docs/registry";
import { cn } from "../../lib/cn";
import { ButtonRouterLink } from "../ui/Button";
import { ArrowRightIcon, BookIcon } from "../ui/icons";
import styles from "./Docs.module.css";

interface DocLink {
  readonly label: string;
  readonly slug: string;
}

const POPULAR: readonly DocLink[] = [
  { label: "Quick start", slug: "quick-start" },
  { label: "Routing", slug: "routing" },
  { label: "Plugins", slug: "plugins-overview" },
  { label: "WebSockets", slug: "websockets" },
];

export function Docs(): ReactElement {
  return (
    <section className={styles.section} id="docs">
      <div className={cn("container", styles.card)}>
        <div className={styles.glow} aria-hidden="true" />
        <div className={styles.badge}>
          <BookIcon width={34} height={34} />
        </div>
        <div className={styles.body}>
          <h2 className={styles.title}>Read the full documentation</h2>
          <p className={styles.text}>
            From a five-minute quick start to routing, hooks, plugins, WebSockets, and the native
            engine — toki is documented end to end, with copy-paste examples throughout.
          </p>
          <div className={styles.links}>
            <ButtonRouterLink to={`/docs/${FIRST_DOC_SLUG}`} variant="primary">
              Browse the docs
              <ArrowRightIcon width={16} height={16} />
            </ButtonRouterLink>
            {POPULAR.map((link) => (
              <Link key={link.slug} to={`/docs/${link.slug}`} className={styles.chip}>
                {link.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
