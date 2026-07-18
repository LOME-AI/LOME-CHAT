/**
 * The CrawlView contract — the stable shape every downstream consumer (the HTTP
 * wrapper and the UI) depends on. Field names here are load-bearing; add fields,
 * never rename these.
 *
 * `AUDIENCES` / `VERDICTS` are runtime const arrays (not just types) so this
 * module is genuinely imported at runtime — a types-only module would be erased
 * by the compiler and then report as uncovered under the engine coverage gate.
 */

export const AUDIENCES = ['ai', 'search', 'social'] as const;
export type Audience = (typeof AUDIENCES)[number];

export const VERDICTS = ['pass', 'warn', 'fail'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface Finding {
  level: Verdict;
  message: string;
  /** Affected persona labels. */
  bots: string[];
}

export interface RedirectHop {
  from: string;
  to: string;
  status: number;
}

export interface HttpInfo {
  status: number;
  ok: boolean;
  finalUrl: string;
  redirectChain: RedirectHop[];
  contentType: string | null;
  xRobotsTag: string | null;
}

export interface RobotsMeta {
  index: boolean;
  follow: boolean;
  raw: string | null;
}

export interface Hreflang {
  lang: string;
  href: string;
}

export interface HeadInfo {
  title: string | null;
  metaDescription: string | null;
  robotsMeta: RobotsMeta;
  canonical: string | null;
  canonicalIsCrossOrigin: boolean;
  viewport: string | null;
  hreflang: Hreflang[];
  rssAlternate: string | null;
}

export interface OpenGraphImageStatus {
  checked: boolean;
  reachable: boolean;
  status: number | null;
}

export interface OpenGraphInfo {
  title: string | null;
  description: string | null;
  type: string | null;
  url: string | null;
  siteName: string | null;
  image: string | null;
  imageStatus: OpenGraphImageStatus;
}

export interface TwitterInfo {
  card: string | null;
  title: string | null;
  description: string | null;
  image: string | null;
}

export interface JsonLdBlock {
  raw: string;
  parsed: boolean;
  types: string[];
  errors: string[];
}

export interface HeadingNode {
  level: number;
  text: string;
}

export interface LinkInventory {
  internal: number;
  external: number;
  nofollow: number;
}

export interface ImageInventory {
  total: number;
  withAlt: number;
}

export interface ContentInfo {
  h1Count: number;
  headingOutline: HeadingNode[];
  hasSkippedHeadingLevels: boolean;
  wordCount: number;
  textToHtmlRatio: number;
  links: LinkInventory;
  images: ImageInventory;
  /** Main-content plain text an AI bot ingests. */
  textBlob: string;
}

export interface PersonaRobotsResult {
  personaId: string;
  allowed: boolean;
  matchedRule: string | null;
}

export interface RobotsInfo {
  fetched: boolean;
  xRobotsTag: string | null;
  perPersona: PersonaRobotsResult[];
}

export interface SitemapInfo {
  checked: boolean;
  found: boolean;
  urlListed: boolean;
}

export interface CloakingInfo {
  checked: boolean;
  divergent: boolean;
  detail: string | null;
}

export interface CrawlView {
  url: string;
  fetchedAt: string;
  http: HttpInfo;
  head: HeadInfo;
  openGraph: OpenGraphInfo;
  twitter: TwitterInfo;
  jsonLd: JsonLdBlock[];
  content: ContentInfo;
  robots: RobotsInfo;
  sitemap: SitemapInfo;
  cloaking: CloakingInfo;
  verdict: Record<Audience, Finding[]>;
}

/** Signals a persona relies on — drives which verdict findings apply to it. */
export type PrimarySignal = 'text' | 'jsonld' | 'og' | 'twitter';

export interface Persona {
  id: string;
  label: string;
  vendor: string;
  category: Audience;
  userAgent: string;
  /** Stable robots.txt token substring — matched, never the volatile full UA. */
  robotsToken: string;
  executesJs: boolean;
  primarySignals: PrimarySignal[];
}
