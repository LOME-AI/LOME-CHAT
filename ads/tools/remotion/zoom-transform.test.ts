import { describe, expect, it } from 'vitest';

import { zoomTransform } from './zoom-transform.js';

const SIZE = { width: 1000, height: 2000 };

describe('zoomTransform', () => {
  it('holds the full frame when there are no targets', () => {
    expect(zoomTransform([], 10, 30, SIZE)).toEqual({ tx: 0, ty: 0, zoom: 1 });
  });

  it('holds the full frame before the first target begins', () => {
    const targets = [{ frame: 100, x: 0, y: 0, zoom: 2 }];
    expect(zoomTransform(targets, 50, 30, SIZE)).toEqual({ tx: 0, ty: 0, zoom: 1 });
  });

  it('eases toward a target once its frame is reached', () => {
    const targets = [{ frame: 0, x: 100, y: 200, zoom: 2 }];
    const state = zoomTransform(targets, 30, 30, SIZE);
    expect(state.zoom).toBeGreaterThan(1);
    expect(state.zoom).toBeLessThanOrEqual(2);
  });
});
