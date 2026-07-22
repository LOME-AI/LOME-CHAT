/**
 * Postgres unique-violation (SQLSTATE 23505) detection across the driver's
 * wrapped cause chain. Drivers (postgres-js / Neon, wrapped by Drizzle's
 * `DrizzleQueryError`) nest the original error under `.cause`; the `code` and
 * `constraint` fields live on some layer of that chain, so the chain is walked
 * rather than inspecting `.cause` once — a future Drizzle version could add
 * another wrapping layer. One implementation shared by every slice adapter that
 * maps an insert rejection to a domain outcome (conversations fork-name,
 * identity registration, admin undo-claim, chat runless send).
 */

const UNIQUE_VIOLATION_CODE = '23505';

/**
 * Guard against a pathologically circular cause chain. Drizzle wraps exactly
 * once in practice, so the cap is defensive only; it is kept because the legacy
 * implementation carried it and it is cheap.
 */
const MAX_CAUSE_DEPTH = 16;

/** Yield each object layer of the wrapped `.cause` chain, up to the depth cap. */
function* causeChain(error: unknown): Generator<object> {
  let current: unknown = error;
  let depth = 0;
  while (typeof current === 'object' && current !== null && depth < MAX_CAUSE_DEPTH) {
    yield current;
    current = (current as { cause?: unknown }).cause;
    depth += 1;
  }
}

/**
 * True when the chain carries a unique violation on the named constraint —
 * either a layer whose structured `constraint` field equals `constraintName`,
 * or (some driver paths surface only text, no structured `constraint`) a 23505
 * `Error` layer whose message contains the constraint name.
 */
export function isUniqueViolationOn(error: unknown, constraintName: string): boolean {
  for (const layer of causeChain(error)) {
    if ((layer as { code?: unknown }).code !== UNIQUE_VIOLATION_CODE) continue;
    const constraint = (layer as { constraint?: unknown }).constraint;
    if (constraint === constraintName) return true;
    if (
      constraint === undefined &&
      layer instanceof Error &&
      layer.message.includes(constraintName)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True when any layer of the chain is a unique violation (any constraint).
 * For call sites that only care whether some unique constraint fired.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (const layer of causeChain(error)) {
    if ((layer as { code?: unknown }).code === UNIQUE_VIOLATION_CODE) return true;
  }
  return false;
}
