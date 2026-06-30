import { describe, expect, it } from 'vitest';
import { planEpochWraps } from './rotation.js';

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
