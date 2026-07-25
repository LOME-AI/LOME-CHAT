import { describe, expect, it } from 'vitest';
import { createPushMembershipReader } from './push-membership-reader.js';
import type { Database } from '@hushbox/db';

/** A minimal drizzle read chain returning the supplied member rows. */
function fakeMemberDb(
  rows: readonly { readonly userId: string | null; readonly muted: boolean }[]
): Database {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
  } as unknown as Database;
}

describe('createPushMembershipReader', () => {
  it('returns active user members with their mute flag', async () => {
    const reader = createPushMembershipReader(
      fakeMemberDb([
        { userId: 'u1', muted: false },
        { userId: 'u2', muted: true },
      ])
    );
    const result = await reader.listActiveUserMembers('c1');
    expect(result._unsafeUnwrap()).toEqual([
      { userId: 'u1', muted: false },
      { userId: 'u2', muted: true },
    ]);
  });

  it('drops a defensive null-userId row', async () => {
    const reader = createPushMembershipReader(
      fakeMemberDb([
        { userId: null, muted: false },
        { userId: 'u2', muted: true },
      ])
    );
    const result = await reader.listActiveUserMembers('c1');
    expect(result._unsafeUnwrap()).toEqual([{ userId: 'u2', muted: true }]);
  });

  it('maps a read failure to an unavailable error', async () => {
    const failing = {
      select: () => ({ from: () => ({ where: () => Promise.reject(new Error('down')) }) }),
    } as unknown as Database;
    const result = await createPushMembershipReader(failing).listActiveUserMembers('c1');
    expect(result.isErr()).toBe(true);
  });
});
