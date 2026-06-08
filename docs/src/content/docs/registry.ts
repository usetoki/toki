import type { DocCategory, DocPage } from "../../types";
import { applicationPage } from "./application";
import { authPluginPage } from "./plugin-auth";
import { autoloadPluginPage } from "./plugin-autoload";
import { bodyParsingPage } from "./body-parsing";
import { cachePluginPage } from "./plugin-cache";
import { circuitBreakerPluginPage } from "./plugin-circuit-breaker";
import { compressionPage } from "./compression";
import { cookiePluginPage } from "./plugin-cookie";
import { csrfPluginPage } from "./plugin-csrf";
import { envPluginPage } from "./plugin-env";
import { etagPluginPage } from "./plugin-etag";
import { idempotencyPluginPage } from "./plugin-idempotency";
import { ipFilterPluginPage } from "./plugin-ip-filter";
import { multipartStoragePluginPage } from "./plugin-multipart-storage";
import { proxyPluginPage } from "./plugin-proxy";
import { rangePluginPage } from "./plugin-range";
import { sensiblePluginPage } from "./plugin-sensible";
import { ssePluginPage } from "./plugin-sse";
import { viewPluginPage } from "./plugin-view";
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
import { jwtPluginPage } from "./plugin-jwt";
import { loggingPage } from "./logging";
import { middlewarePage } from "./middleware";
import { pluginsOverviewPage } from "./plugins-overview";
import { pluginsPage } from "./plugins";
import { rateLimiterPluginPage } from "./plugin-rate-limiter";
import { secureSessionPluginPage } from "./plugin-secure-session";
import { sessionsPluginPage } from "./plugin-sessions";
import { quickStartPage } from "./quick-start";
import { rateLimitingPage } from "./rate-limiting";
import { requestPage } from "./request";
import { responsePage } from "./response";
import { routingPage } from "./routing";
import { serverOptionsPage } from "./server-options";
import { staticFilesPage } from "./static-files";
import { streamingPage } from "./streaming";
import { tcpPage } from "./tcp";
import { testingPage } from "./testing";
import { udpPage } from "./udp";
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
    title: "Networking",
    pages: [tcpPage, udpPage],
  },
  {
    title: "Plugins",
    pages: [
      pluginsOverviewPage,
      helmetPluginPage,
      rateLimiterPluginPage,
      cookiePluginPage,
      sessionsPluginPage,
      secureSessionPluginPage,
      authPluginPage,
      jwtPluginPage,
      csrfPluginPage,
      etagPluginPage,
      cachePluginPage,
      ipFilterPluginPage,
      envPluginPage,
      sensiblePluginPage,
      autoloadPluginPage,
      viewPluginPage,
      ssePluginPage,
      idempotencyPluginPage,
      multipartStoragePluginPage,
      rangePluginPage,
      proxyPluginPage,
      circuitBreakerPluginPage,
    ],
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
