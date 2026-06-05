import type { AnchorHTMLAttributes, ReactElement, ReactNode } from "react";
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
