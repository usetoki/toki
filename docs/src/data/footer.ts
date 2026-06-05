import type { FooterGroup } from "../types";
import { GITHUB_URL, NPM_URL } from "./nav";

export const FOOTER_GROUPS: readonly FooterGroup[] = [
  {
    title: "Docs",
    links: [
      { label: "Quick start", href: "#quickstart" },
      { label: "Example", href: "#example" },
      { label: "Native vs JS", href: "#boundary" },
    ],
  },
  {
    title: "Project",
    links: [
      { label: "GitHub", href: GITHUB_URL },
      { label: "npm", href: NPM_URL },
      { label: "Changelog", href: `${GITHUB_URL}/blob/main/CHANGELOG.md` },
    ],
  },
  {
    title: "Reference",
    links: [
      { label: "README", href: `${GITHUB_URL}#readme` },
      { label: "License (MIT)", href: `${GITHUB_URL}/blob/main/LICENSE` },
      { label: "Issues", href: `${GITHUB_URL}/issues` },
    ],
  },
];
