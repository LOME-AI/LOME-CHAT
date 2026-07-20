import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { Mode, envConfig } from '@hushbox/shared';
import { createApp } from './app.js';
import { CF_ACCESS_JWT_HEADER, mintDevAdminToken } from './middleware/pipeline-admin.js';
import { hashRateLimitId } from './middleware/rate-limit.js';
import {
  adminAuditSearchRateLimit,
  adminNewsletterSubscribersRateLimit,
} from './slices/admin/index.js';
import type { Bindings } from './lib/context/index.js';
import type { TelemetryEnv } from './lib/telemetry/index.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`admin rate-limit tests: missing ${name}. Run via a package test script.`);
  }
  return value;
}

const DATABASE_URL = requiredEnv('DATABASE_URL');
const UPSTASH_REDIS_REST_URL = requiredEnv('UPSTASH_REDIS_REST_URL');
const UPSTASH_REDIS_REST_TOKEN = requiredEnv('UPSTASH_REDIS_REST_TOKEN');

function panelUrl(): string {
  const url = new URL(DATABASE_URL);
  url.username = 'admin_sql_panel';
  url.password = 'admin_sql_panel';
  return url.toString();
}

const ADMIN_EMAIL = `admin-mount-ratelimit-${crypto.randomUUID().slice(0, 8)}@hushbox.test`;

const devEnv: Bindings &
  TelemetryEnv & { FRONTEND_URL: string; MARKETING_URL: string; FRONTEND_PREVIEW_URL: string } = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
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
  ADMIN_SQL_PANEL_DATABASE_URL: panelUrl(),
};

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const redisKeysToClean: string[] = [];

afterAll(async () => {
  for (const key of redisKeysToClean) {
    await redis.del(key);
  }
});

// The admin read-volume caps mount at the composition root (app.ts), not the
// slice manifest, so only a request through the real composed app proves the
// mounted path consults the production registry entry. The per-actor window
// (240/h) is far too wide to trip cheaply; the evidence asserted instead is
// the production registry key appearing in Redis with the consumed attempt.
describe('composed app: admin read-volume caps', () => {
  it('consults the production audit-search window for an admin request to /admin/audit', async () => {
    const app = createApp();
    const token = await mintDevAdminToken(devEnv, { email: ADMIN_EMAIL });
    const windowKey = adminAuditSearchRateLimit.buildKey(await hashRateLimitId(ADMIN_EMAIL));
    redisKeysToClean.push(windowKey);

    const res = await app.request(
      '/admin/audit?limit=1',
      { method: 'GET', headers: { [CF_ACCESS_JWT_HEADER]: token } },
      devEnv
    );
    expect(res.status).toBe(200);

    const window = adminAuditSearchRateLimit.schema.parse(await redis.get(windowKey));
    expect(window.count).toBe(1);
  });

  it('consults the production subscriber-list window for an admin request to /admin/newsletter/subscribers', async () => {
    const app = createApp();
    const token = await mintDevAdminToken(devEnv, { email: ADMIN_EMAIL });
    const windowKey = adminNewsletterSubscribersRateLimit.buildKey(
      await hashRateLimitId(ADMIN_EMAIL)
    );
    redisKeysToClean.push(windowKey);

    const res = await app.request(
      '/admin/newsletter/subscribers?limit=1',
      { method: 'GET', headers: { [CF_ACCESS_JWT_HEADER]: token } },
      devEnv
    );
    expect(res.status).toBe(200);

    const window = adminNewsletterSubscribersRateLimit.schema.parse(await redis.get(windowKey));
    expect(window.count).toBe(1);
  });
});
