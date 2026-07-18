import { describe, expect, it } from 'vitest';

import { adSpecSchema } from '../tools/remotion/index.js';
import { hqTour } from './spec.js';

describe('hq-tour spec', () => {
  it('is a valid AdSpec', () => {
    expect(() => adSpecSchema.parse(hqTour)).not.toThrow();
  });

  it('keeps every scene and overlay within the composition duration', () => {
    const spec = adSpecSchema.parse(hqTour);
    const placed = [...spec.scenes, ...spec.overlays];
    for (const item of placed) {
      expect(item.from + item.durationInFrames).toBeLessThanOrEqual(spec.durationInFrames);
    }
  });
});
