import { ERROR_CODES } from '@hushbox/shared';
import { test, expect } from './fixtures.js';
import { DEV_ADMIN_ACTORS } from './helpers/actors.js';
import { anonApiContext, disposeAll, mintDevToken, tokenApiContext } from './helpers/auth.js';
import type { APIRequestContext } from './fixtures.js';

/** The `{code}` refusal body every admin denial answers with. */
interface WireError {
  readonly code: string;
}

async function codeOf(response: { json: () => Promise<unknown> }): Promise<string> {
  return ((await response.json()) as WireError).code;
}

/**
 * The Single Auth Path Law, proven against the running Worker: a verified,
 * allowlisted Cloudflare Access assertion is the ONLY way into the admin
 * plane. Pure API — no page fixture, so 4xx asserts need no opt-out (the
 * page-level API-error capture only watches browser traffic).
 */
test.describe('Admin auth boundary', () => {
  test('admin traffic without a valid assertion is refused before anything else runs', async ({
    playwright,
  }) => {
    const contexts: APIRequestContext[] = [];
    try {
      const anon = await anonApiContext(playwright);
      contexts.push(anon);

      // No assertion header at all: the read refuses with the one
      // indistinguishable {code} body.
      const read = await anon.get('/admin/dashboard');
      expect(read.status()).toBe(401);
      expect(await codeOf(read)).toBe(ERROR_CODES.UNAUTHORIZED);

      // A mutation with no assertion AND a body that would fail input
      // validation: 401, never 400 — auth precedes validation, so the
      // boundary leaks nothing about an op's schema to the unauthenticated
      // (and no Idempotency-Key demand fires either).
      const execute = await anon.post('/admin/ops/wallet.credit/execute', {
        data: { input: {} },
      });
      expect(execute.status()).toBe(401);
      expect(await codeOf(execute)).toBe(ERROR_CODES.UNAUTHORIZED);

      // A structurally-broken token gets the same refusal — no oracle
      // distinguishing "absent" from "unparseable".
      const garbage = await tokenApiContext(playwright, 'not-a-jwt');
      contexts.push(garbage);
      const garbageRead = await garbage.get('/admin/dashboard');
      expect(garbageRead.status()).toBe(401);
      expect(await codeOf(garbageRead)).toBe(ERROR_CODES.UNAUTHORIZED);
    } finally {
      await disposeAll(contexts);
    }
  });

  test('a validly-signed assertion for a non-allowlisted email fails closed', async ({
    playwright,
  }) => {
    const contexts: APIRequestContext[] = [];
    try {
      const anon = await anonApiContext(playwright);
      contexts.push(anon);

      // The dev mint deliberately signs for ANY syntactically-valid email
      // (apps/api dev routes: "a non-allowlisted email mints fine and is
      // then refused by verification") — so this token is correctly signed,
      // unexpired, right issuer and audience… and still worthless: the
      // in-Worker allowlist is the enforcement point.
      const minted = await mintDevToken(anon, 'intruder@hushbox.test');
      const intruder = await tokenApiContext(playwright, minted.token, minted.header);
      contexts.push(intruder);

      const read = await intruder.get('/admin/dashboard');
      expect(read.status()).toBe(401);
      expect(await codeOf(read)).toBe(ERROR_CODES.UNAUTHORIZED);
    } finally {
      await disposeAll(contexts);
    }
  });

  test('the /api/admin alias is exact-prefix and carries the same auth wall', async ({
    playwright,
  }) => {
    const contexts: APIRequestContext[] = [];
    try {
      const anon = await anonApiContext(playwright);
      contexts.push(anon);
      const minted = await mintDevToken(anon, DEV_ADMIN_ACTORS[0]);
      const authed = await tokenApiContext(playwright, minted.token, minted.header);
      contexts.push(authed);

      // The production-topology alias (admin.hushbox.ai/api/* → /admin/*):
      // a valid assertion reaches the same dashboard read.
      const aliased = await authed.get('/api/admin/dashboard');
      expect(aliased.status()).toBe(200);
      const aliasedBody = (await aliased.json()) as { jobs: Record<string, unknown> };
      for (const bucket of ['pending', 'running', 'dead', 'discarded']) {
        expect(typeof aliasedBody.jobs[bucket]).toBe('number');
      }

      // Same body shape as the bare path — one canonical route, two spellings.
      const bare = await authed.get('/admin/dashboard');
      expect(bare.status()).toBe(200);
      const bareBody = (await bare.json()) as Record<string, unknown>;
      const byName = (a: string, b: string): number => a.localeCompare(b);
      expect(Object.keys(aliasedBody).toSorted(byName)).toEqual(
        Object.keys(bareBody).toSorted(byName)
      );

      // The alias grants nothing: unauthenticated aliased traffic is 401.
      const anonAliased = await anon.get('/api/admin/dashboard');
      expect(anonAliased.status()).toBe(401);
      expect(await codeOf(anonAliased)).toBe(ERROR_CODES.UNAUTHORIZED);

      // Exact-prefix only — a near-miss path is not rewritten and resolves
      // to no route at all, even fully authenticated.
      const nearMiss = await authed.get('/api/adminX/dashboard');
      expect(nearMiss.status()).toBe(404);
      expect(await codeOf(nearMiss)).toBe(ERROR_CODES.NOT_FOUND);
    } finally {
      await disposeAll(contexts);
    }
  });
});
