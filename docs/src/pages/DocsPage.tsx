import { useEffect } from "react";
import type { ReactElement } from "react";
import { Link, useParams } from "react-router-dom";
import { DocContent } from "../components/docs/DocContent";
import { docNeighbors, findDocPage } from "../content/docs/registry";
import { cn } from "../lib/cn";
import styles from "./DocsPage.module.css";

export function DocsPage(): ReactElement {
  const { slug } = useParams<{ slug: string }>();
  const page = slug !== undefined ? findDocPage(slug) : undefined;

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [slug]);

  if (page === undefined) {
    return (
      <div className={styles.missing}>
        <h1>Page not found</h1>
        <p>That documentation page doesn&apos;t exist.</p>
        <Link to="/docs/introduction" className={styles.back}>
          Back to the docs
        </Link>
      </div>
    );
  }

  const { prev, next } = docNeighbors(page.slug);

  return (
    <article>
      <header className={styles.head}>
        <span className={styles.eyebrow}>Documentation</span>
        <h1 className={styles.title}>{page.title}</h1>
        <p className={styles.description}>{page.description}</p>
      </header>

      <DocContent blocks={page.blocks} />

      <nav className={styles.pager}>
        {prev !== undefined ? (
          <Link className={styles.pagerLink} to={`/docs/${prev.slug}`}>
            <span className={styles.pagerDir}>← Previous</span>
            <strong>{prev.title}</strong>
          </Link>
        ) : (
          <span />
        )}
        {next !== undefined ? (
          <Link className={cn(styles.pagerLink, styles.pagerNext)} to={`/docs/${next.slug}`}>
            <span className={styles.pagerDir}>Next →</span>
            <strong>{next.title}</strong>
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </article>
  );
}
