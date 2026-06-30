import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@hushbox/shared';
import { isRefusal, refusalSchema, refusalToWire } from './outcomes.js';
import type { Refusal } from './outcomes.js';

describe('isRefusal', () => {
  it('identifies a refusal object', () => {
    expect(isRefusal({ refusal: 'not-found' })).toBe(true);
  });

  it('identifies a success payload as not a refusal', () => {
    expect(isRefusal({ conversation: { id: 'c1' } })).toBe(false);
  });
});

describe('refusalToWire', () => {
  const cases: [Refusal, string, number][] = [
    [{ refusal: 'not-found' }, ERROR_CODES.NOT_FOUND, 404],
    [{ refusal: 'forbidden' }, ERROR_CODES.FORBIDDEN, 403],
    [{ refusal: 'validation' }, ERROR_CODES.VALIDATION, 400],
    [{ refusal: 'conflict' }, ERROR_CODES.CONFLICT, 409],
    [{ refusal: 'stale-epoch', currentEpoch: 4 }, ERROR_CODES.STALE_EPOCH, 409],
    [{ refusal: 'wrap-set-mismatch' }, ERROR_CODES.WRAP_SET_MISMATCH, 400],
    [{ refusal: 'member-limit', limit: 100 }, ERROR_CODES.MEMBER_LIMIT_REACHED, 400],
    [{ refusal: 'already-member' }, ERROR_CODES.ALREADY_MEMBER, 409],
    [{ refusal: 'rotation-required' }, ERROR_CODES.ROTATION_REQUIRED, 400],
    [{ refusal: 'cannot-remove-owner' }, ERROR_CODES.CANNOT_REMOVE_OWNER, 403],
    [{ refusal: 'cannot-remove-self' }, ERROR_CODES.CANNOT_REMOVE_SELF, 400],
    [{ refusal: 'fork-limit', limit: 5 }, ERROR_CODES.FORK_LIMIT_REACHED, 400],
    [{ refusal: 'fork-name-taken' }, ERROR_CODES.FORK_NAME_TAKEN, 409],
    [
      { refusal: 'fork-tip-conflict', currentTipMessageId: 'm1' },
      ERROR_CODES.FORK_TIP_CONFLICT,
      409,
    ],
  ];

  it.each(cases)('maps %o to its wire code and status', (refusal, code, status) => {
    const wire = refusalToWire(refusal);
    expect(wire.code).toBe(code);
    expect(wire.status).toBe(status);
  });

  it('carries the authoritative epoch on a stale-epoch refusal', () => {
    expect(refusalToWire({ refusal: 'stale-epoch', currentEpoch: 4 }).details).toEqual({
      currentEpoch: 4,
    });
  });

  it('carries the limit on a member-limit refusal', () => {
    expect(refusalToWire({ refusal: 'member-limit', limit: 100 }).details).toEqual({ limit: 100 });
  });

  it('carries the limit on a fork-limit refusal', () => {
    expect(refusalToWire({ refusal: 'fork-limit', limit: 5 }).details).toEqual({ limit: 5 });
  });

  it('carries the current tip on a fork-tip-conflict refusal', () => {
    expect(
      refusalToWire({ refusal: 'fork-tip-conflict', currentTipMessageId: null }).details
    ).toEqual({ currentTipMessageId: null });
  });

  it('attaches no details to a plain refusal', () => {
    expect(refusalToWire({ refusal: 'not-found' }).details).toBeUndefined();
  });
});

describe('refusalSchema', () => {
  it('round-trips every refusal variant (byKey replay validation)', () => {
    const variants: Refusal[] = [
      { refusal: 'not-found' },
      { refusal: 'stale-epoch', currentEpoch: 2 },
      { refusal: 'fork-tip-conflict', currentTipMessageId: null },
    ];
    for (const variant of variants) {
      expect(refusalSchema.parse(variant)).toEqual(variant);
    }
  });

  it('rejects an unknown refusal tag', () => {
    expect(refusalSchema.safeParse({ refusal: 'nope' }).success).toBe(false);
  });
});
