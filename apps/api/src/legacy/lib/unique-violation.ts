/**
 * Detects Postgres unique-violation (SQLSTATE 23505) wrapped by Drizzle.
 *
 * Drizzle wraps the postgres-js / Neon driver error in DrizzleQueryError
 * with the original surfaced as `cause`. The `constraint` and `code` fields
 * live on that cause; the cause chain is walked because future Drizzle
 * versions could add another wrapping layer.
 *
 * `getUniqueViolationConstraint` returns:
 *   - the constraint name string when the structured Postgres error
 *     surfaces it (callers can discriminate between e.g. username vs
 *     email collisions),
 *   - the empty string when detection succeeded only via message text
 *     (older drivers, mocked test errors without structured fields) —
 *     callers that need the specific constraint must treat `''` as
 *     "unknown which constraint" and fall back to generic handling,
 *   - `null` when the error is not a unique violation at all.
 *
 * `isUniqueViolation` is a thin wrapper for the common case where the
 * caller only needs the boolean.
 *
 * The `conversation_forks_conv_name_idx` pattern is in the message-text
 * list because forks' unique index has an explicit name (not Drizzle's
 * generated `_unique` suffix) and some driver paths surface only the
 * index name in the message without a structured `constraint` field.
 */

const UNIQUE_VIOLATION_MESSAGE_PATTERNS = [
  'duplicate key',
  'unique constraint',
  'conversation_forks_conv_name_idx',
];

function hasUniqueViolationMessage(message: string): boolean {
  return UNIQUE_VIOLATION_MESSAGE_PATTERNS.some((pattern) => message.includes(pattern));
}

// Cause chains in real wraps are 1-2 deep; the cap guards against a
// pathologically-circular cause chain without paying the cost of a Set.
const MAX_CAUSE_DEPTH = 16;

interface CauseLike {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
  message?: unknown;
}

type Inspection = { kind: 'constraint'; name: string } | { kind: 'unknown' } | { kind: 'none' };

function inspectOne(value: CauseLike): Inspection {
  if (value.code === '23505') {
    if (typeof value.constraint === 'string') {
      return { kind: 'constraint', name: value.constraint };
    }
    return { kind: 'unknown' };
  }
  if (typeof value.message === 'string' && hasUniqueViolationMessage(value.message)) {
    return { kind: 'unknown' };
  }
  return { kind: 'none' };
}

export function getUniqueViolationConstraint(error: unknown): string | null {
  let detectedWithoutConstraint = false;
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!current || typeof current !== 'object') break;
    const inspection = inspectOne(current as CauseLike);
    if (inspection.kind === 'constraint') return inspection.name;
    if (inspection.kind === 'unknown') detectedWithoutConstraint = true;
    current = (current as CauseLike).cause;
  }
  return detectedWithoutConstraint ? '' : null;
}

export function isUniqueViolation(error: unknown): boolean {
  return getUniqueViolationConstraint(error) !== null;
}
