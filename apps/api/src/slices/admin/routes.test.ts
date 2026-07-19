import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineAdminOpContract } from '@hushbox/shared';
import { createAdminManifest } from './routes.js';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import type { AppEnv, Principal } from '../../middleware/pipeline-manifest.js';
import type { AdminRouteDeps } from './routes.js';
import type { AdminOpEngine } from './domain/index.js';

/**
 * Unit coverage for the route seam alone: the manifest's routes are mounted
 * WITHOUT the pipeline (the class markers are pass-throughs), so the catalog
 * renderer and the principal defect guard are reachable directly. The full
 * pipeline path lives in routes.integration.test.ts.
 */

const unreachableEngine: AdminOpEngine = {
  run: () => {
    throw new Error('unit test: engine must not be reached');
  },
};

const reason = z.string().trim().min(1);

const capsContract = defineAdminOpContract({
  name: 'unit.caps',
  title: 'Guardrail render variants',
  kind: 'mutation',
  input: z.object({ targetId: z.uuid(), reason }),
  inverse: null,
  effectClass: 'ephemeral',
  guardrails: { rateLimitKey: 'admin-unit-caps' },
});

const bareContract = defineAdminOpContract({
  name: 'unit.bare',
  title: 'No guardrails',
  kind: 'mutation',
  input: z.object({ targetId: z.uuid(), reason }),
  inverse: null,
  effectClass: 'ephemeral',
});

function appWithPrincipal(
  principal: Principal,
  prefill: AdminRouteDeps['prefill'] = () => null
): Hono<AppEnv> {
  const manifest = createAdminManifest({
    engine: () => unreachableEngine,
    listOps: () => [capsContract, bareContract],
    prefill,
    reads: () => {
      throw new Error('admin reads are not under test in this suite');
    },
  });
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('principal', principal);
    await next();
  });
  app.route(manifest.basePath, manifest.routes);
  app.onError((error, c) => c.json({ message: error.message }, 500));
  return app;
}

const adminActor: Principal = {
  kind: 'admin-actor',
  email: 'admin@hushbox.test',
  audience: 'aud',
};

describe('GET /admin/ops catalog rendering', () => {
  it('renders non-money guardrails and omits absent ones', async () => {
    const response = await appWithPrincipal(adminActor).request('/admin/ops');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ops: [
        {
          name: 'unit.caps',
          title: 'Guardrail render variants',
          kind: 'mutation',
          effectClass: 'ephemeral',
          inverse: null,
          fields: ['targetId', 'reason'],
          guardrails: { rateLimitKey: 'admin-unit-caps' },
        },
        {
          name: 'unit.bare',
          title: 'No guardrails',
          kind: 'mutation',
          effectClass: 'ephemeral',
          inverse: null,
          fields: ['targetId', 'reason'],
        },
      ],
    });
  });
});

describe('GET /admin/ops/:name/prefill', () => {
  it('answers the resolved input envelope for an op with a resolver', async () => {
    const app = appWithPrincipal(adminActor, (_db, name) =>
      name === 'unit.caps' ? okAsync({ targetId: 'seeded' }) : null
    );
    const response = await app.request('/admin/ops/unit.caps/prefill');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ input: { targetId: 'seeded' } });
  });

  it('answers 404 when the dep resolves nothing (unknown op and resolver-less op alike)', async () => {
    const response = await appWithPrincipal(adminActor).request('/admin/ops/unit.caps/prefill');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: 'NOT_FOUND' });
  });

  it('maps a resolver domain failure through the uniform error body', async () => {
    const app = appWithPrincipal(adminActor, () => errAsync(unavailableError('store down')));
    const response = await app.request('/admin/ops/unit.caps/prefill');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'UNAVAILABLE' });
  });
});

describe('the admin-actor defect guard', () => {
  it('treats a non-admin principal reaching a handler as a defect, never a client error', async () => {
    // Only possible when the authorizer is bypassed (as this bare mount
    // does) — the route seam still refuses to attribute an op to a session.
    const full: Principal = {
      kind: 'full',
      claims: {
        userId: crypto.randomUUID(),
        sessionId: 's1',
        createdAt: 0,
        pending2FA: false,
        pending2FAExpiresAt: 0,
      },
    };
    const response = await appWithPrincipal(full).request('/admin/ops/unit.caps/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { targetId: crypto.randomUUID(), reason: 'x' } }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      message: 'admin routes: handler reached without an admin-actor principal',
    });
  });
});
