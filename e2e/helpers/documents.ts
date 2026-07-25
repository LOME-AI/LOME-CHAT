import { MIN_LINES_FOR_DOCUMENT } from '@hushbox/shared/documents';

/**
 * Fixture sizing for the document-extraction threshold.
 *
 * A fenced block becomes a document card only at or above
 * `MIN_LINES_FOR_DOCUMENT` lines, so every document fixture in the suite
 * encodes an assumption about that number. Hand-counted bodies go stale
 * silently in both directions — a fixture written to the current value stops
 * being a document when the threshold rises, and a fixture meant to stay
 * inline becomes a document when it falls — so sizes are derived here instead
 * of written out.
 */

const FENCE = '```';

/**
 * Lines of clearance a document fixture keeps above the threshold. Fixtures
 * that merely need to *be* documents sit here rather than on the boundary, so
 * an unrelated panel test never doubles as a boundary test.
 */
const DOCUMENT_LINE_HEADROOM = 4;

export interface DocumentFixture {
  /** The fenced markdown an assistant message carries. */
  markdown: string;
  /** Body line count — what the document card renders as its "N lines" label. */
  lineCount: number;
}

/**
 * A fenced block carrying `body`, padded with `filler` until it clears the
 * extraction threshold with headroom. Assertions read `lineCount` rather than
 * a literal, so the card's label stays correct however the fixture is sized.
 */
export function documentFixture(
  language: string,
  body: readonly string[],
  filler: string
): DocumentFixture {
  const target = MIN_LINES_FOR_DOCUMENT + DOCUMENT_LINE_HEADROOM;
  const padding = Math.max(0, target - body.length);
  const lines = [...body, ...Array.from({ length: padding }, () => filler)];
  return {
    markdown: [`${FENCE}${language}`, ...lines, FENCE].join('\n'),
    lineCount: lines.length,
  };
}

/**
 * A fenced block sized one line short of the extraction threshold — the
 * negative side of the boundary. Used where the boundary itself is under test,
 * so the fixture tracks the threshold wherever it moves.
 */
export function belowThresholdFixture(
  language: string,
  body: readonly string[],
  filler: string
): string {
  const target = MIN_LINES_FOR_DOCUMENT - 1;
  const padding = Math.max(0, target - body.length);
  const lines = [...body, ...Array.from({ length: padding }, () => filler)].slice(0, target);
  return [`${FENCE}${language}`, ...lines, FENCE].join('\n');
}
