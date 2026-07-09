import { describe, expect, it } from 'vitest';
import { toBase64 } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import { getMemberKeys } from './member-keys.js';
import { fakeStores, memberRecord } from './test-fixtures.js';

const USER_KEY = new Uint8Array(32).fill(3);
const LINK_KEY = new Uint8Array(32).fill(4);

describe('getMemberKeys', () => {
  it('hides the key set from a non-member', async () => {
    const stores = fakeStores({ members: { activeByUser: () => okAsync(null) } });
    const result = await getMemberKeys(stores, { conversationId: 'c1', callerUserId: 'x' });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('serializes user and link members with base64 public keys', async () => {
    const stores = fakeStores({
      members: {
        activeByUser: () => okAsync(memberRecord()),
        activeKeysOrdered: () =>
          okAsync([
            {
              memberId: 'm1',
              userId: 'u1',
              linkId: null,
              publicKey: USER_KEY,
              privilege: 'owner' as const,
              visibleFromEpoch: 1,
            },
            {
              memberId: 'm2',
              userId: null,
              linkId: 'l1',
              publicKey: LINK_KEY,
              privilege: 'read' as const,
              visibleFromEpoch: 2,
            },
          ]),
      },
    });
    const result = await getMemberKeys(stores, { conversationId: 'c1', callerUserId: 'u1' });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    expect(view.members).toEqual([
      {
        memberId: 'm1',
        userId: 'u1',
        linkId: null,
        publicKey: toBase64(USER_KEY),
        privilege: 'owner',
        visibleFromEpoch: 1,
      },
      {
        memberId: 'm2',
        userId: null,
        linkId: 'l1',
        publicKey: toBase64(LINK_KEY),
        privilege: 'read',
        visibleFromEpoch: 2,
      },
    ]);
  });
});
