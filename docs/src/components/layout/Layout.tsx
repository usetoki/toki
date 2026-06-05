import type { ReactElement, ReactNode } from "react";
import { Footer } from "./Footer";
import { Header } from "./Header";

interface LayoutProps {
  readonly children: ReactNode;
}

export function Layout({ children }: LayoutProps): ReactElement {
  return (
    <>
      <Header />
      <main id="top">{children}</main>
      <Footer />
    </>
  );
}
