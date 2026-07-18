import { PERSONAS, matchRobotsToken } from './personas';
import type { PersonaRobotsResult } from './types';

export type RuleType = 'allow' | 'disallow';

export interface RobotsRule {
  type: RuleType;
  path: string;
}

export interface RobotsGroup {
  userAgents: string[];
  rules: RobotsRule[];
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
}

export interface AllowResult {
  allowed: boolean;
  matchedRule: string | null;
}

export interface RobotsAnalysis {
  fetched: boolean;
  perPersona: PersonaRobotsResult[];
  sitemaps: string[];
}

/**
 * `Google-Extended` is checked here only as an AI-training opt-out token layered
 * on Googlebot; it never gates plain fetch access, so it does not affect the
 * `allowed` flags below (those describe crawl access, not training consent).
 */
interface ParseState {
  groups: RobotsGroup[];
  sitemaps: string[];
  current: RobotsGroup | null;
  boundary: boolean;
}

function addUserAgent(state: ParseState, value: string): void {
  // A fresh group starts when the current group already has a rule, or when a
  // blank line has separated this user-agent from the previous one. Only
  // user-agent lines with nothing between them share one group — so a specific
  // agent stated as its own (possibly empty) group is never absorbed into a
  // later `*` group.
  if (state.current === null || state.current.rules.length > 0 || state.boundary) {
    state.current = { userAgents: [], rules: [] };
    state.groups.push(state.current);
  }
  state.boundary = false;
  state.current.userAgents.push(value);
}

function handleLine(line: string, state: ParseState): void {
  if (line === '') {
    state.boundary = true;
    return;
  }
  if (line.startsWith('#')) {
    return;
  }
  const separator = line.indexOf(':');
  if (separator === -1) {
    return;
  }
  const field = line.slice(0, separator).trim().toLowerCase();
  const value = line.slice(separator + 1).trim();

  if (field === 'user-agent') {
    addUserAgent(state, value);
  } else if ((field === 'allow' || field === 'disallow') && state.current !== null) {
    state.current.rules.push({ type: field, path: value });
  } else if (field === 'sitemap') {
    state.sitemaps.push(value);
  }
}

export function parseRobots(text: string): ParsedRobots {
  const state: ParseState = { groups: [], sitemaps: [], current: null, boundary: false };
  for (const rawLine of text.split('\n')) {
    handleLine(rawLine.trim(), state);
  }
  return { groups: state.groups, sitemaps: state.sitemaps };
}

function ruleMatches(pattern: string, path: string): boolean {
  if (pattern === '') {
    return false;
  }
  let body = pattern;
  let anchorEnd = false;
  if (body.endsWith('$')) {
    anchorEnd = true;
    body = body.slice(0, -1);
  }
  const escaped = body.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`).replaceAll('*', '.*');
  return new RegExp(`^${escaped}${anchorEnd ? '$' : ''}`).test(path);
}

/**
 * Rules applicable to a token: the specific group(s) if the token matches any,
 * else the `*` group. A matched specific group governs even when it is empty
 * (RFC 9309 / Google) — an agent named by a zero-rule group is allowed
 * everything and must NOT fall back to `*`.
 */
function applicableRules(parsed: ParsedRobots, token: string): RobotsRule[] {
  const specific: RobotsRule[] = [];
  const wildcard: RobotsRule[] = [];
  let matchedSpecific = false;
  for (const group of parsed.groups) {
    for (const userAgent of group.userAgents) {
      if (userAgent === '*') {
        wildcard.push(...group.rules);
      } else if (matchRobotsToken(userAgent, token)) {
        matchedSpecific = true;
        specific.push(...group.rules);
      }
    }
  }
  return matchedSpecific ? specific : wildcard;
}

/**
 * Robots.txt access decision with Google's longest-match precedence: among
 * matching rules the longest pattern wins, and an Allow ties out over a Disallow.
 */
export function isAllowed(parsed: ParsedRobots, token: string, path: string): AllowResult {
  let best: RobotsRule | null = null;
  for (const rule of applicableRules(parsed, token)) {
    if (!ruleMatches(rule.path, path)) {
      continue;
    }
    if (
      best === null ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.type === 'allow')
    ) {
      best = rule;
    }
  }
  if (best === null) {
    return { allowed: true, matchedRule: null };
  }
  const label = best.type === 'allow' ? 'Allow' : 'Disallow';
  return { allowed: best.type === 'allow', matchedRule: `${label}: ${best.path}` };
}

function allowAll(): PersonaRobotsResult[] {
  return PERSONAS.map((persona) => ({ personaId: persona.id, allowed: true, matchedRule: null }));
}

/** Fetch `/robots.txt` for the origin and evaluate every persona against `path`. */
export async function analyzeRobots(
  origin: string,
  path: string,
  fetchImpl: typeof fetch = fetch
): Promise<RobotsAnalysis> {
  const robotsUrl = new URL('/robots.txt', origin).toString();
  try {
    const response = await fetchImpl(robotsUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      return { fetched: false, perPersona: allowAll(), sitemaps: [] };
    }
    const parsed = parseRobots(await response.text());
    const perPersona = PERSONAS.map((persona) => ({
      personaId: persona.id,
      ...isAllowed(parsed, persona.robotsToken, path),
    }));
    return { fetched: true, perPersona, sitemaps: parsed.sitemaps };
  } catch {
    return { fetched: false, perPersona: allowAll(), sitemaps: [] };
  }
}
