import { z } from 'zod';
import { accessibilityPreferencesSchema, reconcileAccessibilityPreferences } from '@hushbox/shared';
import { conflictError } from '../../../lib/errors/index.js';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import type { AccessibilityPreferences } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { PreferencesStore, StoredAccessibility } from '../ports/index.js';

export const putAccessibilityPreferencesBodySchema = z.object({
  preferences: accessibilityPreferencesSchema,
  updatedAt: z.iso.datetime(),
});

export interface AccessibilityState {
  readonly preferences: AccessibilityPreferences;
  /** ISO timestamp of the stored row; null when the user has never synced. */
  readonly updatedAt: string | null;
}

export interface AccessibilityWriteOutcome {
  /** False when the LWW guard rejected a stale write. */
  readonly accepted: boolean;
  readonly preferences: AccessibilityPreferences;
  readonly updatedAt: string;
}

function toState(stored: StoredAccessibility): {
  preferences: AccessibilityPreferences;
  updatedAt: string;
} {
  return {
    preferences: reconcileAccessibilityPreferences(stored.accessibility),
    updatedAt: stored.updatedAt.toISOString(),
  };
}

export function getAccessibilityPreferences(
  store: PreferencesStore,
  userId: string
): ResultAsync<AccessibilityState, DomainError> {
  return store
    .read(userId)
    .map((stored) =>
      stored === null
        ? { preferences: reconcileAccessibilityPreferences(), updatedAt: null }
        : toState(stored)
    );
}

/**
 * LWW write. The tie-break is deterministic and matches the store guard
 * (`stored.updatedAt <= incoming`): an EQUAL timestamp wins, so a replay of
 * the same write converges to the same end state. A stale write loses and the
 * response carries the authoritative stored state for the client to adopt.
 */
export function saveAccessibilityPreferences(
  store: PreferencesStore,
  userId: string,
  body: { readonly preferences: AccessibilityPreferences; readonly updatedAt: string }
): ResultAsync<AccessibilityWriteOutcome, DomainError> {
  const incoming = new Date(body.updatedAt);
  return store.upsertIfNewer(userId, body.preferences, incoming).andThen((applied) => {
    if (applied !== null) {
      return okAsync<AccessibilityWriteOutcome, DomainError>({
        accepted: true,
        ...toState(applied),
      });
    }
    return store.read(userId).andThen((stored) =>
      stored === null
        ? // The guard rejected the write because a newer row existed, yet the
          // read-back found none — only a concurrent hard-delete does this.
          errAsync<AccessibilityWriteOutcome, DomainError>(
            conflictError('preferences changed concurrently')
          )
        : okAsync<AccessibilityWriteOutcome, DomainError>({ accepted: false, ...toState(stored) })
    );
  });
}
