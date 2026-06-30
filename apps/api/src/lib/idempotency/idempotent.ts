import { byEventId } from './by-event-id.js';
import { byExternalPreClaim } from './by-external-pre-claim.js';
import { byKey } from './by-key.js';
import { byTransition } from './by-transition.js';
import { byUpsert } from './by-upsert.js';

/**
 * The five idempotency strategies — the sole producers of `Idempotent<T>`.
 * Every mutation in the system passes through exactly one of them; there is
 * no sixth.
 */
export const idempotent = {
  byKey,
  byUpsert,
  byTransition,
  byEventId,
  byExternalPreClaim,
} as const;
