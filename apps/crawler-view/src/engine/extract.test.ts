import { describe, it, expect } from 'vitest';
import { extractDocument } from './extract';

const BASE = 'https://example.com/blog/post';

const RICH_HTML = `<!doctype html>
<html lang="en">
  <head>
    <title>  A Great Post  </title>
    <meta name="description" content="A concise description." />
    <meta name="robots" content="index, follow" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="canonical" href="https://example.com/blog/post" />
    <link rel="alternate" hreflang="fr" href="/fr/blog/post" />
    <link rel="alternate" type="application/rss+xml" href="/feed.xml" />
    <meta property="og:title" content="OG Title" />
    <meta property="og:description" content="OG description" />
    <meta property="og:type" content="article" />
    <meta property="og:url" content="https://example.com/blog/post" />
    <meta property="og:site_name" content="Example" />
    <meta property="og:image" content="https://cdn.example.com/img.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="TW Title" />
    <meta name="twitter:description" content="TW description" />
    <meta name="twitter:image" content="https://cdn.example.com/tw.png" />
    <script type="application/ld+json">
      { "@context": "https://schema.org", "@type": "Article", "headline": "A Great Post" }
    </script>
  </head>
  <body>
    <nav><a href="/ignored">nav link</a></nav>
    <header>site header text</header>
    <main>
      <h1>Main Heading</h1>
      <p>This is the first paragraph with a fair amount of real content to read here today.</p>
      <h2>Subsection</h2>
      <p>More words follow in the body of this article for the crawler to ingest fully.</p>
      <a href="https://external.test/page">external</a>
      <a href="/internal" rel="nofollow">internal nofollow</a>
      <a href="/other">internal</a>
      <img src="/a.png" alt="has alt" />
      <img src="/b.png" />
    </main>
    <footer><a href="/footer">footer link</a> footer boilerplate</footer>
    <script>console.log('should be ignored');</script>
    <style>.x{color:red}</style>
  </body>
</html>`;

describe('extractDocument head', () => {
  it('reads title, description, viewport and robots meta', () => {
    const { head } = extractDocument(RICH_HTML, BASE);
    expect(head.title).toBe('A Great Post');
    expect(head.metaDescription).toBe('A concise description.');
    expect(head.viewport).toBe('width=device-width, initial-scale=1');
    expect(head.robotsMeta).toEqual({ index: true, follow: true, raw: 'index, follow' });
  });

  it('resolves canonical and flags cross-origin canonicals', () => {
    const { head } = extractDocument(RICH_HTML, BASE);
    expect(head.canonical).toBe('https://example.com/blog/post');
    expect(head.canonicalIsCrossOrigin).toBe(false);

    const crossHtml = '<link rel="canonical" href="https://other.test/x">';
    const cross = extractDocument(crossHtml, BASE);
    expect(cross.head.canonical).toBe('https://other.test/x');
    expect(cross.head.canonicalIsCrossOrigin).toBe(true);
  });

  it('resolves hreflang alternates and the rss alternate', () => {
    const { head } = extractDocument(RICH_HTML, BASE);
    expect(head.hreflang).toEqual([{ lang: 'fr', href: 'https://example.com/fr/blog/post' }]);
    expect(head.rssAlternate).toBe('https://example.com/feed.xml');
  });

  it('parses noindex/nofollow and none robots directives', () => {
    expect(
      extractDocument('<meta name="robots" content="noindex, nofollow">', BASE).head.robotsMeta
    ).toEqual({ index: false, follow: false, raw: 'noindex, nofollow' });
    expect(extractDocument('<meta name="robots" content="none">', BASE).head.robotsMeta).toEqual({
      index: false,
      follow: false,
      raw: 'none',
    });
  });

  it('treats whitespace-only meta content and invalid hrefs as null', () => {
    const document = extractDocument(
      '<meta name="description" content="   "><link rel="canonical" href="http://[bad">',
      BASE
    );
    expect(document.head.metaDescription).toBeNull();
    expect(document.head.canonical).toBeNull();
  });

  it('drops an hreflang alternate that has no href', () => {
    const { head } = extractDocument('<link rel="alternate" hreflang="de">', BASE);
    expect(head.hreflang).toEqual([]);
  });

  it('returns nulls when head signals are absent', () => {
    const { head } = extractDocument('<html><head></head><body></body></html>', BASE);
    expect(head.title).toBeNull();
    expect(head.metaDescription).toBeNull();
    expect(head.canonical).toBeNull();
    expect(head.canonicalIsCrossOrigin).toBe(false);
    expect(head.viewport).toBeNull();
    expect(head.hreflang).toEqual([]);
    expect(head.rssAlternate).toBeNull();
    expect(head.robotsMeta).toEqual({ index: true, follow: true, raw: null });
  });
});

describe('extractDocument openGraph and twitter', () => {
  it('reads open-graph tags with an unchecked image status', () => {
    const { openGraph } = extractDocument(RICH_HTML, BASE);
    expect(openGraph.title).toBe('OG Title');
    expect(openGraph.description).toBe('OG description');
    expect(openGraph.type).toBe('article');
    expect(openGraph.url).toBe('https://example.com/blog/post');
    expect(openGraph.siteName).toBe('Example');
    expect(openGraph.image).toBe('https://cdn.example.com/img.png');
    expect(openGraph.imageStatus).toEqual({ checked: false, reachable: false, status: null });
  });

  it('reads twitter card tags', () => {
    const { twitter } = extractDocument(RICH_HTML, BASE);
    expect(twitter).toEqual({
      card: 'summary_large_image',
      title: 'TW Title',
      description: 'TW description',
      image: 'https://cdn.example.com/tw.png',
    });
  });

  it('also reads twitter tags declared via property', () => {
    const { twitter } = extractDocument('<meta property="twitter:card" content="summary">', BASE);
    expect(twitter.card).toBe('summary');
  });
});

describe('extractDocument jsonLd', () => {
  it('parses a valid Article block and collects its types', () => {
    const { jsonLd } = extractDocument(RICH_HTML, BASE);
    expect(jsonLd).toHaveLength(1);
    expect(jsonLd[0]?.parsed).toBe(true);
    expect(jsonLd[0]?.types).toEqual(['Article']);
    expect(jsonLd[0]?.errors).toEqual([]);
  });

  it('captures a JSON parse error', () => {
    const { jsonLd } = extractDocument(
      '<script type="application/ld+json">{ not json }</script>',
      BASE
    );
    expect(jsonLd[0]?.parsed).toBe(false);
    expect(jsonLd[0]?.types).toEqual([]);
    expect(jsonLd[0]?.errors[0]).toMatch(/json/i);
  });

  it('flags a required-field error for a common type', () => {
    const { jsonLd } = extractDocument(
      '<script type="application/ld+json">{"@type":"Organization"}</script>',
      BASE
    );
    expect(jsonLd[0]?.parsed).toBe(true);
    expect(jsonLd[0]?.types).toEqual(['Organization']);
    expect(jsonLd[0]?.errors[0]).toMatch(/name/);
  });

  it('walks @graph and array type declarations', () => {
    const { jsonLd } = extractDocument(
      '<script type="application/ld+json">{"@graph":[{"@type":["Article","BlogPosting"],"headline":"x"},{"@type":"BreadcrumbList","itemListElement":[]}]}</script>',
      BASE
    );
    expect(jsonLd[0]?.types).toEqual(['Article', 'BlogPosting', 'BreadcrumbList']);
    expect(jsonLd[0]?.errors).toEqual([]);
  });

  it('ignores primitives, numeric @type, and non-string entries in @type arrays', () => {
    const { jsonLd } = extractDocument(
      '<script type="application/ld+json">[{"@type":["Article",123],"headline":"x"},"junk",{"@type":5},null]</script>',
      BASE
    );
    expect(jsonLd[0]?.parsed).toBe(true);
    expect(jsonLd[0]?.types).toEqual(['Article']);
    expect(jsonLd[0]?.errors).toEqual([]);
  });
});

describe('extractDocument content', () => {
  it('builds the heading outline and counts h1s', () => {
    const { content } = extractDocument(RICH_HTML, BASE);
    expect(content.h1Count).toBe(1);
    expect(content.headingOutline).toEqual([
      { level: 1, text: 'Main Heading' },
      { level: 2, text: 'Subsection' },
    ]);
    expect(content.hasSkippedHeadingLevels).toBe(false);
  });

  it('detects skipped heading levels', () => {
    const { content } = extractDocument('<h1>a</h1><h3>c</h3>', BASE);
    expect(content.hasSkippedHeadingLevels).toBe(true);
  });

  it('extracts a whitespace-collapsed text blob excluding chrome and scripts', () => {
    const { content } = extractDocument(RICH_HTML, BASE);
    expect(content.textBlob).toContain('Main Heading');
    expect(content.textBlob).toContain('first paragraph');
    expect(content.textBlob).not.toContain('should be ignored');
    expect(content.textBlob).not.toContain('color:red');
    expect(content.textBlob).not.toContain('nav link');
    expect(content.textBlob).not.toContain('footer boilerplate');
    expect(content.textBlob).not.toMatch(/\s{2,}/);
  });

  it('counts words and computes a text-to-html ratio', () => {
    const { content } = extractDocument(RICH_HTML, BASE);
    expect(content.wordCount).toBeGreaterThan(15);
    expect(content.textToHtmlRatio).toBeGreaterThan(0);
    expect(content.textToHtmlRatio).toBeLessThan(1);
  });

  it('inventories internal, external and nofollow links', () => {
    const { content } = extractDocument(RICH_HTML, BASE);
    expect(content.links.external).toBe(1);
    expect(content.links.internal).toBe(4);
    expect(content.links.nofollow).toBe(1);
  });

  it('inventories images and alt coverage', () => {
    const { content } = extractDocument(RICH_HTML, BASE);
    expect(content.images).toEqual({ total: 2, withAlt: 1 });
  });

  it('skips non-http and unparsable anchor hrefs and empty-string alts', () => {
    const { content } = extractDocument(
      '<a href="mailto:x@y.com">mail</a><a href="http://[bad">bad</a><a href="/ok">ok</a><img src="/c.png" alt="">',
      BASE
    );
    expect(content.links).toEqual({ internal: 1, external: 0, nofollow: 0 });
    expect(content.images).toEqual({ total: 1, withAlt: 0 });
  });

  it('ignores comment nodes when collecting text', () => {
    const { content } = extractDocument(
      '<body><!-- hidden note --><p>real words here now</p></body>',
      BASE
    );
    expect(content.textBlob).toBe('real words here now');
  });

  it('yields a zero ratio for empty html', () => {
    const { content } = extractDocument('', BASE);
    expect(content.textToHtmlRatio).toBe(0);
    expect(content.wordCount).toBe(0);
  });

  it('reports zero words for an empty shell', () => {
    const { content } = extractDocument('<html><body><div id="root"></div></body></html>', BASE);
    expect(content.wordCount).toBe(0);
    expect(content.textBlob).toBe('');
    expect(content.h1Count).toBe(0);
    expect(content.hasSkippedHeadingLevels).toBe(false);
  });
});
