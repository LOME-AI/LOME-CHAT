import { Redis } from '@upstash/redis';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { ERROR_CODES } from '@hushbox/shared';
import { createErrorResponse } from '../lib/errors/index.js';
import { issueSession } from '../slices/identity/index.js';
import { createSmokeHarness } from './harness.js';
import type { SmokeHarness } from './harness.js';

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === '') {
    throw new Error(`smoke: harness env is missing ${name}`);
  }
  return value;
}

/** Issues a real session against the harness's Redis and returns its cookie. */
async function issuedSessionCookie(env: SmokeHarness['env']): Promise<string> {
  const redis = new Redis({
    url: required(env.UPSTASH_REDIS_REST_URL, 'UPSTASH_REDIS_REST_URL'),
    token: required(env.UPSTASH_REDIS_REST_TOKEN, 'UPSTASH_REDIS_REST_TOKEN'),
  });
  const response = new Response();
  const issued = await issueSession({
    request: new Request('http://localhost/'),
    response,
    redis,
    secret: required(env.IRON_SESSION_SECRET, 'IRON_SESSION_SECRET'),
    isProduction: false,
    userId: crypto.randomUUID(),
    kind: 'full',
    now: Date.now(),
  });
  if (issued.isErr()) throw new Error('smoke: session issue failed');
  const setCookie = response.headers.get('set-cookie');
  if (setCookie === null) throw new Error('smoke: session cookie missing');
  return setCookie.split(';')[0] ?? '';
}

describe('account smoke', () => {
  it('exposes the account routes on the typed client (schema survives into AppType)', () => {
    const { client } = createSmokeHarness();
    // Type-level pin: an annotation on the manifest factory that widens its
    // routes to bare `Hono<AppEnv>` erases the route schema from `AppType`;
    // this assertion turns that erasure into a typecheck failure here.
    expectTypeOf(client).toHaveProperty('account');
    expectTypeOf(client.account).toHaveProperty('instructions');
    expectTypeOf(client.account.instructions).toHaveProperty('$get');
  });

  it('mounts the account slice (anonymous probe of GET /account/instructions is not 404)', async () => {
    const { client } = createSmokeHarness();
    const res = await client.account.instructions.$get();
    expect(res.status).not.toBe(404);
  });

  it('guards the session-class route (anonymous GET /account/instructions answers 401 {code})', async () => {
    const { client } = createSmokeHarness();
    const res = await client.account.instructions.$get();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(createErrorResponse(ERROR_CODES.UNAUTHORIZED));
  });

  it('refuses a logged-out session cookie on the session-class route (401 {code})', async () => {
    const { client, env } = createSmokeHarness();
    const cookie = await issuedSessionCookie(env);
    // Real logout through the product surface; the cookie the client still
    // holds must stop authorizing from the next request on.
    const logout = await client.auth.logout.$post(undefined, { headers: { cookie } });
    if (logout.status !== 200) throw new Error('smoke: logout failed');
    const res = await client.account.instructions.$get(undefined, { headers: { cookie } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(createErrorResponse(ERROR_CODES.UNAUTHORIZED));
  });
});
