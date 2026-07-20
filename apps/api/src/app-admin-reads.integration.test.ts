import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb, users, wallets } from '@hushbox/db';
import { userFactory, walletFactory } from '@hushbox/db/factories';
import { eq } from 'drizzle-orm';
import { Mode, envConfig } from '@hushbox/shared';
import { createApp } from './app.js';
import { CF_ACCESS_JWT_HEADER, mintDevAdminToken } from './middleware/pipeline-admin.js';
import type { Bindings } from './lib/context/index.js';
import type { TelemetryEnv } from './lib/telemetry/index.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`admin reads mount tests: missing ${name}. Run via the package test script.`);
  }
  return value;
}

// `res.json()` is typed `unknown` by the typechecker but already-typed by the
// lint program, so an inline assertion is simultaneously required (typecheck)
// and flagged as redundant (lint). Reading through a generic seam satisfies
// both: the cast to a free type parameter is not a lint no-op.
async function jsonBody<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const DATABASE_URL = requiredEnv('DATABASE_URL');

const ADMIN_EMAIL = `admin-reads-mount-${crypto.randomUUID().slice(0, 8)}@hushbox.test`;

const adminEnv: Bindings &
  TelemetryEnv & { FRONTEND_URL: string; MARKETING_URL: string; FRONTEND_PREVIEW_URL: string } = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL: requiredEnv('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
  // The composed pipeline runs CORS first; it fail-fasts on absent web origins.
  FRONTEND_URL: requiredEnv('FRONTEND_URL'),
  MARKETING_URL: requiredEnv('MARKETING_URL'),
  FRONTEND_PREVIEW_URL: requiredEnv('FRONTEND_PREVIEW_URL'),
  CF_ACCESS_TEAM_DOMAIN: 'hushbox-dev',
  CF_ACCESS_AUD: 'dev-admin-access-aud',
  ADMIN_ACTOR_ALLOWLIST: ADMIN_EMAIL,
  CF_ACCESS_DEV_PRIVATE_JWK: envConfig.CF_ACCESS_DEV_PRIVATE_JWK[Mode.Development],
  ADMIN_SQL_PANEL_DATABASE_URL: requiredEnv('ADMIN_SQL_PANEL_DATABASE_URL'),
};

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

const createdUserIds: string[] = [];

afterAll(async () => {
  // admin_audit rows stay (append-only by trigger, actor-isolated); wallet rows
  // cascade with their user.
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
  await db.$client.end();
});

async function adminGet(path: string, env: Bindings & TelemetryEnv): Promise<Response> {
  const token = await mintDevAdminToken(env, { email: ADMIN_EMAIL });
  return createApp().request(path, { headers: { [CF_ACCESS_JWT_HEADER]: token } }, env);
}

describe('composed app: admin read surface (composition-root reads closure)', () => {
  it('assembles the customer 360 through the real billing read bindings', async () => {
    const [user] = await db.insert(users).values(userFactory.build()).returning({ id: users.id });
    if (user === undefined) throw new Error('admin reads mount tests: user insert returned no row');
    createdUserIds.push(user.id);
    await db.insert(wallets).values(walletFactory.build({ userId: user.id }));

    const res = await adminGet(`/admin/users/overview?userId=${user.id}`, adminEnv);

    expect(res.status).toBe(200);
    const view = await jsonBody<{
      user: { id: string };
      panels: { money: unknown; usage: unknown };
    }>(res);
    expect(view.user.id).toBe(user.id);
    // The money and usage panels prove the app.ts billing callbacks (balance,
    // ledgerHistory, usage) executed against the real stores.
    expect(view.panels.money).toBeDefined();
    expect(view.panels.usage).toBeDefined();
  });

  it('fails closed with INTERNAL when ADMIN_SQL_PANEL_DATABASE_URL is not configured', async () => {
    const withoutPanelUrl = { ...adminEnv, ADMIN_SQL_PANEL_DATABASE_URL: '' };

    const res = await adminGet('/admin/dashboard', withoutPanelUrl);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: 'INTERNAL' });
  });
});
