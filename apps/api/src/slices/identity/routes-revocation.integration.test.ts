import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { users } from '@hushbox/db';
import { ERROR_CODES } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { redisSet } from '../../lib/redis/index.js';
import { errAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { IDENTITY_KEYS } from './domain/keys.js';
import { fullClaims } from './routes.js';
import { checkSessionRevocation, createIdentityManifest, createIdentityStores } from './index.js';
import {
  KEY_BLOBS,
  billingSessionCookie,
  db,
  expectStatus,
  fullSessionCookie,
  get,
  manifestDeps,
  pendingSessionCookie,
  post,
  redis,
  registerLoginFull,
  testEnv,
  unsealClaims,
} from './routes.integration.setup.js';
import type { AppEnv } from '../../lib/context/index.js';
import type { IdentityStores } from './index.js';

describe('identity routes: revocation across every authenticated route class', () => {
  type RouteClassName = 'session' | 'pending-2fa' | 'billing-token';
  const CLASS_FIXTURES: Record<RouteClassName, { path: string; cookie: () => Promise<string> }> = {
    session: { path: '/t/session', cookie: fullSessionCookie },
    'pending-2fa': { path: '/t/pending', cookie: pendingSessionCookie },
    'billing-token': { path: '/t/billing', cookie: billingSessionCookie },
  };

  type Scenario = 'logout-revoked' | 'session-key-absent' | 'issued-before-password-change';
  async function revoke(cookie: string, scenario: Scenario): Promise<void> {
    if (scenario === 'logout-revoked') {
      await expectStatus(post('/auth/logout', {}, cookie), 200);
      return;
    }
    const claims = await unsealClaims(cookie);
    if (scenario === 'session-key-absent') {
      await redis.del(IDENTITY_KEYS.sessionActive.buildKey(claims.userId, claims.sessionId));
      return;
    }
    const written = await redisSet(
      redis,
      IDENTITY_KEYS.passwordChangedAt,
      claims.createdAt + 1,
      claims.userId
    );
    written._unsafeUnwrap();
  }

  const matrix: [Scenario, RouteClassName][] = (
    ['logout-revoked', 'session-key-absent', 'issued-before-password-change'] as const
  ).flatMap((scenario) =>
    (['session', 'pending-2fa', 'billing-token'] as const).map(
      (cls): [Scenario, RouteClassName] => [scenario, cls]
    )
  );

  it.each(matrix)('rejects a %s cookie on the %s route class', async (scenario, cls) => {
    const fixture = CLASS_FIXTURES[cls];
    const cookie = await fixture.cookie();
    await expectStatus(get(fixture.path, cookie), 200);
    await revoke(cookie, scenario);
    const res = await get(fixture.path, cookie);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });
});

describe('identity routes: /me bootstrap', () => {
  it('returns the profile and crypto-key fields for a full session', async () => {
    const { account, cookie } = await registerLoginFull();
    const res = await get('/auth/me', cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: {
        id: account.userId,
        email: account.email,
        username: account.username,
        emailVerified: true,
        totpEnabled: false,
        hasAcknowledgedPhrase: false,
      },
      passwordWrappedPrivateKey: KEY_BLOBS.passwordWrappedPrivateKey,
      publicKey: KEY_BLOBS.accountPublicKey,
    });
  });

  it('denies /me without a session (session-class default-deny)', async () => {
    const res = await get('/auth/me');
    expect(res.status).toBe(401);
  });

  it('treats a vanished authenticated user as a defect (500)', async () => {
    const { account, cookie } = await registerLoginFull();
    await db.delete(users).where(eq(users.id, account.userId));
    const res = await get('/auth/me', cookie);
    expect(res.status).toBe(500);
  });

  it('propagates a store failure on /me', async () => {
    const { cookie } = await registerLoginFull();
    const real = createIdentityStores(db);
    const failing: IdentityStores = {
      users: { ...real.users, findById: () => errAsync(unavailableError('down')) },
      verification: real.verification,
    };
    const manifest = createIdentityManifest({ ...manifestDeps, stores: () => failing });
    const app = applyPipeline(new Hono<AppEnv>(), {
      session: { revocation: checkSessionRevocation },
    });
    app.route(manifest.basePath, manifest.routes);
    const res = await app.request('/auth/me', { headers: { cookie } }, testEnv);
    expect(res.status).toBe(503);
  });
});

describe('identity routes: principal guards', () => {
  it('rejects a session-class route reached without a full principal', () => {
    const ctx = { var: { principal: { kind: 'none' as const } } } as never;
    expect(() => fullClaims(ctx)).toThrow(/full principal/);
  });
});
