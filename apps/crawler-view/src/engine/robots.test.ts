import { describe, it, expect } from 'vitest';
import { parseRobots, isAllowed, analyzeRobots } from './robots';
import { mockFetch } from './__test-fixtures-mocks__/mock-fetch';

describe('parseRobots', () => {
  it('groups user-agents with their rules and collects sitemaps', () => {
    const parsed = parseRobots(
      [
        'User-agent: GPTBot',
        'Disallow: /private',
        'Allow: /private/public',
        '',
        'User-agent: *',
        'Disallow:',
        '',
        'Sitemap: https://example.com/sitemap.xml',
      ].join('\n')
    );
    expect(parsed.groups).toHaveLength(2);
    expect(parsed.groups[0]?.userAgents).toEqual(['GPTBot']);
    expect(parsed.sitemaps).toEqual(['https://example.com/sitemap.xml']);
  });

  it('ignores comments and blank lines', () => {
    const parsed = parseRobots('# comment\nUser-agent: *\nDisallow: /x\n');
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0]?.rules[0]).toEqual({ type: 'disallow', path: '/x' });
  });

  it('shares one group across consecutive user-agent lines', () => {
    const parsed = parseRobots('User-agent: A\nUser-agent: B\nDisallow: /x');
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0]?.userAgents).toEqual(['A', 'B']);
  });

  it('skips lines with no colon and unrecognized directives', () => {
    const parsed = parseRobots('garbage line\nUser-agent: *\nCrawl-delay: 5\nDisallow: /x');
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0]?.rules).toEqual([{ type: 'disallow', path: '/x' }]);
  });
});

describe('isAllowed', () => {
  const parsed = parseRobots(
    ['User-agent: GPTBot', 'Disallow: /x', 'User-agent: *', 'Allow: /'].join('\n')
  );

  it('disallows a blocked path for the matching token', () => {
    const result = isAllowed(parsed, 'GPTBot', '/x/page');
    expect(result.allowed).toBe(false);
    expect(result.matchedRule).toBe('Disallow: /x');
  });

  it('allows an unblocked path for the matching token', () => {
    expect(isAllowed(parsed, 'GPTBot', '/ok').allowed).toBe(true);
  });

  it('falls back to the wildcard group for an unlisted token', () => {
    expect(isAllowed(parsed, 'Bingbot', '/x/page').allowed).toBe(true);
  });

  it('allows everything when no group matches and there is no wildcard', () => {
    const noWildcard = parseRobots('User-agent: GPTBot\nDisallow: /');
    const result = isAllowed(noWildcard, 'Bingbot', '/anything');
    expect(result).toEqual({ allowed: true, matchedRule: null });
  });

  it('treats an empty Disallow as allow-all', () => {
    const emptyDisallow = parseRobots('User-agent: *\nDisallow:');
    expect(isAllowed(emptyDisallow, 'GPTBot', '/anything').allowed).toBe(true);
  });

  it('honors longest-match precedence with an Allow override', () => {
    const parsedOverride = parseRobots(
      ['User-agent: *', 'Disallow: /folder', 'Allow: /folder/keep'].join('\n')
    );
    expect(isAllowed(parsedOverride, 'GPTBot', '/folder/keep').allowed).toBe(true);
    expect(isAllowed(parsedOverride, 'GPTBot', '/folder/drop').allowed).toBe(false);
  });

  it('lets an equal-length Allow win the tie over a Disallow', () => {
    const parsedTie = parseRobots('User-agent: *\nDisallow: /x\nAllow: /x');
    expect(isAllowed(parsedTie, 'GPTBot', '/x').allowed).toBe(true);
  });

  it('keeps the longer match when a later matching rule is shorter', () => {
    const parsedLose = parseRobots('User-agent: *\nDisallow: /a/b\nDisallow: /a');
    const result = isAllowed(parsedLose, 'GPTBot', '/a/b/c');
    expect(result).toEqual({ allowed: false, matchedRule: 'Disallow: /a/b' });
  });

  it('keeps a matched empty specific group governing instead of falling back to *', () => {
    const emptyGroup = parseRobots(
      ['User-agent: GPTBot', '', 'User-agent: *', 'Disallow: /'].join('\n')
    );
    expect(isAllowed(emptyGroup, 'GPTBot', '/anything').allowed).toBe(true);
    expect(isAllowed(emptyGroup, 'Bingbot', '/anything').allowed).toBe(false);
  });

  it('keeps a matched empty specific group governing even after the * group', () => {
    const emptyGroup = parseRobots(
      ['User-agent: *', 'Disallow: /', 'User-agent: GPTBot'].join('\n')
    );
    expect(isAllowed(emptyGroup, 'GPTBot', '/anything').allowed).toBe(true);
  });

  it('matches a robots group that is a prefix of the token, not an interior substring', () => {
    const googlePrefix = parseRobots('User-agent: Google\nDisallow: /x');
    expect(isAllowed(googlePrefix, 'Googlebot', '/x/page').allowed).toBe(false);
    const interior = parseRobots('User-agent: bot\nDisallow: /');
    expect(isAllowed(interior, 'bingbot', '/anything').allowed).toBe(true);
  });

  it('supports * wildcards and $ end-anchors', () => {
    const wildcardRules = parseRobots(
      ['User-agent: *', 'Disallow: /*.pdf$', 'Disallow: /a/*/b'].join('\n')
    );
    expect(isAllowed(wildcardRules, 'GPTBot', '/docs/file.pdf').allowed).toBe(false);
    expect(isAllowed(wildcardRules, 'GPTBot', '/docs/file.pdf?x=1').allowed).toBe(true);
    expect(isAllowed(wildcardRules, 'GPTBot', '/a/mid/b').allowed).toBe(false);
  });
});

describe('analyzeRobots', () => {
  it('evaluates every persona and returns sitemaps when robots.txt is present', async () => {
    const robotsBody = [
      'User-agent: GPTBot',
      'Disallow: /x',
      'Sitemap: https://example.com/s.xml',
    ].join('\n');
    const fetchImpl = mockFetch(() => new Response(robotsBody, { status: 200 }));
    const result = await analyzeRobots('https://example.com', '/x/page', fetchImpl);
    expect(result.fetched).toBe(true);
    expect(result.sitemaps).toEqual(['https://example.com/s.xml']);
    const gptbot = result.perPersona.find((entry) => entry.personaId === 'gptbot');
    const bingbot = result.perPersona.find((entry) => entry.personaId === 'bingbot');
    expect(gptbot?.allowed).toBe(false);
    expect(bingbot?.allowed).toBe(true);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://example.com/robots.txt');
  });

  it('treats a missing robots.txt as fully allowed with no sitemaps', async () => {
    const fetchImpl = mockFetch(() => new Response('', { status: 404 }));
    const result = await analyzeRobots('https://example.com', '/', fetchImpl);
    expect(result.fetched).toBe(false);
    expect(result.sitemaps).toEqual([]);
    expect(result.perPersona.every((entry) => entry.allowed)).toBe(true);
  });

  it('treats a network error as fully allowed', async () => {
    const fetchImpl = mockFetch(() => {
      throw new Error('offline');
    });
    const result = await analyzeRobots('https://example.com', '/', fetchImpl);
    expect(result.fetched).toBe(false);
    expect(result.perPersona.every((entry) => entry.allowed)).toBe(true);
  });
});
