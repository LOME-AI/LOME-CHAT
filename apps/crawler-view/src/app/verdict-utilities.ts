import { AUDIENCES, type Audience, type Finding, type Verdict } from '../engine';

/** Rank so the worst level wins when an audience carries several findings. */
const SEVERITY: Record<Verdict, number> = { pass: 0, warn: 1, fail: 2 };

/**
 * Presentation for a verdict level. `label` and `symbol` carry the meaning so
 * the state still reads when color is desaturated by the accessibility widget;
 * color is redundant reinforcement, never the sole channel.
 */
export interface VerdictMeta {
  label: string;
  symbol: string;
  /** Token-derived text color class. */
  text: string;
  /** Token-derived tinted-surface + border classes for chips and banners. */
  surface: string;
}

export const VERDICT_META: Record<Verdict, VerdictMeta> = {
  pass: {
    label: 'PASS',
    symbol: '✓',
    text: 'text-success',
    surface: 'bg-success/10 border-success/40',
  },
  warn: {
    label: 'WARN',
    symbol: '!',
    text: 'text-warning',
    surface: 'bg-warning/10 border-warning/40',
  },
  fail: {
    label: 'FAIL',
    symbol: '✗',
    text: 'text-error',
    surface: 'bg-error/10 border-error/40',
  },
};

export const AUDIENCE_LABEL: Record<Audience, string> = {
  ai: 'AI answer bots',
  search: 'Search engines',
  social: 'Social previews',
};

/** The worst level across an audience's findings; empty defaults to pass. */
export function worstVerdict(findings: Finding[]): Verdict {
  let worst: Verdict = 'pass';
  for (const finding of findings) {
    if (SEVERITY[finding.level] > SEVERITY[worst]) {
      worst = finding.level;
    }
  }
  return worst;
}

/** The single worst level across every audience (drives the matrix roll-up). */
export function overallVerdict(verdict: Record<Audience, Finding[]>): Verdict {
  let worst: Verdict = 'pass';
  for (const audience of AUDIENCES) {
    const level = worstVerdict(verdict[audience]);
    if (SEVERITY[level] > SEVERITY[worst]) {
      worst = level;
    }
  }
  return worst;
}
