import type { NavItem } from "../types";

export const NAV_ITEMS: readonly NavItem[] = [
  { id: "features", label: "Features" },
  { id: "quickstart", label: "Quick start" },
  { id: "example", label: "Example" },
  { id: "boundary", label: "Native vs JS" },
];

/** Stable section-id list for the scroll-spy (module-level so its identity is fixed). */
export const SECTION_IDS: readonly string[] = NAV_ITEMS.map((item) => item.id);

export const GITHUB_URL = "https://github.com/usetoki/toki";
export const NPM_URL = "https://www.npmjs.com/package/@usetoki/toki";
