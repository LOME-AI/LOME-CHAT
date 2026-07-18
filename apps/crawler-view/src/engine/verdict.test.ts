import { describe, it, expect } from 'vitest';
import { buildVerdict, type VerdictInput, MIN_CRAWLABLE_WORDS } from './verdict';
import { PERSONAS } from './personas';
import type { Finding } from './types';

function healthyInput(): VerdictInput {
  return {
    url: 'https://example.com/',
    fetchedAt: '2026-07-16T00:00:00.000Z',
    http: {
      status: 200,
      ok: true,
      finalUrl: 'https://example.com/',
      redirectChain: [],
      contentType: 'text/html',
      xRobotsTag: null,
    },
    head: {
      title: 'Title',
      metaDescription: 'Description',
      robotsMeta: { index: true, follow: true, raw: null },
      canonical: 'https://example.com/',
      canonicalIsCrossOrigin: false,
      viewport: 'width=device-width',
      hreflang: [],
      rssAlternate: null,
    },
    openGraph: {
      title: 'OG',
      description: 'OG desc',
      type: 'website',
      url: 'https://example.com/',
      siteName: 'Example',
      image: 'https://cdn.example.com/i.png',
      imageStatus: { checked: true, reachable: true, status: 200 },
    },
    twitter: {
      card: 'summary',
      title: 'T',
      description: 'D',
      image: 'https://cdn.example.com/t.png',
    },
    jsonLd: [{ raw: '{}', parsed: true, types: ['Article'], errors: [] }],
    content: {
      h1Count: 1,
      headingOutline: [{ level: 1, text: 'H' }],
      hasSkippedHeadingLevels: false,
      wordCount: 400,
      textToHtmlRatio: 0.4,
      links: { internal: 5, external: 2, nofollow: 0 },
      images: { total: 3, withAlt: 3 },
      textBlob: 'lots of real content',
    },
    robots: {
      fetched: true,
      xRobotsTag: null,
      perPersona: PERSONAS.map((persona) => ({
        personaId: persona.id,
        allowed: true,
        matchedRule: null,
      })),
    },
    sitemap: { checked: true, found: true, urlListed: true },
    cloaking: { checked: true, divergent: false, detail: null },
  };
}

function levels(findings: Finding[]): string[] {
  return findings.map((finding) => finding.level);
}

describe('buildVerdict', () => {
  it('passes every audience for a healthy page', () => {
    const verdict = buildVerdict(healthyInput());
    expect(levels(verdict.ai)).toEqual(['pass']);
    expect(levels(verdict.search)).toEqual(['pass']);
    expect(levels(verdict.social)).toEqual(['pass']);
  });

  it('fails ai and search when the crawlable text is near-empty', () => {
    const input = healthyInput();
    input.content.wordCount = 0;
    const verdict = buildVerdict(input);
    const aiFail = verdict.ai.find((finding) => finding.level === 'fail');
    const searchFail = verdict.search.find((finding) => finding.level === 'fail');
    expect(aiFail?.bots).toContain('GPTBot');
    expect(searchFail?.bots).toContain('Googlebot');
    expect(MIN_CRAWLABLE_WORDS).toBe(20);
  });

  it('warns search on a missing title and description', () => {
    const input = healthyInput();
    input.head.title = null;
    input.head.metaDescription = null;
    const messages = buildVerdict(input).search.map((finding) => finding.message);
    expect(messages.some((message) => /title/i.test(message))).toBe(true);
    expect(messages.some((message) => /description/i.test(message))).toBe(true);
  });

  it('warns search when there is no valid structured data', () => {
    const input = healthyInput();
    input.jsonLd = [];
    expect(
      buildVerdict(input).search.some((finding) => /structured data/i.test(finding.message))
    ).toBe(true);
  });

  it('surfaces structured-data errors', () => {
    const input = healthyInput();
    input.jsonLd = [
      {
        raw: '{}',
        parsed: true,
        types: ['Organization'],
        errors: ['Organization missing required field name'],
      },
    ];
    expect(buildVerdict(input).search.some((finding) => finding.message.includes('name'))).toBe(
      true
    );
  });

  it('fails social on a missing og:image and warns on a missing og:title', () => {
    const input = healthyInput();
    input.openGraph.image = null;
    input.openGraph.title = null;
    const social = buildVerdict(input).social;
    expect(
      social.some((finding) => finding.level === 'fail' && /og:image/i.test(finding.message))
    ).toBe(true);
    expect(
      social.some((finding) => finding.level === 'warn' && /og:title/i.test(finding.message))
    ).toBe(true);
  });

  it('fails social on an unreachable og:image', () => {
    const input = healthyInput();
    input.openGraph.imageStatus = { checked: true, reachable: false, status: 404 };
    expect(
      buildVerdict(input).social.some(
        (finding) => finding.level === 'fail' && /unreachable/i.test(finding.message)
      )
    ).toBe(true);
  });

  it('fails the audience of a robots-blocked persona and names it', () => {
    const input = healthyInput();
    input.robots.perPersona = input.robots.perPersona.map((entry) =>
      entry.personaId === 'gptbot'
        ? { personaId: 'gptbot', allowed: false, matchedRule: 'Disallow: /x' }
        : entry
    );
    const aiFail = buildVerdict(input).ai.find((finding) => finding.level === 'fail');
    expect(aiFail?.bots).toEqual(['GPTBot']);
    expect(aiFail?.message).toMatch(/robots/i);
  });

  it('warns search on a cross-origin canonical', () => {
    const input = healthyInput();
    input.head.canonical = 'https://other.test/x';
    input.head.canonicalIsCrossOrigin = true;
    expect(buildVerdict(input).search.some((finding) => /canonical/i.test(finding.message))).toBe(
      true
    );
  });

  it('warns every audience when cloaking is detected', () => {
    const input = healthyInput();
    input.cloaking = { checked: true, divergent: true, detail: 'different HTML served to bots' };
    const verdict = buildVerdict(input);
    expect(verdict.ai.some((finding) => /cloaking/i.test(finding.message))).toBe(true);
    expect(verdict.search.some((finding) => /cloaking/i.test(finding.message))).toBe(true);
    expect(verdict.social.some((finding) => /cloaking/i.test(finding.message))).toBe(true);
  });

  it('fails search on an x-robots-tag noindex header', () => {
    const input = healthyInput();
    input.http.xRobotsTag = 'noindex';
    expect(
      buildVerdict(input).search.some(
        (finding) => finding.level === 'fail' && /noindex/i.test(finding.message)
      )
    ).toBe(true);
  });

  it('describes a network-error og:image (null status)', () => {
    const input = healthyInput();
    input.openGraph.imageStatus = { checked: true, reachable: false, status: null };
    expect(
      buildVerdict(input).social.some((finding) => /network error/i.test(finding.message))
    ).toBe(true);
  });

  it('names a robots block even when the matched rule is unknown', () => {
    const input = healthyInput();
    input.robots.perPersona = input.robots.perPersona.map((entry) =>
      entry.personaId === 'gptbot'
        ? { personaId: 'gptbot', allowed: false, matchedRule: null }
        : entry
    );
    const aiFail = buildVerdict(input).ai.find((finding) => finding.level === 'fail');
    expect(aiFail?.message).toBe('Blocked by robots.txt.');
  });

  it('handles a cross-origin canonical with an unknown href', () => {
    const input = healthyInput();
    input.head.canonical = null;
    input.head.canonicalIsCrossOrigin = true;
    expect(buildVerdict(input).search.some((finding) => /unknown/i.test(finding.message))).toBe(
      true
    );
  });

  it('falls back to a generic cloaking message when detail is absent', () => {
    const input = healthyInput();
    input.cloaking = { checked: true, divergent: true, detail: null };
    expect(
      buildVerdict(input).ai.some((finding) => /different responses/i.test(finding.message))
    ).toBe(true);
  });

  it('fails search on a robots meta noindex', () => {
    const input = healthyInput();
    input.head.robotsMeta = { index: false, follow: true, raw: 'noindex' };
    expect(
      buildVerdict(input).search.some(
        (finding) => finding.level === 'fail' && /noindex/i.test(finding.message)
      )
    ).toBe(true);
  });
});
