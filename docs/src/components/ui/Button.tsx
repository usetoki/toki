import type { AnchorHTMLAttributes, ReactElement, ReactNode } from "react";
import { Link, type LinkProps } from "react-router-dom";
import { cn } from "../../lib/cn";
import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "outline" | "ghost";

interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  readonly variant?: ButtonVariant;
  readonly children: ReactNode;
}

export function ButtonLink({
  variant = "primary",
  className,
  children,
  ...rest
}: ButtonLinkProps): ReactElement {
  return (
    <a className={cn(styles.btn, styles[variant], className)} {...rest}>
      {children}
    </a>
  );
}

interface ButtonRouterLinkProps extends LinkProps {
  readonly variant?: ButtonVariant;
  readonly children: ReactNode;
}

/** Same look as {@link ButtonLink}, but an in-app router link (no full reload). */
export function ButtonRouterLink({
  variant = "primary",
  className,
  children,
  ...rest
}: ButtonRouterLinkProps): ReactElement {
  return (
    <Link className={cn(styles.btn, styles[variant], className)} {...rest}>
      {children}
    </Link>
  );
}
