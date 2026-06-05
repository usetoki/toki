import type { ReactElement } from "react";
import { Layout } from "./components/layout/Layout";
import { Boundary } from "./components/sections/Boundary";
import { CTA } from "./components/sections/CTA";
import { Example } from "./components/sections/Example";
import { Features } from "./components/sections/Features";
import { Hero } from "./components/sections/Hero";
import { QuickStart } from "./components/sections/QuickStart";
import { Stats } from "./components/sections/Stats";

export function App(): ReactElement {
  return (
    <Layout>
      <Hero />
      <Stats />
      <Features />
      <QuickStart />
      <Example />
      <Boundary />
      <CTA />
    </Layout>
  );
}
