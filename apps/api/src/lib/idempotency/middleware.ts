import { matchedRoutes } from 'hono/route';
import { COMPOSED_HANDLER } from 'hono/utils/constants';
import { ERROR_CODES } from '@hushbox/shared';
import { createErrorResponse } from '../errors/index.js';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../context/index.js';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/**
 * Boundary bound on the client-chosen key value: 200 characters is generous
 * for any UUID/ULID-style key while keeping the plaintext
 * `idempotency_keys.key` column and its unique index small.
 */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

/**
 * Permitted key charset: printable ASCII (space through tilde). Control
 * characters and raw binary never reach storage or logs.
 */
const PRINTABLE_ASCII = /^[ -~]+$/;

/**
 * The five route classes exempt from the `Idempotency-Key` header. Each is
 * safe without the header because the matching `idempotent.*` wrapper (or a
 * protocol property) dedups internally — the mapping is enforced by the
 * architecture check over route registrations:
 *
 * - `opaque-protocol` — login/register/2FA/recovery init+finish: Redis
 *   challenge state is the dedup; a retry restarts the handshake harmlessly.
 * - `token-is-key` — token-login: the one-time token IS the idempotency key.
 * - `webhook-event-id` — `idempotent.byEventId` on the provider's event id.
 * - `internal-consumer` — job handlers/cron: `byEventId`/`byTransition`,
 *   no client involved.
 * - `naturally-idempotent` — logout, decline-invite: same end-state on
 *   repeat (`byUpsert`/`byTransition` underneath).
 */
export const IDEMPOTENCY_EXEMPTION_CLASSES = [
  'opaque-protocol',
  'token-is-key',
  'webhook-event-id',
  'internal-consumer',
  'naturally-idempotent',
] as const;

export type IdempotencyExemptionClass = (typeof IDEMPOTENCY_EXEMPTION_CLASSES)[number];

/**
 * The declaration travels as a symbol-keyed property on the marker handler
 * (the same mechanism as the pipeline's route classes), so the stage reads
 * it off the matched chain without re-deriving path patterns.
 */
const EXEMPTION_KEY = Symbol('hushbox.idempotencyExemption');

const EXEMPTION_SET: ReadonlySet<string> = new Set(IDEMPOTENCY_EXEMPTION_CLASSES);

const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Declares an exemption class on every route it is registered on — as a
 * per-route marker or a subtree `use`. The marker is a pass-through;
 * enforcement is centralized in `idempotencyKeyStage`.
 */
export function idempotencyExempt(cls: IdempotencyExemptionClass): MiddlewareHandler<AppEnv> {
  // Registration-time fail-fast: the set is closed; an unknown value from a
  // cast or untyped call site must die at composition, not silently exempt.
  if (!EXEMPTION_SET.has(cls)) {
    throw new Error(`idempotency: unknown exemption class ${JSON.stringify(cls)}`);
  }
  // eslint-disable-next-line unicorn/consistent-function-scoping -- each call must return a distinct function instance: the declaration is attached to it
  const marker: MiddlewareHandler<AppEnv> = (_c, next) => next();
  return Object.assign(marker, { [EXEMPTION_KEY]: cls });
}

/** Reads an exemption declaration off a matched handler, if any. */
export function readIdempotencyExemption(handler: unknown): IdempotencyExemptionClass | undefined {
  const unwrapped = unwrapComposedHandler(handler);
  if (typeof unwrapped !== 'function') return undefined;
  const value = (unwrapped as unknown as Record<symbol, unknown>)[EXEMPTION_KEY];
  return typeof value === 'string' && EXEMPTION_SET.has(value)
    ? (value as IdempotencyExemptionClass)
    : undefined;
}

/** The validated header value, or undefined when absent/blank. */
export function readIdempotencyKey(c: Context<AppEnv>): string | undefined {
  const value = c.req.header(IDEMPOTENCY_KEY_HEADER);
  return value === undefined || value.trim() === '' ? undefined : value;
}

interface ExemptionResolution {
  readonly exemption: IdempotencyExemptionClass | undefined;
  readonly matchedConcreteRoute: boolean;
}

/**
 * Scans the matched chain for exemption declarations. Wildcard middlewares
 * register with method ALL, so "a concrete route matched" means a non-ALL
 * entry exists (mutating routes are always registered with explicit verbs);
 * without one the request falls through to Hono's 404 untouched.
 */
function resolveExemption(c: Context<AppEnv>): ExemptionResolution {
  const declared = new Set<IdempotencyExemptionClass>();
  let matchedConcreteRoute = false;
  for (const route of matchedRoutes(c)) {
    if (route.method !== 'ALL') matchedConcreteRoute = true;
    const cls = readIdempotencyExemption(route.handler);
    if (cls !== undefined) declared.add(cls);
  }
  if (declared.size > 1) {
    throw new Error(
      `idempotency: conflicting exemption classes on one request: ${[...declared].join(', ')}`
    );
  }
  return { exemption: [...declared][0], matchedConcreteRoute };
}

const enforceIdempotencyKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!MUTATING_METHODS.has(c.req.method)) return next();
  const { exemption, matchedConcreteRoute } = resolveExemption(c);
  if (!matchedConcreteRoute || exemption !== undefined) return next();
  const key = readIdempotencyKey(c);
  if (key === undefined) {
    return c.json(createErrorResponse(ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED), 400);
  }
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH || !PRINTABLE_ASCII.test(key)) {
    return c.json(
      createErrorResponse(ERROR_CODES.VALIDATION, { header: IDEMPOTENCY_KEY_HEADER }),
      400
    );
  }
  return next();
};

/**
 * The pipeline stage enforcing the universal-idempotency rule at runtime:
 * every mutating route requires `Idempotency-Key` unless it declares one of
 * the five exemption classes. Composes after the authorization stage in the
 * per-request chain; reads are untouched.
 */
export function idempotencyKeyStage(): MiddlewareHandler<AppEnv> {
  return enforceIdempotencyKey;
}

/**
 * Hono's `.route()` wraps a sub-app's handlers when the sub-app carries its
 * own error handler, storing the original under `COMPOSED_HANDLER`.
 * Duplicated from the pipeline markers deliberately: lib modules may not
 * import middleware (boundaries), and the unwrap is the contract's smallest
 * portable piece.
 */
function unwrapComposedHandler(handler: unknown): unknown {
  let current = handler;
  while (
    typeof current === 'function' &&
    (current as unknown as Record<string, unknown>)[COMPOSED_HANDLER] !== undefined
  ) {
    current = (current as unknown as Record<string, unknown>)[COMPOSED_HANDLER];
  }
  return current;
}
