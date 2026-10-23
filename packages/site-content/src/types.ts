/**
 * Shapes of the marketing content as the CMS REST API returns it (depth=1) and as apps/web renders it.
 * Payload adds extra fields (id, createdAt, row ids…); they are allowed and ignored.
 */

export const PAGE_SLUGS = [
  'home',
  'about',
  'services',
  'ai-medical-summary',
  'pricing',
  'resources',
  'contact',
] as const;
export type PageSlug = (typeof PAGE_SLUGS)[number];

/** Public route for each CMS page. */
export const PAGE_ROUTES: Record<PageSlug, string> = {
  home: '/',
  about: '/about',
  services: '/services',
  'ai-medical-summary': '/ai-medical-summary',
  pricing: '/pricing',
  resources: '/resources',
  contact: '/contact',
};

export const PAGE_LABELS: Record<PageSlug, string> = {
  home: 'Home',
  about: 'About Us',
  services: 'Services',
  'ai-medical-summary': 'AI Medical Summary',
  pricing: 'Pricing',
  resources: 'Resources',
  contact: 'Contact',
};

/** Lexical editor state (only the parts the web renderer understands). */
export interface LexicalNode {
  type: string;
  version?: number;
  children?: LexicalNode[];
  text?: string;
  /** text format bitmask: 1 bold, 2 italic, 8 underline, 16 code */
  format?: number | string;
  tag?: string;
  listType?: 'bullet' | 'number' | 'check';
  url?: string;
  fields?: { url?: string; newTab?: boolean; linkType?: string };
  [key: string]: unknown;
}
export interface RichText {
  root: LexicalNode;
}

/** An upload as returned at depth >= 1 (relative url on the CMS origin), or an unresolved id. */
export type MediaRef = { url?: string | null; alt?: string | null } | string | number | null;

export interface Cta {
  label: string;
  href: string;
  variant?: 'primary' | 'secondary' | null;
}

export interface Seo {
  title?: string | null;
  description?: string | null;
  ogImage?: MediaRef;
}

export interface Item {
  title: string;
  body: string;
}

export type Block =
  | { blockType: 'features'; heading: string; intro?: string | null; items: Item[] }
  | { blockType: 'steps'; heading: string; intro?: string | null; items: Item[] }
  | { blockType: 'content'; heading?: string | null; body: RichText }
  | { blockType: 'faq'; heading: string; items: { question: string; answer: string }[] }
  | { blockType: 'cta'; heading: string; body?: string | null; cta: Cta };

export interface PricingCopy {
  heading: string;
  intro?: string | null;
  highlightedPlan?: string | null;
  includedPagesLabel: string;
  overageLabel: string;
  cardCta: Cta;
  footnote?: string | null;
  unavailableMessage: string;
  taglines?: { planName: string; tagline: string }[] | null;
}

export interface ContactFormCopy {
  kindLabel: string;
  demoOption: string;
  contactOption: string;
  nameLabel: string;
  companyLabel: string;
  emailLabel: string;
  phoneLabel: string;
  messageLabel: string;
  submitLabel: string;
  sendingLabel: string;
  successMessage: string;
}

export interface Page {
  slug: PageSlug;
  title: string;
  hero: {
    eyebrow?: string | null;
    heading: string;
    subheading?: string | null;
    ctas?: Cta[] | null;
  };
  sections?: Block[] | null;
  pricing?: PricingCopy | null;
  contactForm?: ContactFormCopy | null;
  seo?: Seo | null;
}

export interface Post {
  title: string;
  slug: string;
  excerpt: string;
  author?: string | null;
  publishedAt: string;
  coverImage?: MediaRef;
  body: RichText;
  seo?: Seo | null;
}

export interface Site {
  siteName: string;
  nav: { label: string; href: string }[];
  headerCta: Cta;
  footer: { tagline: string; legal: string };
  cookieBanner: {
    message: string;
    acceptLabel: string;
    declineLabel: string;
  };
}
