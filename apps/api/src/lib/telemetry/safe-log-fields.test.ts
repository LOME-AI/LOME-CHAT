import { describe, expect, it } from 'vitest';
import { SAFE_LOG_FIELD_KEYS, pickSafeLogFields } from './safe-log-fields.js';
import type { SafeLogFieldKey, SafeLogFields } from './safe-log-fields.js';

describe('SAFE_LOG_FIELD_KEYS', () => {
  it('contains no key matching the never-log name heuristic', () => {
    // The never-log doctrine's leak heuristic: user content is unrepresentable
    // because no allowlisted field name can even look like a content carrier.
    const sensitive = /message|prompt|content|body|text/i;
    for (const key of SAFE_LOG_FIELD_KEYS) {
      expect(key).not.toMatch(sensitive);
    }
  });

  it('matches the keys of the SafeLogFields type exactly', () => {
    // Compile-time bijection between the runtime allowlist and the type:
    // a key added to one but not the other fails typecheck here.
    const fromType: readonly (keyof SafeLogFields)[] = SAFE_LOG_FIELD_KEYS;
    const fromKeys: readonly SafeLogFieldKey[] = [] as (keyof SafeLogFields)[];
    expect(fromType.length).toBe(SAFE_LOG_FIELD_KEYS.length);
    expect(fromKeys).toEqual([]);
  });
});

describe('pickSafeLogFields', () => {
  it('keeps allowlisted primitive fields', () => {
    expect(pickSafeLogFields({ requestId: 'r-1', statusCode: 200 })).toEqual({
      requestId: 'r-1',
      statusCode: 200,
    });
  });

  it('drops keys outside the allowlist', () => {
    // A JS-boundary caller can defeat the compile-time allowlist with a cast;
    // the runtime pick is the port-side scrub (the typed logger plus
    // port scrubbing are the real mechanisms, lint is advisory).
    const smuggled = { requestId: 'r-1', password: 'hunter2' } as SafeLogFields;
    expect(pickSafeLogFields(smuggled)).toEqual({ requestId: 'r-1' });
  });

  it('drops non-primitive values even under allowlisted keys', () => {
    const smuggled = { requestId: { deep: 'plaintext' } } as unknown as SafeLogFields;
    expect(pickSafeLogFields(smuggled)).toEqual({});
  });

  it('drops undefined values', () => {
    // exactOptionalPropertyTypes forbids explicit undefined in literals, but
    // dynamically built field objects can still carry it at runtime.
    const dynamic = { requestId: undefined, route: '/chat' } as unknown as SafeLogFields;
    expect(pickSafeLogFields(dynamic)).toEqual({ route: '/chat' });
  });
});

describe('SafeLogFields compile-time allowlist', () => {
  it('rejects unknown keys on the type', () => {
    // @ts-expect-error -- 'password' is not an allowlisted log field; if the closed shape ever stops rejecting unknown keys, the unused directive fails typecheck
    const fields: SafeLogFields = { password: 'hunter2' };
    expect(fields).toBeDefined();
  });
});
