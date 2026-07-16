/**
 * Maximum total characters of conversation context to feed the classifier.
 * Balances signal vs cost — every char × num eligible models adds tokens.
 */
export const MAX_CLASSIFIER_CONTEXT_CHARS = 4000;

/**
 * Per-direction cap. With 4 directions, the natural global limit is
 * MAX_CLASSIFIER_CONTEXT_CHARS, but individual directions can claim less when
 * one source (e.g., the assistant's previous reply on first turn) is empty.
 */
export const CLASSIFIER_CHARS_PER_DIRECTION = 1000;

/**
 * Round-robin chunk size. Keeps the four directions interleaving fairly so
 * that one very long source can't exhaust the global budget before the others
 * have had a chance to contribute.
 */
export const CLASSIFIER_CHUNK_SIZE = 250;

export interface TruncationInput {
  latestUserMessage: string;
  latestAssistantMessage: string;
}

interface DirectionState {
  label: string;
  source: string;
  fromStart: boolean;
  /** Index in the directions array of this direction's paired counterpart on the same source. */
  partnerIndex: number;
  captured: string;
  /**
   * Cursor into the source string. For fromStart: next slice begins here, advances forward.
   * For fromEnd: previous slice ended here, advances backward.
   * The pair (start cursor < end cursor) holds while there's still uncaptured content.
   */
  cursor: number;
}

function availableForDirection(dir: DirectionState, partner: DirectionState): number {
  return dir.fromStart ? partner.cursor - dir.cursor : dir.cursor - partner.cursor;
}

/**
 * Build a balanced, breadth-first snippet of the most recent exchange to feed
 * the Smart Model classifier. Pulls the start AND the end of each message in
 * round-robin chunks so the classifier sees both the user's intent and their
 * specific request, plus the assistant's framing and conclusion when present.
 *
 * Start and end of the same source share a moving frontier and never
 * double-capture: when a single short message fits entirely in the start
 * direction, the end direction yields nothing.
 *
 * Empty sections are omitted from the output. Sections are separated by a
 * blank line and labeled `[USER START]:`, `[USER END]:`, `[AI START]:`,
 * `[AI END]:`.
 */
function buildDirections(input: TruncationInput): DirectionState[] {
  return [
    {
      label: '[USER START]',
      source: input.latestUserMessage,
      fromStart: true,
      partnerIndex: 1,
      captured: '',
      cursor: 0,
    },
    {
      label: '[USER END]',
      source: input.latestUserMessage,
      fromStart: false,
      partnerIndex: 0,
      captured: '',
      cursor: input.latestUserMessage.length,
    },
    {
      label: '[AI START]',
      source: input.latestAssistantMessage,
      fromStart: true,
      partnerIndex: 3,
      captured: '',
      cursor: 0,
    },
    {
      label: '[AI END]',
      source: input.latestAssistantMessage,
      fromStart: false,
      partnerIndex: 2,
      captured: '',
      cursor: input.latestAssistantMessage.length,
    },
  ];
}

/**
 * Run one round-robin pass across every direction. Returns the total chars
 * consumed across all four directions in this pass; the outer loop terminates
 * when a pass yields zero progress.
 */
function consumePass(directions: readonly DirectionState[], remainingGlobal: number): number {
  let consumedThisPass = 0;
  for (const dir of directions) {
    const remaining = remainingGlobal - consumedThisPass;
    if (remaining <= 0) break;
    consumedThisPass += consumeChunk(dir, directions, remaining);
  }
  return consumedThisPass;
}

function fillCaptureBuffers(directions: readonly DirectionState[]): void {
  let remainingGlobal = MAX_CLASSIFIER_CONTEXT_CHARS;
  while (remainingGlobal > 0) {
    const consumed = consumePass(directions, remainingGlobal);
    if (consumed === 0) return;
    remainingGlobal -= consumed;
  }
}

function formatSections(directions: readonly DirectionState[]): string {
  const sections: string[] = [];
  for (const dir of directions) {
    if (dir.captured.length > 0) {
      sections.push(`${dir.label}: ${dir.captured}`);
    }
  }
  return sections.join('\n\n');
}

export function truncateForClassifier(input: TruncationInput): string {
  const directions = buildDirections(input);
  fillCaptureBuffers(directions);
  return formatSections(directions);
}

function isDirectionExhausted(dir: DirectionState, directions: readonly DirectionState[]): boolean {
  const partner = directions[dir.partnerIndex];
  /* v8 ignore next -- @preserve unreachable: buildDirections always emits four entries whose partnerIndex points inside the array; the guard only narrows the noUncheckedIndexedAccess lookup */
  if (partner === undefined) return true;
  const sourceLeft = availableForDirection(dir, partner);
  const capacityLeft = CLASSIFIER_CHARS_PER_DIRECTION - dir.captured.length;
  return sourceLeft <= 0 || capacityLeft <= 0;
}

/**
 * The per-direction cap inflates when sibling directions have exhausted their
 * source: their unclaimed share redistributes evenly to the directions that
 * can still make progress, capped by the global budget. On the typical first
 * turn (assistant empty) this lets USER START + USER END consume the full
 * 4000-char budget instead of stalling at 2000.
 */
function effectivePerDirectionCap(
  dir: DirectionState,
  directions: readonly DirectionState[]
): number {
  let exhaustedShare = 0;
  let activeCount = 1; // `dir` itself is always considered active here
  for (const other of directions) {
    if (other === dir) continue;
    if (isDirectionExhausted(other, directions)) {
      const capacity = Math.max(0, CLASSIFIER_CHARS_PER_DIRECTION - other.captured.length);
      exhaustedShare += capacity;
    } else {
      activeCount += 1;
    }
  }
  return CLASSIFIER_CHARS_PER_DIRECTION + Math.floor(exhaustedShare / activeCount);
}

/**
 * Consume one chunk for the given direction and return how many characters
 * were captured. Returns 0 when the direction cannot make progress (already
 * at its per-direction cap, source exhausted, or partner crossed).
 */
function consumeChunk(
  dir: DirectionState,
  directions: readonly DirectionState[],
  remainingGlobal: number
): number {
  const cap = effectivePerDirectionCap(dir, directions);
  const dirRemaining = cap - dir.captured.length;
  /* v8 ignore next -- @preserve unreachable loop-safety guard: the global budget equals the sum of the four base caps, so it runs out before any direction's effective cap binds */
  if (dirRemaining <= 0) return 0;

  const partner = directions[dir.partnerIndex];
  /* v8 ignore next -- @preserve unreachable: partnerIndex always points inside the four-entry array; the guard only narrows the noUncheckedIndexedAccess lookup */
  if (partner === undefined) return 0;
  const sourceRemaining = availableForDirection(dir, partner);
  if (sourceRemaining <= 0) return 0;

  const chunkSize = Math.min(CLASSIFIER_CHUNK_SIZE, dirRemaining, remainingGlobal, sourceRemaining);

  const chunk = dir.fromStart
    ? dir.source.slice(dir.cursor, dir.cursor + chunkSize)
    : dir.source.slice(dir.cursor - chunkSize, dir.cursor);

  /* v8 ignore next -- @preserve unreachable: chunkSize is the min of four strictly-positive numbers and both cursors stay inside the source, so the slice is never empty */
  if (chunk.length === 0) return 0;

  dir.cursor = dir.fromStart ? dir.cursor + chunkSize : dir.cursor - chunkSize;
  dir.captured = dir.fromStart ? dir.captured + chunk : chunk + dir.captured;
  return chunk.length;
}
