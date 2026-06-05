import type { ReactElement } from "react";
import { Footer } from "../components/layout/Footer";
import { Boundary } from "../components/sections/Boundary";
import { CTA } from "../components/sections/CTA";
import { Docs } from "../components/sections/Docs";
import { Example } from "../components/sections/Example";
import { Features } from "../components/sections/Features";
import { Hero } from "../components/sections/Hero";
import { QuickStart } from "../components/sections/QuickStart";
import { Stats } from "../components/sections/Stats";

export function Home(): ReactElement {
  return (
    <>
      <main id="top">
        <Hero />
        <Stats />
        <Features />
        <QuickStart />
        <Example />
        <Boundary />
        <Docs />
        <CTA />
      </main>
      <Footer />
    </>
  );
}
