import { describe, it, expect } from 'vitest';

import {
  audioStrategy,
  getStrategy,
  imageStrategy,
  textStrategy,
  videoStrategy,
} from './modality-strategies.js';
import type { Modality } from '../services/ai/index.js';

describe('getStrategy', () => {
  it('returns the textStrategy for modality "text"', () => {
    expect(getStrategy('text')).toBe(textStrategy);
  });

  it('returns the imageStrategy for modality "image"', () => {
    expect(getStrategy('image')).toBe(imageStrategy);
  });

  it('returns the videoStrategy for modality "video"', () => {
    expect(getStrategy('video')).toBe(videoStrategy);
  });

  it('returns the audioStrategy for modality "audio"', () => {
    expect(getStrategy('audio')).toBe(audioStrategy);
  });

  it('throws for an invalid modality (assertNever exhaustiveness check)', () => {
    // Force-cast an invalid value through the type system to exercise the
    // exhaustiveness guard. This protects against a future caller losing
    // strict typing and silently picking a `null` strategy at runtime.
    const invalid = 'unknown' as unknown as Modality;
    expect(() => getStrategy(invalid)).toThrow();
  });
});
