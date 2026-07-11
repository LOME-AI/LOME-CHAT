import { DOMAIN_ERROR_CODE_TO_WIRE_CODE, ERROR_CODES } from '@hushbox/shared';
import { createErrorResponse } from '../lib/errors/index.js';
import { redisGet, redisIncr, redisSet, redisTtl } from '../lib/redis/index.js';
import { err, ok } from '../lib/result/index.js';
import type { z } from 'zod';
import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { DomainError, DomainErrorCode } from '../lib/errors/index.js';
import type { Result } from '../lib/result/index.js';
import type { RateLimitKeyDefinition } from '../lib/redis/index.js';
import type { AppEnv } from '../lib/context/index.js';

/**
 * The edge rate-limit enforcer: generic middleware factories over the slices'
 * registry entries (doctrine: Redis keys exist only as typed key-registry
 * entries; the entries stay slice-owned, this module owns enforcement only).
 * Two mechanisms, matching the entries' stored shapes:
 *
 * - RESERVATION (plain INCR counter): increment-before-decide — exactly
 *   `maxAttempts` admitted per window under any concurrency. The chat send's
 *   per-user limit uses it (same key + semantics its in-handler enforcement
 *   had before moving here).
 * - WINDOW ({count, firstAttempt} JSON): legacy-compatible advisory fixed
 *   window — the window opens at the first attempt; a denied attempt never
 *   extends it. The read→write is not atomic (bounded overshoot under racing
 *   requests) — acceptable for abuse throttles, never for secret-guessing
 *   surfaces (those use in-domain atomic reservation).
 *
 * Every mechanism fails closed: Redis down refuses the request (503), never
 * admits it unbounded.
 */

type RedisClient = AppEnv['Variables']['redis'];

/** Entries whose stored value is a plain INCR counter (the schema is irrelevant to INCR). */
export type CounterLimitDefinition = RateLimitKeyDefinition<z.ZodType, [string]>;

interface WindowState {
  readonly count: number;
  readonly firstAttempt: number;
}

/** Entries whose stored value is the legacy `{count, firstAttempt}` window state. */
export type WindowLimitDefinition = RateLimitKeyDefinition<z.ZodType<WindowState>, [string]>;

type Decision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

const STATUS_BY_DOMAIN_CODE = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  timeout: 408,
  unavailable: 503,
} as const satisfies Record<DomainErrorCode, ContentfulStatusCode>;

/**
 * The caller's IP: `cf-connecting-ip` (authoritative on Cloudflare), else the
 * first `x-forwarded-for` hop, else `x-real-ip`, else the shared 'unknown'
 * sentinel (off-Cloudflare environments tolerate the shared counter).
 */
export function resolveClientIp(header: (name: string) => string | undefined): string {
  const cfIp = header('cf-connecting-ip');
  if (cfIp !== undefined && cfIp !== '') return cfIp;
  const forwarded = header('x-forwarded-for');
  if (forwarded !== undefined) {
    const firstHop = forwarded.split(',')[0]?.trim();
    if (firstHop !== undefined && firstHop !== '') return firstHop;
  }
  const realIp = header('x-real-ip');
  if (realIp !== undefined && realIp !== '') return realIp;
  return 'unknown';
}

/** SHA-256 hex of a rate-limit identifier — raw IPs/credentials never appear in Redis keys. */
export async function hashRateLimitId(identifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identifier));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Reservation mechanics: INCR includes this request, so the gate is `count > maxAttempts`. */
async function consumeCounter(
  redis: RedisClient,
  definition: CounterLimitDefinition,
  id: string
): Promise<Result<Decision, DomainError>> {
  const count = await redisIncr(redis, definition, id);
  if (count.isErr()) return err(count.error);
  if (count.value <= definition.rateLimitConfig.maxAttempts) return ok({ allowed: true });
  const remaining = await redisTtl(redis, definition, id);
  if (remaining.isErr()) return err(remaining.error);
  return ok({
    allowed: false,
    retryAfterSeconds: remaining.value ?? definition.rateLimitConfig.windowSeconds,
  });
}

/**
 * Fixed-window mechanics: the window is anchored at the first attempt; a
 * denied attempt writes nothing (never extends the window); an expired
 * window starts fresh.
 */
async function consumeWindow(
  redis: RedisClient,
  definition: WindowLimitDefinition,
  id: string,
  now: number
): Promise<Result<Decision, DomainError>> {
  const stored = await redisGet(redis, definition, id);
  if (stored.isErr()) return err(stored.error);
  const state = stored.value;
  const windowExpiry =
    state === null ? now : state.firstAttempt + definition.rateLimitConfig.windowSeconds * 1000;
  if (state !== null && now <= windowExpiry) {
    if (state.count >= definition.rateLimitConfig.maxAttempts) {
      return ok({
        allowed: false,
        retryAfterSeconds: Math.ceil((windowExpiry - now) / 1000),
      });
    }
    const advanced = await redisSet(
      redis,
      definition,
      { count: state.count + 1, firstAttempt: state.firstAttempt },
      id
    );
    return advanced.isErr() ? err(advanced.error) : ok({ allowed: true });
  }
  const opened = await redisSet(redis, definition, { count: 1, firstAttempt: now }, id);
  return opened.isErr() ? err(opened.error) : ok({ allowed: true });
}

function respond(c: Context<AppEnv>, result: Result<Decision, DomainError>): Response | null {
  if (result.isErr()) {
    return c.json(
      createErrorResponse(DOMAIN_ERROR_CODE_TO_WIRE_CODE[result.error.code]),
      STATUS_BY_DOMAIN_CODE[result.error.code]
    );
  }
  if (result.value.allowed) return null;
  return c.json(
    createErrorResponse(ERROR_CODES.RATE_LIMITED, {
      retryAfterSeconds: result.value.retryAfterSeconds,
    }),
    429
  );
}

function enforce(
  consume: (c: Context<AppEnv>) => Promise<Result<Decision, DomainError>>
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const refusal = respond(c, await consume(c));
    if (refusal !== null) return refusal;
    return next();
  };
}

/**
 * Per-user reservation limiter for authenticated (session-class) routes.
 * Mounting it on a route class that admits non-full principals is a
 * composition defect — the authorizer guarantees `full` before it runs.
 */
export function rateLimitByUser(definition: CounterLimitDefinition): MiddlewareHandler<AppEnv> {
  return enforce(async (c) => {
    const principal = c.var.principal;
    if (principal.kind !== 'full') {
      throw new Error('rateLimitByUser requires a full principal — mount it on session routes');
    }
    return consumeCounter(c.var.redis, definition, principal.claims.userId);
  });
}

/** Per-IP window limiter (hashed IP) for unauthenticated surfaces. */
export function rateLimitByIp(definition: WindowLimitDefinition): MiddlewareHandler<AppEnv> {
  return enforce(async (c) => {
    const ipHash = await hashRateLimitId(resolveClientIp((name) => c.req.header(name)));
    return consumeWindow(c.var.redis, definition, ipHash, Date.now());
  });
}

/**
 * Per-caller window limiter for the media member path: an authenticated
 * caller keys by userId; a shared-link caller keys by the hashed credential
 * (`link:<sha256>` — the credential is the link's public key, so this is the
 * pre-resolution stand-in for the registry's `link:<linkId>` intent without a
 * DB read at the edge); anyone else keys by hashed IP (`ip:<sha256>`), which
 * bounds unauthenticated probing ahead of the handler's own 401.
 */
export function rateLimitByCaller(
  definition: WindowLimitDefinition,
  options: { readonly credentialHeader: string }
): MiddlewareHandler<AppEnv> {
  return enforce(async (c) => {
    const callerId = await resolveCallerId(c, options.credentialHeader);
    return consumeWindow(c.var.redis, definition, callerId, Date.now());
  });
}

async function resolveCallerId(c: Context<AppEnv>, credentialHeader: string): Promise<string> {
  const principal = c.var.principal;
  if (principal.kind === 'full') return principal.claims.userId;
  const credential = c.req.header(credentialHeader);
  if (credential !== undefined) return `link:${await hashRateLimitId(credential)}`;
  return `ip:${await hashRateLimitId(resolveClientIp((name) => c.req.header(name)))}`;
}
