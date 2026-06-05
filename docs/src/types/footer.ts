export interface FooterLink {
  readonly label: string;
  readonly href: string;
}

export interface FooterGroup {
  readonly title: string;
  readonly links: readonly FooterLink[];
}
