import {
  AUDIENCES,
  type Audience,
  type CrawlView,
  type Finding,
  type PrimarySignal,
} from './types';
import { PERSONAS } from './personas';

export type VerdictInput = Omit<CrawlView, 'verdict'>;

type PushFinding = (audience: Audience, finding: Finding) => void;

/**
 * Below this word count a no-JavaScript crawler is effectively looking at a blank
 * page — the SPA-shell failure this whole tool exists to catch.
 */
export const MIN_CRAWLABLE_WORDS = 20;

const TEXT_AUDIENCES: Audience[] = ['ai', 'search'];

function labelsFor(audience: Audience, signal?: PrimarySignal): string[] {
  return PERSONAS.filter(
    (persona) =>
      persona.category === audience &&
      (signal === undefined || persona.primarySignals.includes(signal))
  ).map((persona) => persona.label);
}

function addTextFindings(input: VerdictInput, push: PushFinding): void {
  if (input.content.wordCount >= MIN_CRAWLABLE_WORDS) {
    return;
  }
  const words = String(input.content.wordCount);
  for (const audience of TEXT_AUDIENCES) {
    // `ai` and `search` always carry text-signal personas, so this is never empty.
    push(audience, {
      level: 'fail',
      message: `Only ${words} words of crawlable text — these no-JavaScript crawlers receive a near-empty page.`,
      bots: labelsFor(audience, 'text'),
    });
  }
}

function addHeadFindings(input: VerdictInput, push: PushFinding): void {
  const searchBots = labelsFor('search');
  if (input.head.title === null) {
    push('search', { level: 'warn', message: 'Missing <title> element.', bots: searchBots });
  }
  if (input.head.metaDescription === null) {
    push('search', { level: 'warn', message: 'Missing meta description.', bots: searchBots });
  }
}

function addJsonLdFindings(input: VerdictInput, push: PushFinding): void {
  const jsonLdBots = labelsFor('search', 'jsonld');
  const hasValidJsonLd = input.jsonLd.some((block) => block.parsed && block.types.length > 0);
  if (!hasValidJsonLd) {
    push('search', {
      level: 'warn',
      message: 'No structured data (JSON-LD) — richer search results are unavailable.',
      bots: jsonLdBots,
    });
  }
  const jsonLdErrors = input.jsonLd.flatMap((block) => block.errors);
  if (jsonLdErrors.length > 0) {
    push('search', {
      level: 'warn',
      message: `Structured data issues: ${jsonLdErrors.join('; ')}.`,
      bots: jsonLdBots,
    });
  }
}

function addSocialFindings(input: VerdictInput, push: PushFinding): void {
  const ogBots = labelsFor('social', 'og');
  const { image, imageStatus, title } = input.openGraph;
  if (image === null) {
    push('social', {
      level: 'fail',
      message: 'No og:image — social platforms cannot render a link preview.',
      bots: ogBots,
    });
  } else if (imageStatus.checked && !imageStatus.reachable) {
    const reason =
      imageStatus.status === null ? 'network error' : `status ${String(imageStatus.status)}`;
    push('social', {
      level: 'fail',
      message: `og:image is unreachable (${reason}).`,
      bots: ogBots,
    });
  }
  if (title === null) {
    push('social', {
      level: 'warn',
      message: 'No og:title — the preview falls back to the page <title> or nothing.',
      bots: ogBots,
    });
  }
}

function addRobotsFindings(input: VerdictInput, push: PushFinding): void {
  for (const audience of AUDIENCES) {
    const blocked = PERSONAS.filter((persona) => {
      const entry = input.robots.perPersona.find((result) => result.personaId === persona.id);
      return persona.category === audience && entry !== undefined && !entry.allowed;
    });
    if (blocked.length === 0) {
      continue;
    }
    const rules = [
      ...new Set(
        blocked
          .map(
            (persona) =>
              input.robots.perPersona.find((result) => result.personaId === persona.id)?.matchedRule
          )
          .filter((rule): rule is string => rule != null)
      ),
    ];
    const suffix = rules.length > 0 ? ` (${rules.join(', ')})` : '';
    push(audience, {
      level: 'fail',
      message: `Blocked by robots.txt${suffix}.`,
      bots: blocked.map((persona) => persona.label),
    });
  }
}

function addCanonicalFindings(input: VerdictInput, push: PushFinding): void {
  if (!input.head.canonicalIsCrossOrigin) {
    return;
  }
  const target = input.head.canonical ?? 'unknown';
  push('search', {
    level: 'warn',
    message: `Canonical points to a different origin (${target}) — that URL may be indexed instead.`,
    bots: labelsFor('search'),
  });
}

function addCloakingFindings(input: VerdictInput, push: PushFinding): void {
  if (!input.cloaking.divergent) {
    return;
  }
  const detail = input.cloaking.detail ?? 'bots and browsers receive different responses';
  for (const audience of AUDIENCES) {
    push(audience, {
      level: 'warn',
      message: `Cloaking detected: ${detail}.`,
      bots: labelsFor(audience),
    });
  }
}

function addNoindexFindings(input: VerdictInput, push: PushFinding): void {
  const headerNoindex = input.http.xRobotsTag?.toLowerCase().includes('noindex') ?? false;
  if (!headerNoindex && input.head.robotsMeta.index) {
    return;
  }
  push('search', {
    level: 'fail',
    message: 'A noindex directive is present — search engines will drop this page.',
    bots: labelsFor('search'),
  });
}

/**
 * Reduce the assembled signals into an audience-grouped PASS/WARN/FAIL verdict.
 * Each finding names the persona labels it actually breaks; an audience with no
 * problems gets a single explicit PASS.
 */
export function buildVerdict(input: VerdictInput): Record<Audience, Finding[]> {
  const verdict: Record<Audience, Finding[]> = { ai: [], search: [], social: [] };
  const push: PushFinding = (audience, finding) => {
    verdict[audience].push(finding);
  };

  addTextFindings(input, push);
  addHeadFindings(input, push);
  addJsonLdFindings(input, push);
  addSocialFindings(input, push);
  addRobotsFindings(input, push);
  addCanonicalFindings(input, push);
  addCloakingFindings(input, push);
  addNoindexFindings(input, push);

  for (const audience of AUDIENCES) {
    if (verdict[audience].length === 0) {
      push(audience, {
        level: 'pass',
        message: 'No blocking issues for these crawlers.',
        bots: labelsFor(audience),
      });
    }
  }

  return verdict;
}
