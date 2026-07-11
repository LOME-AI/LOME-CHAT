import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { AwsClient } from 'aws4fetch';
import { createUpdatesManifest } from './routes.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { AppBuildsBucket } from './routes.js';

/**
 * MinIO-backed download test: the APP_BUILDS binding shape is implemented
 * over the local R2 emulator (same S3 seam the media storage adapter uses),
 * so the route's streaming + header behavior is proven against a real
 * object store, not an in-memory stub.
 */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for updates download integration tests`);
  }
  return value;
}

const ENDPOINT = requiredEnv('R2_S3_ENDPOINT');
const BUCKET = requiredEnv('R2_BUCKET_MEDIA');
const aws = new AwsClient({
  accessKeyId: requiredEnv('R2_ACCESS_KEY_ID'),
  secretAccessKey: requiredEnv('R2_SECRET_ACCESS_KEY'),
  service: 's3',
  region: 'auto',
});

function objectUrl(key: string): string {
  return `${ENDPOINT}/${BUCKET}/${key}`;
}

function minioBuildsBucket(): AppBuildsBucket {
  return {
    get: async (key) => {
      const response = await aws.fetch(objectUrl(key), { method: 'GET' });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`minio GET failed: ${String(response.status)}`);
      const size = Number(response.headers.get('content-length') ?? '0');
      return { body: response.body, size };
    },
  };
}

const testEnv: Bindings & { APP_VERSION: string; APP_BUILDS: AppBuildsBucket } = {
  NODE_ENV: 'development',
  APP_VERSION: 'dev-local',
  APP_BUILDS: minioBuildsBucket(),
};

function buildApp(): Hono<AppEnv> {
  const manifest = createUpdatesManifest();
  return new Hono<AppEnv>().route(manifest.basePath, manifest.routes);
}

describe('GET /updates/download (MinIO-backed)', () => {
  it('streams an existing bundle as an immutable zip', async () => {
    const version = `1.0.0-${crypto.randomUUID().slice(0, 8)}`;
    const key = `builds/ios/${version}.zip`;
    const payload = new TextEncoder().encode(`zip-bytes-${version}`);
    const put = await aws.fetch(objectUrl(key), {
      method: 'PUT',
      body: payload,
      headers: { 'content-type': 'application/zip' },
    });
    expect(put.ok).toBe(true);

    try {
      const res = await buildApp().request(`/updates/download/ios/${version}`, {}, testEnv);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/zip');
      expect(res.headers.get('content-length')).toBe(String(payload.byteLength));
      expect(res.headers.get('cache-control')).toBe('public, max-age=86400, immutable');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(payload);
    } finally {
      await aws.fetch(objectUrl(key), { method: 'DELETE' });
    }
  });

  it('answers 404 BUILD_NOT_FOUND for a version that was never uploaded', async () => {
    const res = await buildApp().request(
      `/updates/download/android/0.0.0-${crypto.randomUUID().slice(0, 8)}`,
      {},
      testEnv
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'BUILD_NOT_FOUND' });
  });
});
