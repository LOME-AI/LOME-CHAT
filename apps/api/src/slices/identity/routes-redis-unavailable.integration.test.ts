import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Redis } from '@upstash/redis';
import { createOpaqueClient, startLogin as opaqueClientStartLogin } from '@hushbox/crypto';
import { DELETE_ACCOUNT_CONFIRMATION_PHRASE, ERROR_CODES } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { createIdentityManifest } from './index.js';
import {
  KEY_BLOBS,
  enrolledFullCookie,
  fullSessionCookie,
  manifestDeps,
  pendingSessionCookie,
  testEnv,
  uniqueAccount,
} from './routes.integration.setup.js';
import type { AppEnv } from '../../lib/context/index.js';

describe('identity routes: Redis unavailability fails closed', () => {
  /**
   * A redis whose EVERY operation rejects, injected at the `c.var.redis` seam
   * so each HANDLER's own fail-closed path (redis op → `unavailableError` →
   * 503) is exercised directly. A Proxy — not a hand-enumerated stub — so any
   * op a handler reaches (get/getdel/mget/set/setnx/incr/expire/ttl/eval/del)
   * rejects and a test can never pass because a route quietly skipped redis.
   *
   * The real Upstash transport is intentionally NOT exercised here: its
   * connect/retry/backoff on an unreachable host is vendor behavior, not this
   * codebase's fail-closed contract, and driving it costs seconds per call.
   *
   * No revocation seam here: these tests target each HANDLER's own
   * fail-closed path (the session stage's fail-closed 503 is covered by the
   * pipeline-session suite).
   */
  const DEAD_REDIS = new Proxy(
    {},
    {
      get: () => (): Promise<never> => Promise.reject(new Error('redis unavailable')),
    }
  ) as unknown as Redis;

  function deadApp(): Hono<AppEnv> {
    const manifest = createIdentityManifest(manifestDeps);
    const app = applyPipeline(new Hono<AppEnv>());
    app.use('*', async (c, next) => {
      c.set('redis', DEAD_REDIS);
      await next();
    });
    app.route(manifest.basePath, manifest.routes);
    return app;
  }

  async function postDead(path: string, body: unknown, cookie?: string): Promise<Response> {
    return deadApp().request(
      path,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cookie === undefined ? {} : { cookie }),
        },
        body: JSON.stringify(body),
      },
      testEnv
    );
  }

  async function expectUnavailable(res: Response): Promise<void> {
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAVAILABLE });
  }

  it('refuses register init', async () => {
    const account = uniqueAccount();
    await expectUnavailable(
      await postDead('/auth/register/init', {
        email: account.email,
        username: account.username,
        registrationRequest: [1],
      })
    );
  });

  it('refuses login init', async () => {
    await expectUnavailable(
      await postDead('/auth/login/init', { identifier: 'x@identity-routes.test', ke1: [1] })
    );
  });

  it('refuses register finish', async () => {
    const account = uniqueAccount();
    await expectUnavailable(
      await postDead('/auth/register/finish', {
        email: account.email,
        registrationRecord: [1],
        registerSessionId: crypto.randomUUID(),
        ...KEY_BLOBS,
      })
    );
  });

  it('refuses login finish', async () => {
    await expectUnavailable(
      await postDead('/auth/login/finish', {
        identifier: 'x@identity-routes.test',
        ke3: [1],
        loginSessionId: crypto.randomUUID(),
      })
    );
  });

  it('refuses logout when the revocation delete cannot be answered', async () => {
    const cookie = await fullSessionCookie();
    await expectUnavailable(await postDead('/auth/logout', {}, cookie));
  });

  it('refuses TOTP setup and verify when redis is down', async () => {
    const cookie = await fullSessionCookie();
    await expectUnavailable(await postDead('/auth/2fa/setup', {}, cookie));
    await expectUnavailable(await postDead('/auth/2fa/verify', { code: '123456' }, cookie));
  });

  it('refuses login-2FA and 2FA disable when redis is down', async () => {
    const pending = await pendingSessionCookie();
    const enrolled = await enrolledFullCookie();
    const { ke1: validKe1 } = await opaqueClientStartLogin(createOpaqueClient(), 'anything');
    await expectUnavailable(await postDead('/auth/login/2fa/verify', { code: '123456' }, pending));
    await expectUnavailable(await postDead('/auth/2fa/disable/init', { ke1: validKe1 }, enrolled));
    await expectUnavailable(
      await postDead(
        '/auth/2fa/disable/finish',
        { ke3: [1], code: '123456', disable2FASessionId: crypto.randomUUID() },
        enrolled
      )
    );
  });

  it('refuses password change and account deletion when redis is down', async () => {
    const cookie = await fullSessionCookie();
    const sid = crypto.randomUUID();
    const { ke1: validKe1 } = await opaqueClientStartLogin(createOpaqueClient(), 'anything');
    await expectUnavailable(
      await postDead(
        '/auth/change-password/init',
        { ke1: validKe1, newRegistrationRequest: [1] },
        cookie
      )
    );
    await expectUnavailable(
      await postDead(
        '/auth/change-password/finish',
        {
          ke3: [1],
          newRegistrationRecord: [1],
          newPasswordWrappedPrivateKey: 'AQID',
          changePasswordSessionId: sid,
        },
        cookie
      )
    );
    await expectUnavailable(await postDead('/auth/account/delete/init', { ke1: validKe1 }, cookie));
    await expectUnavailable(
      await postDead(
        '/auth/account/delete/finish',
        {
          ke3: [1],
          deleteAccountSessionId: sid,
          confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
        },
        cookie
      )
    );
  });

  it('refuses recovery and verification-resend (public) when redis is down', async () => {
    const sid = crypto.randomUUID();
    await expectUnavailable(
      await postDead('/auth/recovery/get-wrapped-key', { identifier: 'x@identity-routes.test' })
    );
    await expectUnavailable(
      await postDead('/auth/recovery/reset/init', {
        identifier: 'x@identity-routes.test',
        newRegistrationRequest: [1],
      })
    );
    await expectUnavailable(
      await postDead('/auth/recovery/reset/finish', {
        identifier: 'x@identity-routes.test',
        newRegistrationRecord: [1],
        newPasswordWrappedPrivateKey: 'AQID',
        recoverySessionId: sid,
      })
    );
    await expectUnavailable(
      await postDead('/auth/verify-email/resend', { email: 'x@identity-routes.test' })
    );
  });
});
