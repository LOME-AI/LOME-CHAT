import { z } from 'zod';
import { match } from 'ts-pattern';
import { ERROR_CODES } from '@hushbox/shared';
import type { ErrorCode } from '@hushbox/shared';

/**
 * Expected domain refusals ride the SUCCESS channel of every operation (the
 * `RunStartOutcome` precedent): `byKey` stores them as the replayable
 * response, so a retried key replays the same refusal instead of
 * re-executing. The `Result` error channel stays reserved for infrastructure
 * failures. Discrimination is structural — success payloads never carry a
 * `refusal` key.
 */
export const refusalSchema = z.discriminatedUnion('refusal', [
  z.object({ refusal: z.literal('not-found') }),
  z.object({ refusal: z.literal('forbidden') }),
  z.object({ refusal: z.literal('validation') }),
  z.object({ refusal: z.literal('conflict') }),
  z.object({ refusal: z.literal('stale-epoch'), currentEpoch: z.number().int() }),
  z.object({ refusal: z.literal('wrap-set-mismatch') }),
  z.object({ refusal: z.literal('member-limit'), limit: z.number().int() }),
  z.object({ refusal: z.literal('already-member') }),
  z.object({ refusal: z.literal('rotation-required') }),
  z.object({ refusal: z.literal('cannot-remove-owner') }),
  z.object({ refusal: z.literal('cannot-remove-self') }),
  z.object({ refusal: z.literal('cannot-change-own-privilege') }),
  z.object({ refusal: z.literal('privilege-insufficient') }),
  z.object({ refusal: z.literal('fork-limit'), limit: z.number().int() }),
  z.object({ refusal: z.literal('fork-name-taken') }),
  z.object({ refusal: z.literal('fork-tip-conflict'), currentTipMessageId: z.string().nullable() }),
]);

export type Refusal = z.infer<typeof refusalSchema>;

/** An operation outcome: the success payload or a typed refusal. */
export type Outcome<S> = S | Refusal;

export function isRefusal(outcome: object): outcome is Refusal {
  return 'refusal' in outcome;
}

export interface WireRefusal {
  readonly code: ErrorCode;
  readonly status: 400 | 403 | 404 | 409;
  readonly details?: Record<string, unknown>;
}

/** The one refusal→wire mapping; ts-pattern keeps it closed over the union. */
export function refusalToWire(refusal: Refusal): WireRefusal {
  return match(refusal)
    .with(
      { refusal: 'not-found' },
      (): WireRefusal => ({ code: ERROR_CODES.NOT_FOUND, status: 404 })
    )
    .with(
      { refusal: 'forbidden' },
      (): WireRefusal => ({ code: ERROR_CODES.FORBIDDEN, status: 403 })
    )
    .with(
      { refusal: 'validation' },
      (): WireRefusal => ({ code: ERROR_CODES.VALIDATION, status: 400 })
    )
    .with({ refusal: 'conflict' }, (): WireRefusal => ({ code: ERROR_CODES.CONFLICT, status: 409 }))
    .with(
      { refusal: 'stale-epoch' },
      (r): WireRefusal => ({
        code: ERROR_CODES.STALE_EPOCH,
        status: 409,
        details: { currentEpoch: r.currentEpoch },
      })
    )
    .with(
      { refusal: 'wrap-set-mismatch' },
      (): WireRefusal => ({ code: ERROR_CODES.WRAP_SET_MISMATCH, status: 400 })
    )
    .with(
      { refusal: 'member-limit' },
      (r): WireRefusal => ({
        code: ERROR_CODES.MEMBER_LIMIT_REACHED,
        status: 400,
        details: { limit: r.limit },
      })
    )
    .with(
      { refusal: 'already-member' },
      (): WireRefusal => ({ code: ERROR_CODES.ALREADY_MEMBER, status: 409 })
    )
    .with(
      { refusal: 'rotation-required' },
      (): WireRefusal => ({ code: ERROR_CODES.ROTATION_REQUIRED, status: 400 })
    )
    .with(
      { refusal: 'cannot-remove-owner' },
      (): WireRefusal => ({ code: ERROR_CODES.CANNOT_REMOVE_OWNER, status: 403 })
    )
    .with(
      { refusal: 'cannot-remove-self' },
      (): WireRefusal => ({ code: ERROR_CODES.CANNOT_REMOVE_SELF, status: 400 })
    )
    .with(
      { refusal: 'cannot-change-own-privilege' },
      (): WireRefusal => ({ code: ERROR_CODES.CANNOT_CHANGE_OWN_PRIVILEGE, status: 403 })
    )
    .with(
      { refusal: 'privilege-insufficient' },
      (): WireRefusal => ({ code: ERROR_CODES.PRIVILEGE_INSUFFICIENT, status: 403 })
    )
    .with(
      { refusal: 'fork-limit' },
      (r): WireRefusal => ({
        code: ERROR_CODES.FORK_LIMIT_REACHED,
        status: 400,
        details: { limit: r.limit },
      })
    )
    .with(
      { refusal: 'fork-name-taken' },
      (): WireRefusal => ({ code: ERROR_CODES.FORK_NAME_TAKEN, status: 409 })
    )
    .with(
      { refusal: 'fork-tip-conflict' },
      (r): WireRefusal => ({
        code: ERROR_CODES.FORK_TIP_CONFLICT,
        status: 409,
        details: { currentTipMessageId: r.currentTipMessageId },
      })
    )
    .exhaustive();
}
