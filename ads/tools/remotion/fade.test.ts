import { describe, expect, it } from 'vitest';

import { crossFadeOpacity, fadeInOpacity, popInScale } from './fade.js';

describe('crossFadeOpacity', () => {
  it('starts transparent', () => {
    expect(crossFadeOpacity(0, 90)).toBe(0);
  });

  it('reaches full opacity after the fade-in', () => {
    expect(crossFadeOpacity(6, 90)).toBe(1);
  });

  it('holds full opacity through the middle', () => {
    expect(crossFadeOpacity(45, 90)).toBe(1);
  });

  it('returns to transparent at the end', () => {
    expect(crossFadeOpacity(90, 90)).toBe(0);
  });

  it('clamps before the start and after the end', () => {
    expect(crossFadeOpacity(-5, 90)).toBe(0);
    expect(crossFadeOpacity(120, 90)).toBe(0);
  });

  it('honours a custom fade length', () => {
    expect(crossFadeOpacity(3, 90, 3)).toBe(1);
  });
});

describe('fadeInOpacity', () => {
  it('fades from transparent to opaque then holds', () => {
    expect(fadeInOpacity(0)).toBe(0);
    expect(fadeInOpacity(6)).toBe(1);
    expect(fadeInOpacity(30)).toBe(1);
  });

  it('clamps before the start', () => {
    expect(fadeInOpacity(-5)).toBe(0);
  });
});

describe('popInScale', () => {
  it('starts slightly scaled down', () => {
    expect(popInScale(0)).toBe(0.96);
  });

  it('reaches full scale after the pop', () => {
    expect(popInScale(6)).toBe(1);
  });

  it('holds full scale and clamps at both ends', () => {
    expect(popInScale(30)).toBe(1);
    expect(popInScale(-5)).toBe(0.96);
  });

  it('honours a custom pop length', () => {
    expect(popInScale(3, 3)).toBe(1);
  });
});
