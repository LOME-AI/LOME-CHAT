import { describe, expect, it } from 'vitest';
import { scrubSentryEvent } from './sentry-scrub.js';
import type { ErrorEvent, EventHint } from '@sentry/cloudflare';

const MESSAGE_SENTINEL = 'SELECT * FROM users WHERE email = leak@example.com';
const PII_SENTINEL = 'alice@example.com';
const BODY_SENTINEL = 'request body with prompt text';

function hostileEvent(): ErrorEvent {
  return {
    type: undefined,
    event_id: 'e-1',
    timestamp: 1_750_000_000,
    platform: 'javascript',
    level: 'error',
    environment: 'production',
    release: 'app@1.0.0',
    message: MESSAGE_SENTINEL,
    transaction: '/conversations/abc?token=secret',
    server_name: 'host-internal-name',
    user: { email: PII_SENTINEL, ip_address: '203.0.113.7' },
    request: {
      url: 'https://api.example.com/chat?q=secret',
      headers: { cookie: 'session=secret-cookie' },
      data: BODY_SENTINEL,
    },
    breadcrumbs: [{ message: 'breadcrumb with content' }],
    extra: { requestSnapshot: BODY_SENTINEL },
    contexts: { trace: { trace_id: 'abc', span_id: 'def' } },
    tags: { errorCode: 'db_query_failed', smuggled: PII_SENTINEL },
    fingerprint: ['custom'],
    exception: { values: [{ type: 'Error', value: MESSAGE_SENTINEL }] },
  };
}

describe('scrubSentryEvent field allowlist', () => {
  it('drops every content-capable field from the event', () => {
    const scrubbed = scrubSentryEvent(hostileEvent(), {});

    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(MESSAGE_SENTINEL);
    expect(serialized).not.toContain(PII_SENTINEL);
    expect(serialized).not.toContain(BODY_SENTINEL);
    expect(serialized).not.toContain('secret');
  });

  it('emits no request, user, breadcrumb, extra, or contexts keys', () => {
    const scrubbed = scrubSentryEvent(hostileEvent(), {});

    expect(scrubbed).not.toHaveProperty('request');
    expect(scrubbed).not.toHaveProperty('user');
    expect(scrubbed).not.toHaveProperty('breadcrumbs');
    expect(scrubbed).not.toHaveProperty('extra');
    expect(scrubbed).not.toHaveProperty('contexts');
    expect(scrubbed).not.toHaveProperty('message');
    expect(scrubbed).not.toHaveProperty('transaction');
    expect(scrubbed).not.toHaveProperty('server_name');
  });

  it('preserves exactly the allowlisted top-level field set so a widened allowlist fails here', () => {
    const scrubbed = scrubSentryEvent(hostileEvent(), {});

    // The scrub rebuilds the event from an allowlist rather than deleting
    // known-bad fields. This pins the EXACT set of top-level keys that may
    // survive, so ADDING a field to the allowlist (a widening) breaks this
    // assertion — the regression guard against a silent allowlist expansion.
    // Set comparison is order-independent and rejects both extra and missing
    // keys.
    expect(new Set(Object.keys(scrubbed ?? {}))).toEqual(
      new Set([
        'type',
        'event_id',
        'timestamp',
        'platform',
        'level',
        'environment',
        'release',
        'exception',
        'tags',
        'fingerprint',
      ])
    );
  });

  it('keeps the opaque envelope fields', () => {
    const scrubbed = scrubSentryEvent(hostileEvent(), {});

    expect(scrubbed?.event_id).toBe('e-1');
    expect(scrubbed?.timestamp).toBe(1_750_000_000);
    expect(scrubbed?.platform).toBe('javascript');
    expect(scrubbed?.level).toBe('error');
    expect(scrubbed?.environment).toBe('production');
    expect(scrubbed?.release).toBe('app@1.0.0');
  });

  it('keeps only the errorCode tag', () => {
    const scrubbed = scrubSentryEvent(hostileEvent(), {});

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed' });
  });

  it('sets the errorCode as a fingerprint component alongside default grouping', () => {
    const scrubbed = scrubSentryEvent(hostileEvent(), {});

    expect(scrubbed?.fingerprint).toEqual(['{{ default }}', 'db_query_failed']);
  });

  it('surfaces a provider-failure statusCode as a discrete tag while dropping message, url, and body', () => {
    const error = Object.assign(new Error('provider failed: ' + MESSAGE_SENTINEL), {
      statusCode: 429,
      url: 'https://openrouter.ai/api/v1/chat?key=' + PII_SENTINEL,
      responseBody: BODY_SENTINEL,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed', statusCode: 429 });
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(MESSAGE_SENTINEL);
    expect(serialized).not.toContain(BODY_SENTINEL);
    expect(serialized).not.toContain(PII_SENTINEL);
    expect(serialized).not.toContain('openrouter.ai');
  });

  it('surfaces cost-circuit-trip runId and absorbedNanoUsd as discrete tags while dropping message and PII', () => {
    const error = Object.assign(new Error('cost circuit tripped ' + MESSAGE_SENTINEL), {
      runId: '018f3a2b-0000-7000-8000-000000000000',
      // The nano-USD bigint as a string — money is never Number()-coerced.
      absorbedNanoUsd: '2000',
      // A PII-bearing sibling property must NOT surface: only the two
      // allowlisted keys travel.
      userEmail: PII_SENTINEL,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({
      errorCode: 'db_query_failed',
      runId: '018f3a2b-0000-7000-8000-000000000000',
      absorbedNanoUsd: '2000',
    });
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(MESSAGE_SENTINEL);
    expect(serialized).not.toContain(PII_SENTINEL);
  });

  it('drops a non-string runId and a non-numeric-string absorbedNanoUsd rather than surfacing content', () => {
    const error = Object.assign(new Error('x'), {
      runId: { leaked: PII_SENTINEL },
      absorbedNanoUsd: 'lots ' + PII_SENTINEL,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed' });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('drops a numeric (non-string) absorbedNanoUsd — the amount travels only as a nano-USD string', () => {
    const error = Object.assign(new Error('x'), {
      runId: '018f3a2b-0000-7000-8000-000000000000',
      absorbedNanoUsd: 2000,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({
      errorCode: 'db_query_failed',
      runId: '018f3a2b-0000-7000-8000-000000000000',
    });
  });

  it('finds the statusCode in the cause chain', () => {
    const root = Object.assign(new Error('root'), { statusCode: 503 });
    const outer = new Error('outer', { cause: root });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: outer });

    expect(scrubbed?.tags?.['statusCode']).toBe(503);
  });

  it('omits the statusCode tag when the error carries none', () => {
    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: new Error('x') });

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed' });
    expect(scrubbed?.tags).not.toHaveProperty('statusCode');
  });

  it('drops a non-numeric statusCode rather than surfacing content', () => {
    const error = Object.assign(new Error('x'), { statusCode: 'Internal ' + PII_SENTINEL });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed' });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('falls back to unknown when the errorCode tag is absent', () => {
    const event = hostileEvent();
    delete event.tags;

    const scrubbed = scrubSentryEvent(event, {});

    expect(scrubbed?.tags).toEqual({ errorCode: 'unknown' });
    expect(scrubbed?.fingerprint).toEqual(['{{ default }}', 'unknown']);
  });

  it('fails closed on an unscrubbable event', () => {
    const event = hostileEvent();
    Object.defineProperty(event, 'tags', {
      get(): never {
        throw new Error('hostile getter');
      },
    });

    expect(scrubSentryEvent(event, {})).toBeNull();
  });
});

describe('scrubSentryEvent exception chain', () => {
  function hintFor(error: unknown): EventHint {
    return { originalException: error };
  }

  it('rebuilds one exception value per error in the cause chain', () => {
    const root = new RangeError('root cause with ' + MESSAGE_SENTINEL);
    const middle = new TypeError('middle with ' + PII_SENTINEL, { cause: root });
    const outer = new Error('outer with ' + BODY_SENTINEL, { cause: middle });

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(outer));

    expect(scrubbed?.exception?.values).toHaveLength(3);
  });

  it('orders the chain deepest cause first with the reported error last', () => {
    const root = new RangeError('root');
    const outer = new TypeError('outer', { cause: root });

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(outer));

    expect(scrubbed?.exception?.values?.map((value) => value.type)).toEqual([
      'RangeError',
      'TypeError',
    ]);
  });

  it('never carries an exception message', () => {
    const outer = new Error(MESSAGE_SENTINEL, { cause: new Error(PII_SENTINEL) });

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(outer));

    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(MESSAGE_SENTINEL);
    expect(serialized).not.toContain(PII_SENTINEL);
    for (const value of scrubbed?.exception?.values ?? []) {
      expect(value).not.toHaveProperty('value');
    }
  });

  it('stops the walk at a non-Error cause and drops its content', () => {
    const outer = new Error('outer', { cause: 'string cause with ' + PII_SENTINEL });

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(outer));

    expect(scrubbed?.exception?.values).toHaveLength(1);
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('caps the chain at five exception values', () => {
    let error = new Error('depth 0');
    for (let depth = 1; depth < 8; depth += 1) {
      error = new Error(`depth ${String(depth)}`, { cause: error });
    }

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(error));

    expect(scrubbed?.exception?.values).toHaveLength(5);
  });

  it('parses frames into filename, lineno, and colno', () => {
    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(new Error('x')));

    const frames = scrubbed?.exception?.values?.[0]?.stacktrace?.frames ?? [];
    expect(frames.length).toBeGreaterThan(0);
    const last = frames.at(-1);
    expect(typeof last?.filename).toBe('string');
    expect(typeof last?.lineno).toBe('number');
    expect(typeof last?.colno).toBe('number');
  });

  it('orders frames oldest-call-first with the crash site last', () => {
    function innerThrow(): Error {
      return new Error('boom');
    }
    function outerCall(): Error {
      return innerThrow();
    }

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(outerCall()));

    const frames = scrubbed?.exception?.values?.[0]?.stacktrace?.frames ?? [];
    const names = frames.map((frame) => frame.function ?? '');
    expect(names.indexOf('outerCall')).toBeLessThan(names.indexOf('innerThrow'));
    expect(names.at(-1)).toBe('innerThrow');
  });

  it('drops frame-shaped lines embedded in the message while keeping real frames', () => {
    const error = new Error('boom\n    at fake (/home/alice/secret-content.ts:1:1)');

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(error));

    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain('secret-content');
    expect(scrubbed?.exception?.values?.[0]?.stacktrace?.frames?.length).toBeGreaterThan(0);
  });

  it('emits no frames when the stack header cannot be derived (fail closed)', () => {
    const error = new Error('m');
    error.stack = `mangled by a library: ${PII_SENTINEL}\n    at real (file.ts:1:1)`;

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(error));

    expect(scrubbed?.exception?.values?.[0]?.stacktrace).toBeUndefined();
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('omits the stacktrace for an error without a stack', () => {
    const error = new Error('no trace');
    delete error.stack;

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(error));

    expect(scrubbed?.exception?.values?.[0]?.stacktrace).toBeUndefined();
  });

  it('sanitizes a content-bearing error name', () => {
    const error = new Error('x');
    error.name = 'ENOENT: /home/alice/.ssh/id_rsa';

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(error));

    expect(scrubbed?.exception?.values?.[0]?.type).toBe('Error');
    expect(JSON.stringify(scrubbed)).not.toContain('id_rsa');
  });

  it('emits empty exception values for a non-Error originalException', () => {
    const scrubbed = scrubSentryEvent(
      hostileEvent(),
      hintFor('thrown string with ' + PII_SENTINEL)
    );

    expect(scrubbed?.exception?.values).toEqual([]);
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('emits empty exception values when the hint is absent', () => {
    const scrubbed = scrubSentryEvent(hostileEvent());

    expect(scrubbed?.exception?.values).toEqual([]);
  });

  it('parses a location-only frame line without a function name', () => {
    const error = new Error('m');
    error.stack = 'Error: m\n    at /srv/app/file.ts:5:7';

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(error));

    const frame = scrubbed?.exception?.values?.[0]?.stacktrace?.frames?.[0];
    expect(frame).toEqual({ filename: '/srv/app/file.ts', lineno: 5, colno: 7, in_app: true });
  });

  it('drops a frame line with an unparseable location', () => {
    const error = new Error('m');
    error.stack = 'Error: m\n    at foo (native)';

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(error));

    expect(scrubbed?.exception?.values?.[0]?.stacktrace).toBeUndefined();
  });

  it('drops a degenerate empty frame line', () => {
    const error = new Error('m');
    error.stack = 'Error: m\n    at ';

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(error));

    expect(scrubbed?.exception?.values?.[0]?.stacktrace).toBeUndefined();
  });

  it('keeps frames for an empty-message error (header is the bare name)', () => {
    // Cleared post-construction: V8 derives the stack header lazily at first
    // access, so this exercises the bare-name header (no `: message` part).
    const error = new Error('placeholder');
    error.message = '';

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(error));

    expect(scrubbed?.exception?.values?.[0]?.stacktrace?.frames?.length).toBeGreaterThan(0);
  });
});

describe('scrubSentryEvent with a minimal event', () => {
  it('omits envelope fields the event does not carry', () => {
    const scrubbed = scrubSentryEvent({ type: undefined });

    expect(scrubbed).not.toHaveProperty('event_id');
    expect(scrubbed).not.toHaveProperty('timestamp');
    expect(scrubbed).not.toHaveProperty('platform');
    expect(scrubbed).not.toHaveProperty('level');
    expect(scrubbed).not.toHaveProperty('environment');
    expect(scrubbed).not.toHaveProperty('release');
    expect(scrubbed?.tags).toEqual({ errorCode: 'unknown' });
  });
});
