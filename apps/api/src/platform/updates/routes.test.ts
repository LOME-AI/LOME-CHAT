import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { clearVersionOverride, setVersionOverride } from '../../middleware/version-override.js';
import { createUpdatesManifest } from './routes.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { AppBuildsBucket } from './routes.js';

const SERVER_VERSION = '3.1.4';

interface TestBindings extends Bindings {
  APP_VERSION?: string;
  APP_BUILDS?: AppBuildsBucket;
}

const baseEnv: TestBindings = { NODE_ENV: 'development', APP_VERSION: SERVER_VERSION };

function buildApp(): Hono<AppEnv> {
  const manifest = createUpdatesManifest();
  return new Hono<AppEnv>()
    .route(manifest.basePath, manifest.routes)
    .onError((_error, c) => c.json({ code: 'INTERNAL' }, 500));
}

async function get(path: string, env: TestBindings = baseEnv): Promise<Response> {
  return buildApp().request(path, {}, env);
}

afterEach(() => {
  clearVersionOverride();
});

describe('GET /updates/current', () => {
  it('returns APP_VERSION', async () => {
    const res = await get('/updates/current');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: SERVER_VERSION });
  });

  it('returns the dev override once set', async () => {
    setVersionOverride('9.9.9');
    const res = await get('/updates/current');
    expect(await res.json()).toEqual({ version: '9.9.9' });
  });

  it('fails fast (defect) when APP_VERSION is missing', async () => {
    const res = await get('/updates/current', { NODE_ENV: 'development' });
    expect(res.status).toBe(500);
  });
});

describe('GET /updates/download/:platform/:version', () => {
  it('rejects an invalid platform with 400 VALIDATION', async () => {
    const res = await get('/updates/download/windows/1.0.0');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('answers 404 BUILD_NOT_FOUND when the bucket binding is missing', async () => {
    const res = await get('/updates/download/ios/1.0.0');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'BUILD_NOT_FOUND' });
  });

  it('answers 404 BUILD_NOT_FOUND when the object is missing', async () => {
    const bucket: AppBuildsBucket = { get: () => Promise.resolve(null) };
    const res = await get('/updates/download/android/1.0.0', {
      ...baseEnv,
      APP_BUILDS: bucket,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'BUILD_NOT_FOUND' });
  });

  it('requests the builds/<platform>/<version>.zip key', async () => {
    const keys: string[] = [];
    const bucket: AppBuildsBucket = {
      get: (key) => {
        keys.push(key);
        return Promise.resolve(null);
      },
    };
    await get('/updates/download/android-direct/2.0.0', { ...baseEnv, APP_BUILDS: bucket });
    expect(keys).toEqual(['builds/android-direct/2.0.0.zip']);
  });
});
