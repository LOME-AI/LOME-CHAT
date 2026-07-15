import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { clearVersionOverride, setVersionOverride } from '../../middleware/version-override.js';
import { createUpdatesManifest } from './routes.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { AppBuildsBucket } from './routes.js';

const SERVER_VERSION = '3.1.4';

// Distinct per-platform checksums prove the route selects by platform, not a
// single shared value.
const IOS_CHECKSUM = 'a'.repeat(64);
const ANDROID_CHECKSUM = 'b'.repeat(64);
const ANDROID_DIRECT_CHECKSUM = 'c'.repeat(64);

interface TestBindings extends Bindings {
  APP_VERSION?: string;
  APP_BUILDS?: AppBuildsBucket;
  APP_BUNDLE_CHECKSUM_IOS?: string;
  APP_BUNDLE_CHECKSUM_ANDROID?: string;
  APP_BUNDLE_CHECKSUM_ANDROID_DIRECT?: string;
}

const baseEnv: TestBindings = {
  NODE_ENV: 'development',
  APP_VERSION: SERVER_VERSION,
  APP_BUNDLE_CHECKSUM_IOS: IOS_CHECKSUM,
  APP_BUNDLE_CHECKSUM_ANDROID: ANDROID_CHECKSUM,
  APP_BUNDLE_CHECKSUM_ANDROID_DIRECT: ANDROID_DIRECT_CHECKSUM,
};

function buildApp(): Hono<AppEnv> {
  const manifest = createUpdatesManifest();
  return new Hono<AppEnv>()
    .route(manifest.basePath, manifest.routes)
    .onError((_error, c) => c.json({ code: 'INTERNAL' }, 500));
}

async function get(
  path: string,
  env: TestBindings = baseEnv,
  headers: Record<string, string> = {}
): Promise<Response> {
  return buildApp().request(path, { headers }, env);
}

afterEach(() => {
  clearVersionOverride();
});

describe('GET /updates/current', () => {
  it('returns APP_VERSION without a platform header (checksum omitted)', async () => {
    const res = await get('/updates/current');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: SERVER_VERSION });
  });

  it('returns the dev override once set', async () => {
    setVersionOverride('9.9.9');
    const res = await get('/updates/current');
    expect(await res.json()).toEqual({ version: '9.9.9' });
  });

  it('serves Cache-Control: no-store so clients never cache the version', async () => {
    const res = await get('/updates/current');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('returns the ios checksum for X-HushBox-Platform: ios', async () => {
    const res = await get('/updates/current', baseEnv, { 'X-HushBox-Platform': 'ios' });
    expect(await res.json()).toEqual({ version: SERVER_VERSION, checksum: IOS_CHECKSUM });
  });

  it('returns the android checksum for X-HushBox-Platform: android', async () => {
    const res = await get('/updates/current', baseEnv, { 'X-HushBox-Platform': 'android' });
    expect(await res.json()).toEqual({ version: SERVER_VERSION, checksum: ANDROID_CHECKSUM });
  });

  it('returns the android-direct checksum for X-HushBox-Platform: android-direct', async () => {
    const res = await get('/updates/current', baseEnv, { 'X-HushBox-Platform': 'android-direct' });
    expect(await res.json()).toEqual({
      version: SERVER_VERSION,
      checksum: ANDROID_DIRECT_CHECKSUM,
    });
  });

  it('still serves no-store with a platform-specific checksum', async () => {
    const res = await get('/updates/current', baseEnv, { 'X-HushBox-Platform': 'ios' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('omits the checksum for an unknown platform', async () => {
    const res = await get('/updates/current', baseEnv, { 'X-HushBox-Platform': 'windows' });
    expect(await res.json()).toEqual({ version: SERVER_VERSION });
  });

  it('omits the checksum for the web platform (web never OTA-updates)', async () => {
    const res = await get('/updates/current', baseEnv, { 'X-HushBox-Platform': 'web' });
    expect(await res.json()).toEqual({ version: SERVER_VERSION });
  });

  it("omits the checksum when the platform's binding is unset", async () => {
    const res = await get(
      '/updates/current',
      { NODE_ENV: 'development', APP_VERSION: SERVER_VERSION },
      { 'X-HushBox-Platform': 'ios' }
    );
    expect(await res.json()).toEqual({ version: SERVER_VERSION });
  });

  it("omits the checksum when the platform's binding is the empty string", async () => {
    const res = await get(
      '/updates/current',
      { ...baseEnv, APP_BUNDLE_CHECKSUM_IOS: '' },
      { 'X-HushBox-Platform': 'ios' }
    );
    expect(await res.json()).toEqual({ version: SERVER_VERSION });
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
