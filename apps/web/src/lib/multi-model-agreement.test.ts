import { describe, it, expect } from 'vitest';
import { agreedOptions, snapToNearest } from './multi-model-agreement';

interface TestModel {
  id: string;
  durations?: readonly number[];
  resolutions?: readonly string[];
}

describe('agreedOptions', () => {
  it('returns empty when no models are selected', () => {
    const result = agreedOptions([], [], (m: TestModel) => m.durations);
    expect(result).toEqual([]);
  });

  it('returns empty when catalog is undefined', () => {
    const result = agreedOptions([{ id: 'a' }], undefined, (m: TestModel) => m.durations);
    expect(result).toEqual([]);
  });

  it('returns the lone model option set when one model is selected', () => {
    const catalog: TestModel[] = [{ id: 'a', durations: [4, 6, 8] }];
    const result = agreedOptions([{ id: 'a' }], catalog, (m) => m.durations);
    expect(result).toEqual([4, 6, 8]);
  });

  it('intersects supported sets across multiple selected models', () => {
    const catalog: TestModel[] = [
      { id: 'a', durations: [4, 6, 8] },
      { id: 'b', durations: [5, 6, 7, 8] },
    ];
    const result = agreedOptions([{ id: 'a' }, { id: 'b' }], catalog, (m) => m.durations);
    expect(result).toEqual([6, 8]);
  });

  it('returns empty when no overlap', () => {
    const catalog: TestModel[] = [
      { id: 'a', durations: [4] },
      { id: 'b', durations: [5] },
    ];
    const result = agreedOptions([{ id: 'a' }, { id: 'b' }], catalog, (m) => m.durations);
    expect(result).toEqual([]);
  });

  it('preserves the first model order in the intersection', () => {
    const catalog: TestModel[] = [
      { id: 'a', resolutions: ['720p', '1080p', '4k'] },
      { id: 'b', resolutions: ['4k', '1080p', '720p'] },
    ];
    const result = agreedOptions([{ id: 'a' }, { id: 'b' }], catalog, (m) => m.resolutions);
    expect(result).toEqual(['720p', '1080p', '4k']);
  });

  it('skips models with an undefined attribute (no support data) and intersects the rest', () => {
    const catalog: TestModel[] = [
      { id: 'a', durations: [4, 6, 8] },
      { id: 'b' },
      { id: 'c', durations: [6, 8, 10] },
    ];
    const result = agreedOptions(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      catalog,
      (m) => m.durations
    );
    expect(result).toEqual([6, 8]);
  });

  it('returns empty when every selected model is in the catalog but advertises no support data', () => {
    // All models exist but `pluck` returns undefined for each, so every model
    // is skipped and no supported set is collected.
    const catalog: TestModel[] = [{ id: 'a' }, { id: 'b' }];
    const result = agreedOptions([{ id: 'a' }, { id: 'b' }], catalog, (m) => m.durations);
    expect(result).toEqual([]);
  });

  it('returns empty when none of the selected models are in the catalog', () => {
    const result = agreedOptions(
      [{ id: 'missing' }],
      [{ id: 'a', durations: [4] }],
      (m: TestModel) => m.durations
    );
    expect(result).toEqual([]);
  });
});

describe('snapToNearest', () => {
  it('returns the value when it matches an allowed entry exactly', () => {
    expect(snapToNearest([4, 6, 8], 6)).toBe(6);
  });

  it('snaps to the nearest entry when between two values', () => {
    // 5.6 → distance to 4 is 1.6, distance to 6 is 0.4 → nearer to 6.
    expect(snapToNearest([4, 6, 8], 5.6)).toBe(6);
    // 7.1 → distance to 6 is 1.1, distance to 8 is 0.9 → nearer to 8.
    expect(snapToNearest([4, 6, 8], 7.1)).toBe(8);
  });

  it('snaps closer to the lower value when distances differ', () => {
    expect(snapToNearest([4, 6, 8], 4.3)).toBe(4);
  });

  it('snaps to the lower value on exact ties (floor)', () => {
    // Halfway between 4 and 6 → floor.
    expect(snapToNearest([4, 6, 8], 5)).toBe(4);
    // Halfway between 6 and 8 → floor.
    expect(snapToNearest([4, 6, 8], 7)).toBe(6);
  });

  it('clamps below the minimum to the minimum', () => {
    expect(snapToNearest([4, 6, 8], 2)).toBe(4);
  });

  it('clamps above the maximum to the maximum', () => {
    expect(snapToNearest([4, 6, 8], 100)).toBe(8);
  });

  it('returns undefined when the allowed list is empty', () => {
    expect(snapToNearest([], 5)).toBeUndefined();
  });

  it('returns the only entry when the list has one element', () => {
    expect(snapToNearest([8], 3)).toBe(8);
    expect(snapToNearest([8], 12)).toBe(8);
  });
});
