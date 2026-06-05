import type { ReactElement } from "react";
import { Link } from "react-router-dom";
import styles from "./NotFound.module.css";

export function NotFound(): ReactElement {
  return (
    <main className={styles.wrap}>
      <span className={styles.code}>404</span>
      <h1 className={styles.title}>Page not found</h1>
      <p className={styles.text}>The page you&apos;re looking for doesn&apos;t exist.</p>
      <Link to="/" className={styles.link}>
        Back home
      </Link>
    </main>
  );
}
