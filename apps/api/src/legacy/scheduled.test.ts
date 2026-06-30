import { describe, it, expect, vi, beforeEach } from 'vitest';

const purgeExpiredDeletionEventsMock = vi.fn();
vi.mock('@hushbox/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@hushbox/db');
  return {
    ...actual,
    createDb: vi.fn(() => ({ mocked: 'db' })),
    purgeExpiredDeletionEvents: purgeExpiredDeletionEventsMock,
  };
});

vi.mock('aws4fetch', () => ({
  AwsClient: class MockAwsClient {
    fetch = vi.fn();
    sign = vi.fn();
  },
}));

const runR2GcMock = vi.fn();
vi.mock('./services/gc/r2-gc.js', () => ({
  runR2Gc: runR2GcMock,
}));

const { scheduledHandler } = await import('./scheduled.js');
import type { Bindings } from './types.js';

const baseEnv: Bindings = {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  APP_VERSION: '0.0.0',
  R2_S3_ENDPOINT: 'http://localhost:9000',
  R2_ACCESS_KEY_ID: 'minioadmin',
  R2_SECRET_ACCESS_KEY: 'minioadmin',
  R2_BUCKET_MEDIA: 'hushbox-media-dev',
};

const baseEvent = { cron: '0 3 * * *', scheduledTime: Date.now() };
const baseCtx = { waitUntil: vi.fn() };

describe('scheduledHandler', () => {
  beforeEach(() => {
    runR2GcMock.mockReset();
    purgeExpiredDeletionEventsMock.mockReset();
    purgeExpiredDeletionEventsMock.mockResolvedValue({ purged: 0 });
  });

  it('invokes runR2Gc and logs the result', async () => {
    runR2GcMock.mockResolvedValueOnce({
      scanned: 10,
      orphansFound: 2,
      deleted: 2,
      bytesReclaimed: 4096,
      durationMs: 123,
    });
    const logSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await scheduledHandler(baseEvent, baseEnv, baseCtx);
      expect(runR2GcMock).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(
        'r2-gc',
        expect.objectContaining({ scanned: 10, deleted: 2 })
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it('throws when DATABASE_URL is missing so Cloudflare records cron failure', async () => {
    const env = { ...baseEnv, DATABASE_URL: '' };

    await expect(scheduledHandler(baseEvent, env, baseCtx)).rejects.toThrow(
      'DATABASE_URL is required for the scheduled handler'
    );
    expect(runR2GcMock).not.toHaveBeenCalled();
  });

  it('rethrows on runR2Gc failure so Cloudflare records cron failure', async () => {
    runR2GcMock.mockRejectedValueOnce(new Error('r2 unavailable'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(scheduledHandler(baseEvent, baseEnv, baseCtx)).rejects.toThrow('r2 unavailable');
      expect(errorSpy).toHaveBeenCalledWith('r2-gc failed', expect.any(Error));
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('runs the deletion-events purge after R2 GC and logs the result', async () => {
    const callOrder: string[] = [];
    runR2GcMock.mockImplementationOnce(() => {
      callOrder.push('r2-gc');
      return Promise.resolve({
        scanned: 0,
        orphansFound: 0,
        deleted: 0,
        bytesReclaimed: 0,
        durationMs: 1,
      });
    });
    purgeExpiredDeletionEventsMock.mockImplementationOnce(() => {
      callOrder.push('purge');
      return Promise.resolve({ purged: 5 });
    });
    const logSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await scheduledHandler(baseEvent, baseEnv, baseCtx);
      expect(runR2GcMock).toHaveBeenCalledTimes(1);
      expect(purgeExpiredDeletionEventsMock).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(['r2-gc', 'purge']);
      expect(logSpy).toHaveBeenCalledWith(
        'account-deletion-events-purge',
        expect.objectContaining({ purged: 5 })
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it('still runs the purge when R2 GC throws and rethrows the R2 GC error', async () => {
    runR2GcMock.mockRejectedValueOnce(new Error('r2 unavailable'));
    purgeExpiredDeletionEventsMock.mockResolvedValueOnce({ purged: 2 });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(scheduledHandler(baseEvent, baseEnv, baseCtx)).rejects.toThrow('r2 unavailable');
      expect(purgeExpiredDeletionEventsMock).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        'account-deletion-events-purge',
        expect.objectContaining({ purged: 2 })
      );
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('throws when the purge throws even if R2 GC succeeded', async () => {
    runR2GcMock.mockResolvedValueOnce({
      scanned: 0,
      orphansFound: 0,
      deleted: 0,
      bytesReclaimed: 0,
      durationMs: 1,
    });
    purgeExpiredDeletionEventsMock.mockRejectedValueOnce(new Error('purge db error'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(scheduledHandler(baseEvent, baseEnv, baseCtx)).rejects.toThrow('purge db error');
      expect(errorSpy).toHaveBeenCalledWith(
        'account-deletion-events-purge failed',
        expect.any(Error)
      );
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('throws the first error when both R2 GC and the purge throw', async () => {
    runR2GcMock.mockRejectedValueOnce(new Error('r2 unavailable'));
    purgeExpiredDeletionEventsMock.mockRejectedValueOnce(new Error('purge db error'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(scheduledHandler(baseEvent, baseEnv, baseCtx)).rejects.toThrow('r2 unavailable');
      expect(errorSpy).toHaveBeenCalledWith('r2-gc failed', expect.any(Error));
      expect(errorSpy).toHaveBeenCalledWith(
        'account-deletion-events-purge failed',
        expect.any(Error)
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
