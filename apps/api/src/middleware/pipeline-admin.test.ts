import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { SignJWT, importJWK } from 'jose';
import { Mode, envConfig } from '@hushbox/shared';
import { applyPipeline } from './pipeline.js';
import { routeClass } from './pipeline-manifest.js';
import {
  CF_ACCESS_JWT_HEADER,
  accessIssuer,
  mintDevAdminToken,
  pipelineAdmin,
} from './pipeline-admin.js';
import type { AppEnv, Bindings } from '../lib/context/index.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';

const DEV_PRIVATE_JWK = envConfig.CF_ACCESS_DEV_PRIVATE_JWK[Mode.Development];

const TEAM_DOMAIN = 'hushbox-dev';
const AUDIENCE = 'dev-admin-access-aud';
const ALLOWED_EMAIL = 'admin@hushbox.test';

const baseEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:4444/hushbox',
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
  CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  CF_ACCESS_AUD: AUDIENCE,
  ADMIN_ACTOR_ALLOWLIST: `${ALLOWED_EMAIL},ops@hushbox.test`,
  CF_ACCESS_DEV_PRIVATE_JWK: DEV_PRIVATE_JWK,
};

function buildApp(): Hono<AppEnv> {
  const app = applyPipeline(new Hono<AppEnv>());
  app.get('/admin/ping', routeClass('admin'), (c) => c.json({ principal: c.var.principal }));
  app.get('/me', routeClass('session'), (c) => c.json({ principal: c.var.principal }));
  return app;
}

async function mint(overrides?: Partial<Parameters<typeof mintDevAdminToken>[1]>): Promise<string> {
  return mintDevAdminToken(baseEnv, { email: ALLOWED_EMAIL, ...overrides });
}

async function requestPing(
  token?: string,
  env: Bindings & TelemetryEnv = baseEnv
): Promise<Response> {
  const app = buildApp();
  return app.request(
    '/admin/ping',
    { headers: token === undefined ? {} : { [CF_ACCESS_JWT_HEADER]: token } },
    env
  );
}

describe('pipelineAdmin: fail-closed verification', () => {
  it('rejects a missing assertion with 401', async () => {
    const response = await requestPing();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 'UNAUTHORIZED' });
  });

  it('rejects a garbage token with 401 and the identical body shape', async () => {
    const missing = await requestPing();
    const garbage = await requestPing('not-a-jwt');
    expect(garbage.status).toBe(401);
    expect(await garbage.json()).toEqual(await missing.json());
  });

  it('rejects a wrong-audience token with 401', async () => {
    const response = await requestPing(await mint({ audience: 'some-other-app-aud' }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 'UNAUTHORIZED' });
  });

  it('rejects a wrong-issuer token with 401', async () => {
    const response = await requestPing(
      await mint({ issuer: 'https://attacker.cloudflareaccess.com' })
    );
    expect(response.status).toBe(401);
  });

  it('rejects an expired token with 401', async () => {
    const response = await requestPing(await mint({ expiresInSeconds: -60 }));
    expect(response.status).toBe(401);
  });

  it('rejects a non-allowlisted email with 401 and the identical body shape', async () => {
    const missing = await requestPing();
    const outsider = await requestPing(await mint({ email: 'intruder@hushbox.test' }));
    expect(outsider.status).toBe(401);
    expect(await outsider.json()).toEqual(await missing.json());
  });
});

describe('pipelineAdmin: acceptance', () => {
  it('mints the admin-actor principal from a valid assertion', async () => {
    const response = await requestPing(await mint());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      principal: { kind: 'admin-actor', email: ALLOWED_EMAIL, audience: AUDIENCE },
    });
  });

  it('matches allowlist entries case-insensitively (emails are not case-sensitive identities)', async () => {
    const response = await requestPing(await mint({ email: 'Admin@HushBox.test' }));
    expect(response.status).toBe(200);
  });
});

describe('pipelineAdmin: scope', () => {
  it('never mints a principal for a non-admin route (a valid assertion is not a session)', async () => {
    const app = buildApp();
    const response = await app.request(
      '/me',
      { headers: { [CF_ACCESS_JWT_HEADER]: await mint() } },
      baseEnv
    );
    expect(response.status).toBe(401);
  });

  it('throws a defect (500) when an admin route is reachable without Access config', async () => {
    const withoutTeam = { ...baseEnv };
    delete withoutTeam.CF_ACCESS_TEAM_DOMAIN;
    const response = await requestPing(await mint(), withoutTeam);
    expect(response.status).toBe(500);
  });

  it('throws a defect (500) outside production when the dev JWKS key is missing', async () => {
    const withoutKey = { ...baseEnv };
    delete withoutKey.CF_ACCESS_DEV_PRIVATE_JWK;
    const response = await requestPing(await mint(), withoutKey);
    expect(response.status).toBe(500);
  });
});

describe('the dev mint seam', () => {
  it('refuses to mint without the dev signing key (production is safe by construction)', async () => {
    const withoutKey = { ...baseEnv };
    delete withoutKey.CF_ACCESS_DEV_PRIVATE_JWK;
    await expect(mintDevAdminToken(withoutKey, { email: ALLOWED_EMAIL })).rejects.toThrow(
      /dev signing key/i
    );
  });

  it('production env registry carries NO dev signing key (nothing deployable mints access)', () => {
    expect(Mode.Production in envConfig.CF_ACCESS_DEV_PRIVATE_JWK).toBe(false);
  });

  it('derives the Access issuer from the team domain', () => {
    expect(accessIssuer('hushbox-dev')).toBe('https://hushbox-dev.cloudflareaccess.com');
  });
});

describe('pipelineAdmin: production key source', () => {
  it('resolves the REMOTE Access JWKS in production and still fails closed on a garbage token', async () => {
    // A garbage token fails jose's parse before any key fetch, so this
    // exercises the production key-source branch (and its per-domain
    // memoization on the second request) without touching the network.
    const productionEnv = { ...baseEnv, NODE_ENV: 'production' };
    const first = await requestPing('not-a-jwt', productionEnv);
    expect(first.status).toBe(401);
    const second = await requestPing('not-a-jwt-either', productionEnv);
    expect(second.status).toBe(401);
  });
});

describe('pipelineAdmin: stage construction', () => {
  it('is a pass-through for requests matching no admin route', async () => {
    const app = new Hono<AppEnv>();
    // Minimal chain proving the stage alone never blocks non-admin traffic.
    applyPipeline(app);
    app.get('/plain', routeClass('public'), (c) => c.json({ ok: true }));
    expect(pipelineAdmin()).toBeTypeOf('function');
    const response = await app.request('/plain', {}, baseEnv);
    expect(response.status).toBe(200);
  });

  it('throws a defect when the allowlist parses to zero actors', async () => {
    const response = await requestPing(await mint(), {
      ...baseEnv,
      ADMIN_ACTOR_ALLOWLIST: ' , ,, ',
    });
    expect(response.status).toBe(500);
  });

  it('throws the pipeline-order defect when composed without the env stage', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', pipelineAdmin());
    app.get('/admin/ping', routeClass('admin'), (c) => c.json({ ok: true }));
    app.onError((error, c) => c.json({ message: (error as Error).message }, 500));
    const response = await app.request('/admin/ping', {}, baseEnv);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      message: 'pipeline order violated: pipelineAdmin requires pipelineEnv first.',
    });
  });

  it('rejects an otherwise-valid token whose payload carries no email claim', async () => {
    const jwk = JSON.parse(DEV_PRIVATE_JWK) as Record<string, unknown>;
    const key = await importJWK(jwk, 'EdDSA');
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer(accessIssuer(TEAM_DOMAIN))
      .setAudience(AUDIENCE)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 600)
      .sign(key);
    const response = await requestPing(token);
    expect(response.status).toBe(401);
  });
});

describe('pipelineAdmin: the Single Auth Path Law (CODE-RULES §Admin Operations)', () => {
  // A Cloudflare service-token assertion carries `common_name`, never `email`.
  // The stage requires a non-empty allowlisted email, so a service token fails
  // closed even if the Access app were misconfigured to admit one.
  async function signServiceShapedToken(claims: Record<string, unknown>): Promise<string> {
    const jwk = JSON.parse(DEV_PRIVATE_JWK) as Record<string, unknown>;
    const key = await importJWK(jwk, 'EdDSA');
    const nowSeconds = Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer(accessIssuer(TEAM_DOMAIN))
      .setAudience(AUDIENCE)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 600)
      .sign(key);
  }

  it('rejects a validly-signed service-token assertion (common_name, no email) with 401 and zero effect', async () => {
    const token = await signServiceShapedToken({
      common_name: 'ci-service-token.access',
    });
    const response = await requestPing(token);
    expect(response.status).toBe(401);
    // Zero effect: the unauthorized body, never the handler's principal echo.
    expect(await response.json()).toEqual({ code: 'UNAUTHORIZED' });
  });

  it('rejects an empty-string email claim with 401 (non-empty is required, not just present)', async () => {
    const token = await signServiceShapedToken({
      common_name: 'ci-service-token.access',
      email: '',
    });
    const response = await requestPing(token);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 'UNAUTHORIZED' });
  });
});

describe('mintDevAdminToken edge cases', () => {
  it('refuses a public (non-private) JWK as the signing key', async () => {
    const jwk = JSON.parse(DEV_PRIVATE_JWK) as Record<string, unknown>;
    delete jwk['d'];
    await expect(
      mintDevAdminToken(
        { ...baseEnv, CF_ACCESS_DEV_PRIVATE_JWK: JSON.stringify(jwk) },
        { email: ALLOWED_EMAIL }
      )
    ).rejects.toThrow(/private JWK/);
  });

  it('refuses to mint without the team domain / audience config', async () => {
    const withoutAud = { ...baseEnv };
    delete withoutAud.CF_ACCESS_AUD;
    await expect(mintDevAdminToken(withoutAud, { email: ALLOWED_EMAIL })).rejects.toThrow(
      /CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD/
    );
  });

  it('mints and verifies with a kid-less dev key (no fabricated header kid)', async () => {
    const jwk = JSON.parse(DEV_PRIVATE_JWK) as Record<string, unknown>;
    delete jwk['kid'];
    const env = { ...baseEnv, CF_ACCESS_DEV_PRIVATE_JWK: JSON.stringify(jwk) };
    const token = await mintDevAdminToken(env, { email: ALLOWED_EMAIL });
    // Verification consumes the same kid-less key, so the round trip holds.
    const response = await requestPing(token, env);
    expect(response.status).toBe(200);
  });
});
