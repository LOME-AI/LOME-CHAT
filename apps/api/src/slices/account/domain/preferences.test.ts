import { describe, expect, it } from 'vitest';
import { ACCESSIBILITY_PREFERENCES_DEFAULTS } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import {
  getAccessibilityPreferences,
  putAccessibilityPreferencesBodySchema,
  saveAccessibilityPreferences,
} from './preferences.js';
import type { AccessibilityPreferences } from '@hushbox/shared';
import type { PreferencesStore, StoredAccessibility } from '../ports/index.js';

const USER_ID = '0197a000-0000-7000-8000-000000000004';
const T1 = new Date('2026-06-01T00:00:00.000Z');
const T2 = new Date('2026-06-02T00:00:00.000Z');

const HIGH_CONTRAST: AccessibilityPreferences = {
  ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
  contrast: 'high',
};

function storeWith(overrides: Partial<PreferencesStore>): PreferencesStore {
  return {
    read: () => okAsync(null),
    upsertIfNewer: () => okAsync(null),
    ...overrides,
  };
}

describe('getAccessibilityPreferences', () => {
  it('returns the reconciled stored blob with its timestamp', async () => {
    const stored: StoredAccessibility = {
      accessibility: { version: 1, contrast: 'high' },
      updatedAt: T1,
    };
    const result = await getAccessibilityPreferences(
      storeWith({ read: () => okAsync(stored) }),
      USER_ID
    );
    expect(result._unsafeUnwrap()).toEqual({
      preferences: HIGH_CONTRAST,
      updatedAt: T1.toISOString(),
    });
  });

  it('returns the defaults with a null timestamp when nothing is stored', async () => {
    const result = await getAccessibilityPreferences(storeWith({}), USER_ID);
    expect(result._unsafeUnwrap()).toEqual({
      preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
      updatedAt: null,
    });
  });
});

describe('saveAccessibilityPreferences', () => {
  it('reports the applied state when the write wins', async () => {
    const applied: StoredAccessibility = { accessibility: HIGH_CONTRAST, updatedAt: T2 };
    const store = storeWith({ upsertIfNewer: () => okAsync(applied) });
    const result = await saveAccessibilityPreferences(store, USER_ID, {
      preferences: HIGH_CONTRAST,
      updatedAt: T2.toISOString(),
    });
    expect(result._unsafeUnwrap()).toEqual({
      accepted: true,
      preferences: HIGH_CONTRAST,
      updatedAt: T2.toISOString(),
    });
  });

  it('returns the authoritative stored state when the write is stale', async () => {
    const stored: StoredAccessibility = { accessibility: HIGH_CONTRAST, updatedAt: T2 };
    const store = storeWith({ read: () => okAsync(stored) });
    const result = await saveAccessibilityPreferences(store, USER_ID, {
      preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
      updatedAt: T1.toISOString(),
    });
    expect(result._unsafeUnwrap()).toEqual({
      accepted: false,
      preferences: HIGH_CONTRAST,
      updatedAt: T2.toISOString(),
    });
  });

  it('reports a conflict when the rejected row vanished before the read-back', async () => {
    const result = await saveAccessibilityPreferences(storeWith({}), USER_ID, {
      preferences: HIGH_CONTRAST,
      updatedAt: T1.toISOString(),
    });
    expect(result._unsafeUnwrapErr().code).toBe('conflict');
  });

  it('passes the parsed timestamp to the LWW guard', async () => {
    const seen: Date[] = [];
    const store = storeWith({
      upsertIfNewer: (_userId, _accessibility, updatedAt) => {
        seen.push(updatedAt);
        return okAsync({ accessibility: HIGH_CONTRAST, updatedAt });
      },
    });
    const result = await saveAccessibilityPreferences(store, USER_ID, {
      preferences: HIGH_CONTRAST,
      updatedAt: T1.toISOString(),
    });
    expect(result.isOk()).toBe(true);
    expect(seen).toEqual([T1]);
  });
});

describe('putAccessibilityPreferencesBodySchema', () => {
  it('fills missing preference fields with schema defaults', () => {
    const parsed = putAccessibilityPreferencesBodySchema.parse({
      preferences: { version: 1 },
      updatedAt: T1.toISOString(),
    });
    expect(parsed.preferences).toEqual(ACCESSIBILITY_PREFERENCES_DEFAULTS);
  });

  it('rejects a non-ISO updatedAt', () => {
    const parsed = putAccessibilityPreferencesBodySchema.safeParse({
      preferences: { version: 1 },
      updatedAt: 'yesterday',
    });
    expect(parsed.success).toBe(false);
  });
});
