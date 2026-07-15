import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { Mode, envConfig } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { CF_ACCESS_JWT_HEADER } from '../../middleware/pipeline-admin.js';
import { routeClass } from '../../middleware/pipeline-markers.js';
import { createDevManifest } from './routes.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';

/** Type-safe JSON response parser for test assertions. */
async function jsonBody<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
import type { TelemetryEnv } from '../../lib/telemetry/index.js';

const ALLOWED_EMAIL = 'admin@hushbox.test';

const devEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:4444/hushbox',
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
  CF_ACCESS_TEAM_DOMAIN: 'hushbox-dev',
  CF_ACCESS_AUD: 'dev-admin-access-aud',
  ADMIN_ACTOR_ALLOWLIST: `${ALLOWED_EMAIL},ops@hushbox.test`,
  CF_ACCESS_DEV_PRIVATE_JWK: envConfig.CF_ACCESS_DEV_PRIVATE_JWK[Mode.Development],
};

/** The dev manifest plus an admin-classed probe, so the minted token is
 * proven against the REAL verification stage, not by decoding it. */
function createApp(): Hono<AppEnv> {
  const manifest = createDevManifest();
  const app = applyPipeline(new Hono<AppEnv>());
  app.route(manifest.basePath, manifest.routes);
  app.get('/admin-probe', routeClass('admin'), (c) => c.json({ principal: c.var.principal }));
  return app;
}

describe('GET /dev/admin-token', () => {
  it('mints a token for the chosen email that passes the real admin JWT verification', async () => {
    const app = createApp();
    const minted = await app.request(
      `/dev/admin-token?email=${encodeURIComponent(ALLOWED_EMAIL)}`,
      {},
      devEnv
    );
    expect(minted.status).toBe(200);
    const { token, header } = await jsonBody<{ token: string; header: string }>(minted);
    expect(header).toBe(CF_ACCESS_JWT_HEADER);

    const probe = await app.request(
      '/admin-probe',
      { headers: { [CF_ACCESS_JWT_HEADER]: token } },
      devEnv
    );
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({
      principal: {
        kind: 'admin-actor',
        email: ALLOWED_EMAIL,
        audience: 'dev-admin-access-aud',
      },
    });
  });

  it('supports actor switching: a second allowlisted email verifies as itself', async () => {
    const app = createApp();
    const minted = await app.request('/dev/admin-token?email=ops%40hushbox.test', {}, devEnv);
    expect(minted.status).toBe(200);
    const { token } = await jsonBody<{ token: string }>(minted);
    const probe = await app.request(
      '/admin-probe',
      { headers: { [CF_ACCESS_JWT_HEADER]: token } },
      devEnv
    );
    expect(probe.status).toBe(200);
    const body = await jsonBody<{ principal: { email: string } }>(probe);
    expect(body.principal.email).toBe('ops@hushbox.test');
  });

  it('rejects a malformed email at the boundary', async () => {
    const response = await createApp().request('/dev/admin-token?email=not-an-email', {}, devEnv);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 'VALIDATION' });
  });

  it('is hidden in production (404, indistinguishable from missing)', async () => {
    const response = await createApp().request(
      `/dev/admin-token?email=${encodeURIComponent(ALLOWED_EMAIL)}`,
      {},
      { ...devEnv, NODE_ENV: 'production' }
    );
    expect(response.status).toBe(404);
  });
});
