import { parseDocument } from 'htmlparser2';
import { selectAll, selectOne } from 'css-select';
import { getAttributeValue, textContent } from 'domutils';
import { isTag, isText, type AnyNode, type Document, type Element } from 'domhandler';
import type {
  ContentInfo,
  HeadInfo,
  HeadingNode,
  Hreflang,
  ImageInventory,
  JsonLdBlock,
  LinkInventory,
  OpenGraphInfo,
  RobotsMeta,
  TwitterInfo,
} from './types';

export interface ExtractedDocument {
  head: HeadInfo;
  openGraph: OpenGraphInfo;
  twitter: TwitterInfo;
  jsonLd: JsonLdBlock[];
  content: ContentInfo;
}

/** Tags whose text a no-JS bot treats as chrome/boilerplate, not main content. */
const CHROME_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'nav',
  'footer',
  'header',
  'aside',
]);

/** JSON-LD types → the field crawlers expect present for that type to be usable. */
const REQUIRED_JSONLD_FIELDS: Record<string, string> = {
  Article: 'headline',
  NewsArticle: 'headline',
  BlogPosting: 'headline',
  Organization: 'name',
  Product: 'name',
  BreadcrumbList: 'itemListElement',
};

function attribute(element: Element | null, name: string): string | null {
  if (element === null) {
    return null;
  }
  return getAttributeValue(element, name) ?? null;
}

function trimmedTextOrNull(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function resolveUrl(href: string | null, base: string): string | null {
  if (href === null) {
    return null;
  }
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function metaContent(document: Document, selector: string): string | null {
  return trimmedTextOrNull(attribute(selectOne<AnyNode, Element>(selector, document), 'content'));
}

/** Reads `name="k"` first, then `property="k"` — sites use either for the same tag. */
function metaByNameOrProperty(document: Document, key: string): string | null {
  return (
    metaContent(document, `meta[name="${key}"]`) ?? metaContent(document, `meta[property="${key}"]`)
  );
}

function parseRobotsMeta(document: Document): RobotsMeta {
  const raw = metaContent(document, 'meta[name="robots"]');
  if (raw === null) {
    return { index: true, follow: true, raw: null };
  }
  const lowered = raw.toLowerCase();
  const none = lowered.includes('none');
  return {
    index: !none && !lowered.includes('noindex'),
    follow: !none && !lowered.includes('nofollow'),
    raw,
  };
}

function extractHead(document: Document, finalUrl: string): HeadInfo {
  const titleElement = selectOne<AnyNode, Element>('title', document);
  const canonical = resolveUrl(
    attribute(selectOne<AnyNode, Element>('link[rel="canonical"]', document), 'href'),
    finalUrl
  );

  const hreflang: Hreflang[] = selectAll<AnyNode, Element>(
    'link[rel="alternate"][hreflang]',
    document
  )
    .map((element) => {
      const lang = attribute(element, 'hreflang');
      const href = resolveUrl(attribute(element, 'href'), finalUrl);
      return lang !== null && href !== null ? { lang, href } : null;
    })
    .filter((entry): entry is Hreflang => entry !== null);

  const rssElement = selectOne<AnyNode, Element>(
    'link[rel="alternate"][type="application/rss+xml"], link[rel="alternate"][type="application/atom+xml"]',
    document
  );

  return {
    title: trimmedTextOrNull(titleElement === null ? null : textContent(titleElement)),
    metaDescription: metaContent(document, 'meta[name="description"]'),
    robotsMeta: parseRobotsMeta(document),
    canonical,
    canonicalIsCrossOrigin:
      canonical !== null && new URL(canonical).origin !== new URL(finalUrl).origin,
    viewport: metaContent(document, 'meta[name="viewport"]'),
    hreflang,
    rssAlternate: resolveUrl(attribute(rssElement, 'href'), finalUrl),
  };
}

function extractOpenGraph(document: Document): OpenGraphInfo {
  return {
    title: metaByNameOrProperty(document, 'og:title'),
    description: metaByNameOrProperty(document, 'og:description'),
    type: metaByNameOrProperty(document, 'og:type'),
    url: metaByNameOrProperty(document, 'og:url'),
    siteName: metaByNameOrProperty(document, 'og:site_name'),
    image: metaByNameOrProperty(document, 'og:image'),
    imageStatus: { checked: false, reachable: false, status: null },
  };
}

function extractTwitter(document: Document): TwitterInfo {
  return {
    card: metaByNameOrProperty(document, 'twitter:card'),
    title: metaByNameOrProperty(document, 'twitter:title'),
    description: metaByNameOrProperty(document, 'twitter:description'),
    image: metaByNameOrProperty(document, 'twitter:image'),
  };
}

function typeNamesOf(type: unknown): string[] {
  if (typeof type === 'string') {
    return [type];
  }
  if (Array.isArray(type)) {
    return type.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

function collectJsonLdTypes(value: unknown, into: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonLdTypes(item, into);
    }
    return;
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  const record = value as Record<string, unknown>;
  into.push(...typeNamesOf(record['@type']));
  if (Array.isArray(record['@graph'])) {
    collectJsonLdTypes(record['@graph'], into);
  }
}

function collectJsonLdErrors(value: unknown, into: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonLdErrors(item, into);
    }
    return;
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  const record = value as Record<string, unknown>;
  for (const name of typeNamesOf(record['@type'])) {
    const required = REQUIRED_JSONLD_FIELDS[name];
    if (required !== undefined && record[required] === undefined) {
      into.push(`${name} missing required field ${required}`);
    }
  }
  if (Array.isArray(record['@graph'])) {
    collectJsonLdErrors(record['@graph'], into);
  }
}

function extractJsonLd(document: Document): JsonLdBlock[] {
  const scripts = selectAll<AnyNode, Element>('script[type="application/ld+json"]', document);
  return scripts.map((script): JsonLdBlock => {
    const raw = textContent(script).trim();
    try {
      const parsed: unknown = JSON.parse(raw);
      const types: string[] = [];
      const errors: string[] = [];
      collectJsonLdTypes(parsed, types);
      collectJsonLdErrors(parsed, errors);
      return { raw, parsed: true, types, errors };
    } catch (error) {
      return {
        raw,
        parsed: false,
        types: [],
        errors: [`invalid JSON: ${(error as Error).message}`],
      };
    }
  });
}

function hasChromeAncestor(node: AnyNode): boolean {
  let current: AnyNode | null = node.parent;
  while (current !== null) {
    if (isTag(current) && CHROME_TAGS.has(current.name)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function collectVisibleText(node: AnyNode, parts: string[]): void {
  if (isText(node)) {
    if (!hasChromeAncestor(node)) {
      parts.push(node.data);
    }
    return;
  }
  if (isTag(node)) {
    for (const child of node.children) {
      collectVisibleText(child, parts);
    }
  }
}

function hasSkippedLevels(outline: HeadingNode[]): boolean {
  let previousLevel = 0;
  for (const heading of outline) {
    if (previousLevel !== 0 && heading.level - previousLevel > 1) {
      return true;
    }
    previousLevel = heading.level;
  }
  return false;
}

function bodyText(document: Document): string {
  const bodyElement: Element | Document = selectOne<AnyNode, Element>('body', document) ?? document;
  const textParts: string[] = [];
  for (const child of bodyElement.children) {
    collectVisibleText(child, textParts);
  }
  return textParts.join(' ').replaceAll(/\s+/g, ' ').trim();
}

function inventoryLinks(document: Document, finalUrl: string): LinkInventory {
  const baseOrigin = new URL(finalUrl).origin;
  const anchors = selectAll<AnyNode, Element>('a[href]', document);
  let internal = 0;
  let external = 0;
  let nofollow = 0;
  for (const anchor of anchors) {
    const resolved = resolveUrl(attribute(anchor, 'href'), finalUrl);
    if (!resolved?.startsWith('http')) {
      continue;
    }
    if (new URL(resolved).origin === baseOrigin) {
      internal += 1;
    } else {
      external += 1;
    }
    if (attribute(anchor, 'rel')?.toLowerCase().includes('nofollow')) {
      nofollow += 1;
    }
  }
  return { internal, external, nofollow };
}

function inventoryImages(document: Document): ImageInventory {
  const images = selectAll<AnyNode, Element>('img', document);
  const withAlt = images.filter((image) => (attribute(image, 'alt') ?? '').trim() !== '').length;
  return { total: images.length, withAlt };
}

function extractContent(document: Document, html: string, finalUrl: string): ContentInfo {
  const headings = selectAll<AnyNode, Element>('h1, h2, h3, h4, h5, h6', document);
  const headingOutline: HeadingNode[] = headings.map((element) => ({
    level: Number(element.name.slice(1)),
    text: textContent(element).trim(),
  }));
  const textBlob = bodyText(document);

  return {
    h1Count: headingOutline.filter((heading) => heading.level === 1).length,
    headingOutline,
    hasSkippedHeadingLevels: hasSkippedLevels(headingOutline),
    wordCount: textBlob === '' ? 0 : textBlob.split(' ').length,
    textToHtmlRatio: html.length === 0 ? 0 : Number((textBlob.length / html.length).toFixed(4)),
    links: inventoryLinks(document, finalUrl),
    images: inventoryImages(document),
    textBlob,
  };
}

/** Parse the raw HTML once and pull every no-JS crawler signal from it. */
export function extractDocument(html: string, finalUrl: string): ExtractedDocument {
  const document = parseDocument(html);
  return {
    head: extractHead(document, finalUrl),
    openGraph: extractOpenGraph(document),
    twitter: extractTwitter(document),
    jsonLd: extractJsonLd(document),
    content: extractContent(document, html, finalUrl),
  };
}
