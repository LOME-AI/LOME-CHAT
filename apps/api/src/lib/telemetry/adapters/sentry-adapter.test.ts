import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSentryTelemetry,
  encodeTransportBody,
  sentryClientOptions,
} from './sentry-adapter.js';
import { scrubSentryEvent } from './sentry-scrub.js';
import { FINGERPRINT_CODES } from '../fingerprint-codes.js';
import type { SentryTransportFactory } from './sentry-adapter.js';

const DSN = 'https://abc123@o1.ingest.sentry.io/42';
const MESSAGE_SENTINEL = 'CONTENT-SENTINEL-select-users-7f3a';
const CAUSE_SENTINEL = 'CAUSE-SENTINEL-query-param-q9z';
const PII_SENTINEL = 'PII-SENTINEL-alice-at-example';

function createSpyTransport(): {
  factory: SentryTransportFactory;
  envelopes: unknown[];
  constructions: number[];
} {
  const envelopes: unknown[] = [];
  const constructions: number[] = [];
  return {
    factory: () => {
      constructions.push(constructions.length);
      return {
        send: (envelope) => {
          envelopes.push(envelope);
          return Promise.resolve({});
        },
        flush: () => Promise.resolve(true),
      };
    },
    envelopes,
    constructions,
  };
}

interface EnvelopeItem {
  readonly headers: { readonly type?: string };
  readonly payload: Record<string, unknown>;
}

function eventFromEnvelopes(envelopes: unknown[]): Record<string, unknown> | undefined {
  for (const envelope of envelopes) {
    const [, items] = envelope as [unknown, [EnvelopeItem['headers'], EnvelopeItem['payload']][]];
    for (const [headers, payload] of items) {
      if (headers.type === 'event') {
        return payload;
      }
    }
  }
  return undefined;
}

function forcedError(): Error {
  return new TypeError(MESSAGE_SENTINEL, {
    cause: new RangeError(CAUSE_SENTINEL, { cause: PII_SENTINEL }),
  });
}

describe('sentryClientOptions lock-down', () => {
  const options = sentryClientOptions(DSN, createSpyTransport().factory);

  it('disables default PII collection', () => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated, sonarjs/deprecation -- asserting the doctrine-pinned flag; the operative non-deprecated lock-down is dataCollection, asserted next
    expect(options.sendDefaultPii).toBe(false);
  });

  it('turns every dataCollection category off', () => {
    expect(options.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      queryParams: false,
      genAI: { inputs: false, outputs: false },
      stackFrameVariables: false,
      frameContextLines: 0,
    });
  });

  it('registers no integrations', () => {
    expect(options.integrations).toEqual([]);
  });

  it('disables breadcrumb collection', () => {
    expect(options.maxBreadcrumbs).toBe(0);
  });

  it('wires the scrub as beforeSend', () => {
    expect(options.beforeSend).toBe(scrubSentryEvent);
  });

  it('discards the raw stack at the client parser (the scrub rebuilds frames)', () => {
    expect(options.stackParser(`Error: ${MESSAGE_SENTINEL}\n    at fn (file.ts:1:1)`)).toEqual([]);
  });

  it('passes the dsn through', () => {
    expect(options.dsn).toBe(DSN);
  });
});

describe('createSentryTelemetry without a DSN (best-effort inert mode)', () => {
  it('never constructs a transport', () => {
    const { factory, constructions } = createSpyTransport();

    createSentryTelemetry({ transport: factory });

    expect(constructions).toHaveLength(0);
  });

  it('accepts every port method without sending or throwing', () => {
    const { factory, envelopes } = createSpyTransport();
    const telemetry = createSentryTelemetry({ transport: factory });

    expect(() => {
      telemetry.debug('probe');
      telemetry.info('probe');
      telemetry.warn('probe');
      telemetry.error('probe');
      telemetry.emitMetric('chat.tokens', 1);
      telemetry.captureError(new Error('boom'), FINGERPRINT_CODES.workflowNodeDefect);
    }).not.toThrow();
    expect(envelopes).toHaveLength(0);
  });
});

describe('createSentryTelemetry forced-error capture', () => {
  it('delivers stack frames, errorCode tag, and fingerprint with zero content', async () => {
    const { factory, envelopes } = createSpyTransport();
    const telemetry = createSentryTelemetry({ dsn: DSN, transport: factory });

    telemetry.captureError(forcedError(), FINGERPRINT_CODES.mediaGcDeleteFailed);

    await vi.waitFor(() => {
      expect(envelopes).toHaveLength(1);
    });
    const serialized = JSON.stringify(envelopes);
    expect(serialized).toContain(FINGERPRINT_CODES.mediaGcDeleteFailed);
    expect(serialized).toContain('TypeError');
    expect(serialized).toContain('"frames"');
    expect(serialized).not.toContain(MESSAGE_SENTINEL);
    expect(serialized).not.toContain(CAUSE_SENTINEL);
    expect(serialized).not.toContain(PII_SENTINEL);
  });

  it('emits the scrubbed event shape', async () => {
    const { factory, envelopes } = createSpyTransport();
    const telemetry = createSentryTelemetry({ dsn: DSN, transport: factory });

    telemetry.captureError(forcedError(), FINGERPRINT_CODES.mediaGcDeleteFailed);

    await vi.waitFor(() => {
      expect(envelopes).toHaveLength(1);
    });
    const event = eventFromEnvelopes(envelopes);
    expect(event?.['tags']).toEqual({ errorCode: FINGERPRINT_CODES.mediaGcDeleteFailed });
    expect(event?.['fingerprint']).toEqual([
      '{{ default }}',
      FINGERPRINT_CODES.mediaGcDeleteFailed,
    ]);
    expect(event).not.toHaveProperty('request');
    expect(event).not.toHaveProperty('user');
    expect(event).not.toHaveProperty('breadcrumbs');
    const exception = event?.['exception'] as { values: { type: string; value?: string }[] };
    expect(exception.values.map((value) => value.type)).toEqual(['RangeError', 'TypeError']);
    for (const value of exception.values) {
      expect(value).not.toHaveProperty('value');
    }
  });

  it('sends log methods and metrics nowhere (no breadcrumb channel)', async () => {
    const { factory, envelopes } = createSpyTransport();
    const telemetry = createSentryTelemetry({ dsn: DSN, transport: factory });

    telemetry.debug('probe');
    telemetry.info('probe');
    telemetry.warn('probe');
    telemetry.error('probe');
    telemetry.emitMetric('chat.tokens', 1);
    telemetry.captureError(new Error('flush marker'), FINGERPRINT_CODES.workflowNodeDefect);

    await vi.waitFor(() => {
      expect(envelopes).toHaveLength(1);
    });
    expect(JSON.stringify(envelopes)).not.toContain('probe');
    expect(JSON.stringify(envelopes)).not.toContain('chat.tokens');
  });
});

describe('createSentryTelemetry flush scheduling', () => {
  it('hands a flush task to scheduleFlush after a capture', async () => {
    const { factory, envelopes } = createSpyTransport();
    const tasks: Promise<unknown>[] = [];
    const telemetry = createSentryTelemetry({
      dsn: DSN,
      transport: factory,
      scheduleFlush: (task) => tasks.push(task),
    });

    telemetry.captureError(forcedError(), FINGERPRINT_CODES.mediaGcDeleteFailed);

    expect(tasks).toHaveLength(1);
    await Promise.all(tasks);
    expect(envelopes).toHaveLength(1);
  });

  it('schedules one flush task per capture', () => {
    const { factory } = createSpyTransport();
    const tasks: Promise<unknown>[] = [];
    const telemetry = createSentryTelemetry({
      dsn: DSN,
      transport: factory,
      scheduleFlush: (task) => tasks.push(task),
    });

    telemetry.captureError(new Error('first'), FINGERPRINT_CODES.workflowNodeDefect);
    telemetry.captureError(new Error('second'), FINGERPRINT_CODES.workflowNodeDefect);

    expect(tasks).toHaveLength(2);
  });

  it('schedules nothing without a DSN (inert mode has no client to flush)', () => {
    const tasks: Promise<unknown>[] = [];
    const telemetry = createSentryTelemetry({
      transport: createSpyTransport().factory,
      scheduleFlush: (task) => tasks.push(task),
    });

    telemetry.captureError(new Error('boom'), FINGERPRINT_CODES.workflowNodeDefect);

    expect(tasks).toHaveLength(0);
  });

  it('contains a throwing scheduleFlush (error channel is never)', () => {
    const telemetry = createSentryTelemetry({
      dsn: DSN,
      transport: createSpyTransport().factory,
      scheduleFlush: () => {
        throw new Error('no execution context');
      },
    });

    expect(() => {
      telemetry.captureError(new Error('boom'), FINGERPRINT_CODES.workflowNodeDefect);
    }).not.toThrow();
  });
});

describe('createSentryTelemetry best-effort containment (error channel is never)', () => {
  it('contains a transport factory that throws at construction', () => {
    const telemetry = createSentryTelemetry({
      dsn: DSN,
      transport: () => {
        throw new Error('transport construction failed');
      },
    });

    expect(() => {
      telemetry.captureError(new Error('boom'), FINGERPRINT_CODES.workflowNodeDefect);
    }).not.toThrow();
  });

  it('contains a hostile error object that defeats the SDK', () => {
    const { factory, envelopes } = createSpyTransport();
    const telemetry = createSentryTelemetry({ dsn: DSN, transport: factory });
    const hostile = new Proxy(new Error('x'), {
      get(_errorTarget, property): unknown {
        if (property === '__sentry_captured__') {
          return false;
        }
        throw new Error('hostile get');
      },
    });

    expect(() => {
      telemetry.captureError(hostile, FINGERPRINT_CODES.workflowNodeDefect);
    }).not.toThrow();
    expect(envelopes).toHaveLength(0);
  });
});

describe('encodeTransportBody', () => {
  it('passes a string envelope through', () => {
    expect(encodeTransportBody('envelope-text')).toBe('envelope-text');
  });

  it('copies a binary envelope into a fresh ArrayBuffer', () => {
    const bytes = new Uint8Array([1, 2, 3]);

    const body = encodeTransportBody(bytes);

    expect(body).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(body as ArrayBuffer)]).toEqual([1, 2, 3]);
  });
});

describe('createSentryTelemetry default transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the envelope to the DSN ingest endpoint via fetch', async () => {
    const requests: { url: string; body: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: { body: string }) => {
        requests.push({ url, body: init.body });
        return Promise.resolve({
          status: 200,
          headers: { get: (): null => null },
          text: () => Promise.resolve(''),
        });
      })
    );
    const telemetry = createSentryTelemetry({ dsn: DSN });

    telemetry.captureError(forcedError(), FINGERPRINT_CODES.mediaGcDeleteFailed);

    await vi.waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0]?.url).toContain('o1.ingest.sentry.io');
    expect(requests[0]?.body).toContain(FINGERPRINT_CODES.mediaGcDeleteFailed);
    expect(requests[0]?.body).not.toContain(MESSAGE_SENTINEL);
  });
});
