/**
 * Base DomainError taxonomy for domain code (the typed `Result` error
 * channel). This is the closed set of base kinds only — the route-level
 * error→HTTP-code map is deliberately out of scope here and lives with the
 * route layer.
 *
 * Doctrine (ARCHITECTURE.md): expected domain failures are `Result` values
 * carrying one of these errors; exceptions are defects and must keep
 * throwing. Errors carry codes and operator-safe messages, never content.
 */

export const DOMAIN_ERROR_CODES = [
  'validation',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'timeout',
  'unavailable',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export interface DomainErrorOf<C extends DomainErrorCode> {
  readonly code: C;
  readonly message: string;
  readonly cause?: unknown;
}

export type DomainError = { [C in DomainErrorCode]: DomainErrorOf<C> }[DomainErrorCode];

function factoryFor<C extends DomainErrorCode>(
  code: C
): (message: string, cause?: unknown) => DomainErrorOf<C> {
  return (message: string, cause?: unknown): DomainErrorOf<C> =>
    cause === undefined ? { code, message } : { code, message, cause };
}

export const validationError = factoryFor('validation');
export const unauthorizedError = factoryFor('unauthorized');
export const forbiddenError = factoryFor('forbidden');
export const notFoundError = factoryFor('not_found');
export const conflictError = factoryFor('conflict');
export const rateLimitedError = factoryFor('rate_limited');
export const timeoutError = factoryFor('timeout');
export const unavailableError = factoryFor('unavailable');

const DOMAIN_ERROR_CODE_SET: ReadonlySet<string> = new Set(DOMAIN_ERROR_CODES);

export function isDomainError(value: unknown): value is DomainError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown };
  return (
    typeof candidate.code === 'string' &&
    DOMAIN_ERROR_CODE_SET.has(candidate.code) &&
    typeof candidate.message === 'string'
  );
}
