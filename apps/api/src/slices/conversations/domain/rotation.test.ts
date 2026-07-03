import { describe, expect, it } from 'vitest';
import { toBase64 } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import { applyRotation, planEpochWraps } from './rotation.js';
import { fakeStores } from './test-fixtures.js';
import type { RotationBody } from './schemas.js';

describe('planEpochWraps', () => {
  const visibility = new Map([
    ['keyA', 1],
    ['keyB', 3],
  ]);

  it('plans one wrap row per active member with the server-enforced visibility', () => {
    const plan = planEpochWraps(visibility, [
      { memberPublicKey: 'keyA', wrap: 'wrapA' },
      { memberPublicKey: 'keyB', wrap: 'wrapB' },
    ]);
    expect(plan).toEqual([
      { memberPublicKey: 'keyA', wrap: 'wrapA', visibleFromEpoch: 1 },
      { memberPublicKey: 'keyB', wrap: 'wrapB', visibleFromEpoch: 3 },
    ]);
  });

  it('rejects a wrap set missing an active member', () => {
    expect(planEpochWraps(visibility, [{ memberPublicKey: 'keyA', wrap: 'wrapA' }])).toBeNull();
  });

  it('rejects a wrap set naming a non-member key', () => {
    expect(
      planEpochWraps(visibility, [
        { memberPublicKey: 'keyA', wrap: 'wrapA' },
        { memberPublicKey: 'keyX', wrap: 'wrapX' },
      ])
    ).toBeNull();
  });

  it('rejects duplicate wraps for one member key', () => {
    expect(
      planEpochWraps(visibility, [
        { memberPublicKey: 'keyA', wrap: 'wrapA' },
        { memberPublicKey: 'keyA', wrap: 'wrapA2' },
        { memberPublicKey: 'keyB', wrap: 'wrapB' },
      ])
    ).toBeNull();
  });

  it('rejects a duplicate that masks a missing member at equal counts', () => {
    expect(
      planEpochWraps(visibility, [
        { memberPublicKey: 'keyA', wrap: 'wrapA' },
        { memberPublicKey: 'keyA', wrap: 'wrapA2' },
      ])
    ).toBeNull();
  });
});

/**
 * Both defect arms assert invariants the conversation lock already
 * guarantees, so they are stageable only with fakes.
 */
describe('applyRotation defect arms', () => {
  const B64 = toBase64(new Uint8Array([1, 2, 3]));
  const rotation: RotationBody = {
    expectedEpoch: 1,
    epochPublicKey: B64,
    confirmationHash: B64,
    chainLink: B64,
    memberWraps: [{ memberPublicKey: B64, wrap: B64 }],
    encryptedTitle: B64,
  };

  it('treats a lost rotation claim under the conversation lock as a defect', async () => {
    const stores = fakeStores({ conversations: { claimRotation: () => okAsync(false) } });
    await expect(
      applyRotation(stores, { conversationId: 'c1', rotation, plan: [] })
    ).rejects.toThrow(/rotation claim lost/);
  });

  it('treats a missing current epoch row as a defect', async () => {
    const stores = fakeStores({
      conversations: { claimRotation: () => okAsync(true) },
      epochs: { byNumber: () => okAsync(null) },
    });
    await expect(
      applyRotation(stores, { conversationId: 'c1', rotation, plan: [] })
    ).rejects.toThrow(/current epoch row missing/);
  });
});
