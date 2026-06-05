import type { ReactElement } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { DocLayout } from "./components/docs/DocLayout";
import { Header } from "./components/layout/Header";
import { FIRST_DOC_SLUG } from "./content/docs/registry";
import { DocsPage } from "./pages/DocsPage";
import { Home } from "./pages/Home";
import { NotFound } from "./pages/NotFound";

// Vite's base: "/toki" in production, "" (root) in dev — BASE_URL is "/toki/" or "/".
const basename = import.meta.env.BASE_URL.replace(/\/$/, "");

export function App(): ReactElement {
  return (
    <BrowserRouter basename={basename}>
      <Header />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/docs" element={<Navigate to={`/docs/${FIRST_DOC_SLUG}`} replace />} />
        <Route path="/docs/:slug" element={<DocLayout />}>
          <Route index element={<DocsPage />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
