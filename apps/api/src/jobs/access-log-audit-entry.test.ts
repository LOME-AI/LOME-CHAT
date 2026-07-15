import { describe, expect, it, vi } from 'vitest';
import { createFakeAccessLogReader } from '../slices/admin/index.js';
import {
  ACCESS_LOG_LOOKBACK_MS,
  createAccessLogAuditEntry,
  createAccessLogReaderFromEnv,
} from './access-log-audit-entry.js';
import type { AccessLogEvent, AccessLogWindow } from '../slices/admin/index.js';
import type { Telemetry } from '../lib/telemetry/index.js';

const NOW = new Date('2026-07-14T12:00:00.000Z');
const ALLOWLIST = new Set(['admin@hushbox.test', 'ops@hushbox.test']);

function createLogger(): { logger: Telemetry; capturedCodes: string[] } {
  const capturedCodes: string[] = [];
  const noop = (): void => undefined;
  return {
    capturedCodes,
    logger: {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      emitMetric: noop,
      captureError: (_error, errorCode) => {
        capturedCodes.push(errorCode);
      },
    },
  };
}

function entryWith(events: readonly AccessLogEvent[]): {
  run: () => Promise<void>;
  capturedCodes: string[];
  windows: AccessLogWindow[];
} {
  const { logger, capturedCodes } = createLogger();
  const windows: AccessLogWindow[] = [];
  const reader = createFakeAccessLogReader(events);
  const entry = createAccessLogAuditEntry({
    resolveReader: () => ({
      listEvents: (window) => {
        windows.push(window);
        return reader.listEvents(window);
      },
    }),
    allowlist: () => ALLOWLIST,
    telemetry: logger,
    now: () => NOW,
  });
  expect(entry.name).toBe('admin-access-log-audit');
  return { run: entry.run, capturedCodes, windows };
}

describe('createAccessLogAuditEntry', () => {
  it('alerts on an authentication by an email outside the allowlist', async () => {
    const { run, capturedCodes } = entryWith([
      {
        email: 'intruder@example.com',
        kind: 'authentication',
        occurredAt: '2026-07-14T11:00:00.000Z',
      },
    ]);
    await run();
    expect(capturedCodes).toEqual(['admin_access_unexpected_actor']);
  });

  it('alerts on every enrollment-shaped event, allowlisted or not', async () => {
    const { run, capturedCodes } = entryWith([
      { email: 'admin@hushbox.test', kind: 'enrollment', occurredAt: '2026-07-14T11:00:00.000Z' },
    ]);
    await run();
    expect(capturedCodes).toEqual(['admin_access_enrollment_event']);
  });

  it('stays silent on allowlisted authentications', async () => {
    const { run, capturedCodes } = entryWith([
      {
        email: 'Admin@hushbox.test',
        kind: 'authentication',
        occurredAt: '2026-07-14T11:00:00.000Z',
      },
      { email: 'ops@hushbox.test', kind: 'authentication', occurredAt: '2026-07-14T11:05:00.000Z' },
    ]);
    await run();
    expect(capturedCodes).toEqual([]);
  });

  it('pulls the overlap-margined lookback window ending now', async () => {
    const { run, windows } = entryWith([]);
    await run();
    expect(windows).toHaveLength(1);
    expect(windows[0]?.until).toEqual(NOW);
    expect(windows[0]?.since).toEqual(new Date(NOW.getTime() - ACCESS_LOG_LOOKBACK_MS));
  });
});

describe('createAccessLogReaderFromEnv', () => {
  it('binds the fake reader (no events, no network) outside production', async () => {
    const reader = createAccessLogReaderFromEnv({ NODE_ENV: 'development' });
    await expect(reader.listEvents({ since: new Date(0), until: NOW })).resolves.toEqual([]);
  });

  it('fails fast in production when the API token is missing', () => {
    expect(() => createAccessLogReaderFromEnv({ NODE_ENV: 'production' })).toThrow(
      'CLOUDFLARE_ACCESS_LOG_API_TOKEN'
    );
  });

  it('fails fast in production when the Cloudflare account id is missing', () => {
    expect(() =>
      createAccessLogReaderFromEnv({
        NODE_ENV: 'production',
        CLOUDFLARE_ACCESS_LOG_API_TOKEN: 'real-token',
      })
    ).toThrow('CLOUDFLARE_ACCOUNT_ID');
  });

  it('binds the real Cloudflare reader in production when token and account id are set', async () => {
    const requested: string[] = [];
    const stubFetch: typeof globalThis.fetch = (input) => {
      requested.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(Response.json({ success: true, result: [] }));
    };
    vi.stubGlobal('fetch', stubFetch);
    try {
      const reader = createAccessLogReaderFromEnv({
        NODE_ENV: 'production',
        CLOUDFLARE_ACCESS_LOG_API_TOKEN: 'real-token',
        CLOUDFLARE_ACCOUNT_ID: 'real-account-id',
      });
      await expect(reader.listEvents({ since: new Date(0), until: NOW })).resolves.toEqual([]);
      expect(requested[0]).toContain('/accounts/real-account-id/access/logs/access_requests');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
