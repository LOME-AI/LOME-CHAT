import { describe, expect, it } from 'vitest';

import { expandRect, regionBounds, smoothTrack, type RgbaImage } from './screen-track.js';

type Color = [number, number, number];
interface Fill {
  rect: [number, number, number, number];
  color: Color;
}

function colorAt(x: number, y: number, bg: Color, fills: Fill[]): Color {
  let color = bg;
  for (const f of fills) {
    const [fx, fy, fw, fh] = f.rect;
    if (x >= fx && x < fx + fw && y >= fy && y < fy + fh) color = f.color;
  }
  return color;
}

/** Builds an RGBA image: background color with optional filled rect regions. */
function image(width: number, height: number, bg: Color, fills: Fill[] = []): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const [r, g, b] = colorAt(x, y, bg, fills);
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = 255;
    }
  }
  return { data, width, height, channels: 4 };
}

describe('regionBounds', () => {
  it('bounds the connected region the seed sits in', () => {
    const img = image(10, 10, [10, 10, 10], [{ rect: [3, 2, 4, 5], color: [40, 220, 40] }]);
    expect(regionBounds(img, { x: 4, y: 4 }, 20)).toEqual({ x: 3, y: 2, width: 3, height: 4 });
  });

  it('includes near-but-not-exact colors within tolerance', () => {
    const img = image(
      6,
      6,
      [0, 0, 0],
      [
        { rect: [1, 1, 4, 4], color: [40, 200, 40] },
        { rect: [2, 2, 1, 1], color: [40, 210, 40] },
      ]
    );
    expect(regionBounds(img, { x: 1, y: 1 }, 15)).toEqual({ x: 1, y: 1, width: 3, height: 3 });
  });

  it('excludes a same-color region the seed is not connected to', () => {
    const img = image(
      10,
      4,
      [0, 0, 0],
      [
        { rect: [1, 1, 2, 2], color: [40, 220, 40] },
        { rect: [7, 1, 2, 2], color: [40, 220, 40] },
      ]
    );
    expect(regionBounds(img, { x: 1, y: 1 }, 20)).toEqual({ x: 1, y: 1, width: 1, height: 1 });
  });

  it('bounds a region flush against the image edge', () => {
    const img = image(5, 5, [0, 0, 0], [{ rect: [0, 0, 3, 3], color: [40, 220, 40] }]);
    expect(regionBounds(img, { x: 0, y: 0 }, 20)).toEqual({ x: 0, y: 0, width: 2, height: 2 });
  });

  it('returns a zero-size rect for a lone seed pixel', () => {
    const img = image(5, 5, [0, 0, 0], [{ rect: [2, 2, 1, 1], color: [40, 220, 40] }]);
    expect(regionBounds(img, { x: 2, y: 2 }, 10)).toEqual({ x: 2, y: 2, width: 0, height: 0 });
  });
});

describe('smoothTrack', () => {
  it('returns the input unchanged with a zero window', () => {
    const track = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 4, y: 4, width: 12, height: 12 },
    ];
    expect(smoothTrack(track, 0)).toEqual(track);
  });

  it('averages a spike against its neighbours', () => {
    const track = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 30, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: 10, height: 10 },
    ];
    expect(smoothTrack(track, 1)[1]?.x).toBeCloseTo(10, 5);
  });
});

describe('expandRect', () => {
  it('bleeds past every edge by the overshoot fraction', () => {
    expect(expandRect({ x: 100, y: 200, width: 50, height: 80 }, 0.1)).toEqual({
      x: 95,
      y: 192,
      width: 60,
      height: 96,
    });
  });
});
