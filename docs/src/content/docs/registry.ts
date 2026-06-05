import type { DocCategory, DocPage } from "../../types";
import { applicationPage } from "./application";
import { bodyParsingPage } from "./body-parsing";
import { compressionPage } from "./compression";
import { cookiesPage } from "./cookies";
import { corsSecurityPage } from "./cors-security";
import { decoratorsPage } from "./decorators";
import { errorHandlingPage } from "./error-handling";
import { helmetPluginPage } from "./plugin-helmet";
import { hooksPage } from "./hooks";
import { httpsPage } from "./https";
import { installationPage } from "./installation";
import { introductionPage } from "./introduction";
import { jwtPage } from "./jwt";
import { loggingPage } from "./logging";
import { middlewarePage } from "./middleware";
import { pluginsOverviewPage } from "./plugins-overview";
import { pluginsPage } from "./plugins";
import { rateLimiterPluginPage } from "./plugin-rate-limiter";
import { quickStartPage } from "./quick-start";
import { rateLimitingPage } from "./rate-limiting";
import { requestPage } from "./request";
import { responsePage } from "./response";
import { routingPage } from "./routing";
import { serverOptionsPage } from "./server-options";
import { staticFilesPage } from "./static-files";
import { streamingPage } from "./streaming";
import { testingPage } from "./testing";
import { validationPage } from "./validation";
import { websocketsPage } from "./websockets";

export const DOC_CATEGORIES: readonly DocCategory[] = [
  {
    title: "Getting started",
    pages: [introductionPage, installationPage, quickStartPage],
  },
  {
    title: "Core",
    pages: [
      applicationPage,
      routingPage,
      requestPage,
      responsePage,
      cookiesPage,
      bodyParsingPage,
      errorHandlingPage,
    ],
  },
  {
    title: "Lifecycle",
    pages: [hooksPage, middlewarePage, pluginsPage, validationPage, decoratorsPage],
  },
  {
    title: "Features",
    pages: [
      websocketsPage,
      staticFilesPage,
      compressionPage,
      streamingPage,
      corsSecurityPage,
      jwtPage,
      httpsPage,
      rateLimitingPage,
      loggingPage,
      testingPage,
    ],
  },
  {
    title: "Plugins",
    pages: [pluginsOverviewPage, helmetPluginPage, rateLimiterPluginPage],
  },
  {
    title: "Reference",
    pages: [serverOptionsPage],
  },
];

export const DOC_PAGES: readonly DocPage[] = DOC_CATEGORIES.flatMap((category) => category.pages);

export const FIRST_DOC_SLUG: string = DOC_PAGES[0]?.slug ?? "introduction";

export function findDocPage(slug: string): DocPage | undefined {
  return DOC_PAGES.find((page) => page.slug === slug);
}

export interface DocNeighbors {
  readonly prev: DocPage | undefined;
  readonly next: DocPage | undefined;
}

export function docNeighbors(slug: string): DocNeighbors {
  const index = DOC_PAGES.findIndex((page) => page.slug === slug);
  if (index === -1) return { prev: undefined, next: undefined };
  return {
    prev: index > 0 ? DOC_PAGES[index - 1] : undefined,
    next: index < DOC_PAGES.length - 1 ? DOC_PAGES[index + 1] : undefined,
  };
}
