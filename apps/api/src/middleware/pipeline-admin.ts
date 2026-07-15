import { SignJWT, createLocalJWKSet, createRemoteJWKSet, importJWK, jwtVerify } from 'jose';
import { matchedRoutes } from 'hono/route';
import { ERROR_CODES } from '@hushbox/shared';
import { createErrorResponse } from '../lib/errors/index.js';
import {
  isPipelineHandler,
  markPipelineHandler,
  readPipelineVariable,
  readRouteClass,
} from './pipeline-markers.js';
import type { JWTVerifyGetKey } from 'jose';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv, Bindings } from '../lib/context/index.js';

/** The header Cloudflare Access forwards its signed identity assertion in. */
export const CF_ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion';

/**
 * Accepted JWT algorithms, pinned: Access signs RS256; the committed dev
 * fixture key is Ed25519. Pinning closes algorithm-confusion regardless of
 * what a JWKS response claims.
 */
const ACCEPTED_ALGORITHMS = ['RS256', 'EdDSA'];

/** Dev-mint token lifetime — long enough for a local session, short enough
 * that a leaked local token is worthless quickly. */
const DEV_TOKEN_LIFETIME_SECONDS = 60 * 60;

/** The Access issuer for a Zero Trust team domain. */
export function accessIssuer(teamDomain: string): string {
  return `https://${teamDomain}.cloudflareaccess.com`;
}

interface AdminAccessConfig {
  readonly teamDomain: string;
  readonly audience: string;
  /** Lowercased exact-match actor emails. */
  readonly allowlist: ReadonlySet<string>;
}

/**
 * Fail-fast config read, run only when an admin-classed route matched: a
 * deployment that mounts the admin surface without its Access config is a
 * defect (500), never a silently-open or silently-closed route.
 */
function readAdminAccessConfig(env: Bindings): AdminAccessConfig {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const audience = env.CF_ACCESS_AUD;
  const allowlistRaw = env.ADMIN_ACTOR_ALLOWLIST;
  if (
    teamDomain === undefined ||
    teamDomain === '' ||
    audience === undefined ||
    audience === '' ||
    allowlistRaw === undefined ||
    allowlistRaw === ''
  ) {
    throw new Error(
      'pipeline misconfigured: an admin-classed route is reachable without Access ' +
        'config. Set CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, and ADMIN_ACTOR_ALLOWLIST.'
    );
  }
  const allowlist = new Set(
    allowlistRaw
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== '')
  );
  if (allowlist.size === 0) {
    throw new Error('pipeline misconfigured: ADMIN_ACTOR_ALLOWLIST parses to zero actors.');
  }
  return { teamDomain, audience, allowlist };
}

/**
 * Remote JWKS resolvers memoized per team domain: `createRemoteJWKSet` keeps
 * its own fetch/rotation cache (the ~6-week Access key rotation), so one
 * instance per isolate is the correct lifetime — a key cache, not domain
 * state.
 */
const remoteJwksByDomain = new Map<string, JWTVerifyGetKey>();

function remoteAccessJwks(teamDomain: string): JWTVerifyGetKey {
  const cached = remoteJwksByDomain.get(teamDomain);
  if (cached !== undefined) return cached;
  const created = createRemoteJWKSet(
    new URL(`${accessIssuer(teamDomain)}/cdn-cgi/access/certs`)
  ) as JWTVerifyGetKey;
  remoteJwksByDomain.set(teamDomain, created);
  return created;
}

function parseDevPrivateJwk(env: Bindings): Record<string, unknown> {
  const raw = env.CF_ACCESS_DEV_PRIVATE_JWK;
  if (raw === undefined || raw === '') {
    throw new Error(
      'admin access: the dev signing key (CF_ACCESS_DEV_PRIVATE_JWK) is not configured. ' +
        'Dev/CI modes carry it via the env registry; production never does.'
    );
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * The LOCAL verification JWKS: the public half of the committed dev signing
 * key. Verification code is identical in every mode — only the key source
 * varies: never a bypass branch.
 */
function localDevJwks(env: Bindings): JWTVerifyGetKey {
  const publicJwk = { ...parseDevPrivateJwk(env) };
  delete publicJwk['d'];
  return createLocalJWKSet({ keys: [publicJwk] });
}

/** True when a matched, non-pipeline handler declares the `admin` class. */
function reachesAdminRoute(c: Context<AppEnv>): boolean {
  for (const route of matchedRoutes(c)) {
    if (isPipelineHandler(route.handler)) continue;
    if (readRouteClass(route.handler) === 'admin') return true;
  }
  return false;
}

/**
 * Pipeline stage 4: admin-actor resolution — the in-Worker belt behind the
 * Cloudflare Access edge wall (ARCHITECTURE §Admin plane). Runs ONLY when the
 * matched chain declares the `admin` route class; everything else passes
 * through untouched, so no product surface pays for it and a stray Access
 * header can never influence a product principal.
 *
 * Fail-closed: a missing, unparseable, expired, wrong-issuer, wrong-audience,
 * or non-allowlisted assertion answers 401 with the one indistinguishable
 * `{code}` body and ZERO effect — the handler never runs. Only a fully
 * verified assertion mints the `admin-actor` principal the authorizer
 * requires for `admin`-classed routes.
 */
export function pipelineAdmin(): MiddlewareHandler<AppEnv> {
  return markPipelineHandler(async (c, next) => {
    if (!reachesAdminRoute(c)) return next();
    const envUtilities = readPipelineVariable(c, 'envUtils');
    if (envUtilities === undefined) {
      throw new Error('pipeline order violated: pipelineAdmin requires pipelineEnv first.');
    }
    const config = readAdminAccessConfig(c.env);
    const keySource = envUtilities.isProduction
      ? remoteAccessJwks(config.teamDomain)
      : localDevJwks(c.env);
    const token = c.req.header(CF_ACCESS_JWT_HEADER);
    if (token === undefined || token === '') {
      return unauthorized(c);
    }
    let email: string;
    try {
      const { payload } = await jwtVerify(token, keySource, {
        issuer: accessIssuer(config.teamDomain),
        audience: config.audience,
        algorithms: ACCEPTED_ALGORITHMS,
      });
      if (typeof payload['email'] !== 'string' || payload['email'] === '') {
        return unauthorized(c);
      }
      email = payload['email'];
    } catch {
      // Every verification failure — signature, expiry, issuer, audience —
      // is expected external input and answers the same body (no oracle).
      return unauthorized(c);
    }
    if (!config.allowlist.has(email.toLowerCase())) {
      return unauthorized(c);
    }
    c.set('principal', {
      kind: 'admin-actor',
      email: email.toLowerCase(),
      audience: config.audience,
    });
    return next();
  });
}

function unauthorized(c: Context<AppEnv>): Response {
  return c.json(createErrorResponse(ERROR_CODES.UNAUTHORIZED), 401);
}

export interface DevAdminTokenParams {
  readonly email: string;
  /** Override to mint deliberately-wrong tokens in tests. */
  readonly audience?: string;
  readonly issuer?: string;
  /** Negative values mint an already-expired token (tests). */
  readonly expiresInSeconds?: number;
}

/**
 * Mints an Access-shaped JWT signed by the committed DEV key, for the
 * dev-admin mint route, the SPA/CLI dev flows, and the e2e suite — so the
 * real jose verification path above is always in the loop. Impossible in
 * production by construction: the env registry carries no production value
 * for the signing key, so this throws there (and the mint route itself is
 * `dev-only`-classed, 404 in production).
 */
export async function mintDevAdminToken(
  env: Bindings,
  params: DevAdminTokenParams
): Promise<string> {
  const jwk = parseDevPrivateJwk(env);
  if (typeof jwk['d'] !== 'string') {
    throw new TypeError('admin access: dev signing key is not a private JWK (missing `d`).');
  }
  const key = await importJWK(jwk, 'EdDSA');
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const audience = params.audience ?? env.CF_ACCESS_AUD;
  if (teamDomain === undefined || audience === undefined) {
    throw new Error(
      'admin access: minting needs CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD configured.'
    );
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const lifetime = params.expiresInSeconds ?? DEV_TOKEN_LIFETIME_SECONDS;
  return (
    new SignJWT({ email: params.email })
      // The header carries the key's kid only when the key declares one — a
      // fabricated kid would fail local-JWKS selection against a kid-less key.
      .setProtectedHeader({
        alg: 'EdDSA',
        ...(typeof jwk['kid'] === 'string' ? { kid: jwk['kid'] } : {}),
      })
      .setSubject(params.email)
      .setIssuer(params.issuer ?? accessIssuer(teamDomain))
      .setAudience(audience)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + lifetime)
      .sign(key)
  );
}
