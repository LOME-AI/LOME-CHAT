/**
 * Vite plugin that applies Cloudflare Pages `_headers` rules to preview
 * responses, so the production header stack — including the strict CSP with
 * extracted Astro hashes — is exercised by Playwright without spinning up
 * Miniflare.
 *
 * Dev mode is intentionally NOT supported. `astro dev` and `vite dev` serve
 * scripts from `src/` (with HMR transforms), so the hashes in the generated
 * `_headers` (computed from BUILT inline scripts) wouldn't match anything
 * served. Pretending to apply CSP in dev would produce noisy false-positive
 * violations on every page. The real CSP validation happens in `vite preview`
 * against the merged dist, which is what Playwright drives.
 *
 * Caller passes an absolute path to the `_headers` file. Missing file
 * throws — a broken build chain should fail the preview server start, not
 * silently pass e2e tests without CSP enforcement.
 *
 * Wired from:
 *   - `apps/web/vite.config.ts` (preview only)
 */
import { readFileSync, existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

export interface HeadersPluginOptions {
  /** Absolute path to the Cloudflare-style `_headers` file. */
  readonly headersFile: string;
}

export interface HeaderRule {
  readonly pattern: string;
  readonly regex: RegExp;
  readonly headers: Record<string, string>;
  /**
   * Header names this rule strips (`! HeaderName`). Deletes a value an earlier
   * rule set; can't reach a later rule — so a marketing block drops the SPA
   * `/*` CSP only when `/*` precedes it.
   */
  readonly unsets: readonly string[];
}

export class HeadersParseError extends Error {
  constructor(
    message: string,
    public readonly line: number
  ) {
    super(`${message} (line ${String(line)})`);
    this.name = 'HeadersParseError';
  }
}

interface ParsedHeaderLine {
  readonly name: string;
  readonly value: string;
}

function parseHeaderLine(trimmed: string, lineNumber: number): ParsedHeaderLine {
  const colonIndex = trimmed.indexOf(':');
  if (colonIndex <= 0) {
    throw new HeadersParseError(`Malformed header line: "${trimmed}"`, lineNumber);
  }
  const name = trimmed.slice(0, colonIndex).trim();
  const value = trimmed.slice(colonIndex + 1).trim();
  if (name === '' || value === '') {
    throw new HeadersParseError(`Empty header name or value: "${trimmed}"`, lineNumber);
  }
  return { name, value };
}

function finalizeRule(current: CurrentRule): HeaderRule {
  return {
    pattern: current.pattern,
    regex: patternToRegex(current.pattern),
    headers: current.headers,
    unsets: current.unsets,
  };
}

interface CurrentRule {
  pattern: string;
  headers: Record<string, string>;
  unsets: string[];
}

interface ClassifiedLine {
  readonly kind: 'skip' | 'header' | 'pattern';
  readonly trimmed: string;
  readonly indented: boolean;
}

function classifyLine(rawLine: string): ClassifiedLine {
  const line = rawLine.replace(/\r$/, '');
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return { kind: 'skip', trimmed, indented: false };
  const indented = /^[ \t]/.test(line);
  return { kind: indented ? 'header' : 'pattern', trimmed, indented };
}

function applyHeaderToCurrent(
  current: CurrentRule | null,
  trimmed: string,
  lineNumber: number
): void {
  if (!current) {
    throw new HeadersParseError(
      `Indented header line with no preceding path pattern: "${trimmed}"`,
      lineNumber
    );
  }
  if (trimmed.startsWith('! ')) {
    // `classifyLine` trims, so reaching here implies a non-empty token
    // after `! `. No empty-name guard needed — input `  ! ` collapses to
    // `!` and falls through to the standard header parser, which throws
    // "Malformed header line".
    current.unsets.push(trimmed.slice(2));
    return;
  }
  const { name, value } = parseHeaderLine(trimmed, lineNumber);
  current.headers[name] = value;
}

export function parseHeadersFile(content: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let current: CurrentRule | null = null;

  for (const [index, rawLine] of content.split('\n').entries()) {
    const lineNumber = index + 1;
    const classified = classifyLine(rawLine);
    if (classified.kind === 'skip') continue;
    if (classified.kind === 'header') {
      applyHeaderToCurrent(current, classified.trimmed, lineNumber);
    } else {
      if (current) rules.push(finalizeRule(current));
      current = { pattern: classified.trimmed, headers: {}, unsets: [] };
    }
  }
  if (current) rules.push(finalizeRule(current));
  return rules;
}

function patternToRegex(pattern: string): RegExp {
  // Exact-match per path, mirroring Cloudflare Pages `_headers`. Only `*`
  // expands (to `.*` for splat globs like `/blog/*`). No automatic
  // trailing-slash equivalence — a rule keyed at `/welcome` matches
  // ONLY `/welcome`, not `/welcome/`. Otherwise the preview server is
  // more lenient than production and silently masks bugs where a rule
  // is keyed under the wrong path form (the original cause of the
  // `/welcome` CSP regression).
  const escaped = pattern.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`).replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * First writer of a name sets it; later writers append (Cloudflare's rule).
 * Current presence stands in for its "ever set" flag, since appending onto an
 * unset-emptied header is observably a fresh single value. Non-empty tuple so
 * callers read `[0]` as `string`.
 */
function setOrAppendHeader(
  values: Map<string, [string, ...string[]]>,
  name: string,
  value: string
): void {
  const existing = values.get(name);
  values.set(name, existing ? [...existing, value] : [value]);
}

/** Collapse single-value headers to a string; keep multi-value ones as arrays. */
function collapseValues(
  values: Map<string, [string, ...string[]]>
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, list] of values) {
    result[name] = list.length === 1 ? list[0] : list;
  }
  return result;
}

/**
 * Apply matching `_headers` rules to `url`, mirroring Cloudflare Pages'
 * `attachCustomHeaders` so preview matches production:
 *   - matched rules apply in file order (no specificity sort);
 *   - `! Name` deletes before that rule's setters, hitting only earlier-set
 *     values — never a later rule;
 *   - a repeated name appends, it does not override.
 * Returns a string for one value, string[] for several. Surfacing the array
 * (not collapsing) is what lets preview reproduce the two-CSP intersection bug
 * a name-keyed, last-wins map would hide. Names are keyed verbatim; the
 * generator only emits canonical casing.
 */
export function matchHeaders(
  rules: readonly HeaderRule[],
  url: string
): Record<string, string | string[]> {
  /* v8 ignore next -- split always yields at least one element, so both index-0 fallbacks are unreachable */
  const pathname = (url.split('?')[0] ?? '').split('#')[0] ?? '';
  // Map so `.delete()` satisfies @typescript-eslint/no-dynamic-delete.
  const values = new Map<string, [string, ...string[]]>();
  for (const rule of rules) {
    if (!rule.regex.test(pathname)) continue;
    for (const name of rule.unsets) {
      values.delete(name);
    }
    for (const [name, value] of Object.entries(rule.headers)) {
      setOrAppendHeader(values, name, value);
    }
  }
  return collapseValues(values);
}

export function applyHeaders(
  res: ServerResponse,
  headers: Record<string, string | string[]>
): void {
  for (const [name, value] of Object.entries(headers)) {
    // Array value → one header line per element: the duplicate-header parity
    // that reproduces Cloudflare's CSP intersection in preview.
    res.setHeader(name, value);
  }
}

function loadRules(headersFile: string): HeaderRule[] {
  if (!existsSync(headersFile)) {
    throw new Error(
      `[headers-vite-plugin] ${headersFile} not found. ` +
        `The preview server requires the generated _headers file. ` +
        `Run \`pnpm build && pnpm generate:headers\` first.`
    );
  }
  const content = readFileSync(headersFile, 'utf8');
  return parseHeadersFile(content);
}

export function headersPlugin(options: HeadersPluginOptions): Plugin {
  return {
    name: 'headers-vite-plugin',
    configurePreviewServer(server) {
      const rules = loadRules(options.headersFile);
      server.middlewares.use((req, res, next) => {
        if (req.url) {
          const matched = matchHeaders(rules, req.url);
          applyHeaders(res, matched);
        }
        next();
      });
    },
  };
}
