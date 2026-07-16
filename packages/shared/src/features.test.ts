import { describe, expect, it } from 'vitest';

import { SHIPPED_FEATURES, COMING_SOON_FEATURES } from './features.js';

describe('SHIPPED_FEATURES', () => {
  it('exposes a non-empty catalog of shipped features', () => {
    expect(SHIPPED_FEATURES.length).toBeGreaterThan(0);
  });

  it('fully describes every shipped feature', () => {
    for (const feature of SHIPPED_FEATURES) {
      expect(feature.id.length).toBeGreaterThan(0);
      expect(feature.name.length).toBeGreaterThan(0);
      expect(feature.description.length).toBeGreaterThan(0);
      expect(feature.emoji.length).toBeGreaterThan(0);
      expect(feature.lucideIcon.length).toBeGreaterThan(0);
    }
  });
});

describe('COMING_SOON_FEATURES', () => {
  it('exposes a non-empty roadmap of planned features', () => {
    expect(COMING_SOON_FEATURES.length).toBeGreaterThan(0);
  });

  it('describes every planned feature with id, name, emoji, and icon', () => {
    for (const feature of COMING_SOON_FEATURES) {
      expect(feature.id.length).toBeGreaterThan(0);
      expect(feature.name.length).toBeGreaterThan(0);
      expect(feature.emoji.length).toBeGreaterThan(0);
      expect(feature.lucideIcon.length).toBeGreaterThan(0);
    }
  });
});

describe('feature identifiers', () => {
  it('are unique across shipped and planned features', () => {
    const ids = [
      ...SHIPPED_FEATURES.map((feature) => feature.id),
      ...COMING_SOON_FEATURES.map((feature) => feature.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
