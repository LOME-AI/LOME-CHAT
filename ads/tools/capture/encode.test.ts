import { describe, expect, it } from 'vitest';

import { buildConcatList, escapeConcatPath } from './encode.js';

describe('escapeConcatPath', () => {
  it('leaves a quote-free path unchanged', () => {
    expect(escapeConcatPath('/frames/f000001.jpg')).toBe('/frames/f000001.jpg');
  });

  it('escapes single quotes for the concat demuxer', () => {
    expect(escapeConcatPath("/a'b/c.jpg")).toBe(String.raw`/a'\''b/c.jpg`);
  });
});

describe('buildConcatList', () => {
  it('returns an empty string for no frames', () => {
    expect(buildConcatList([], 500)).toBe('');
  });

  it('stretches a single frame back to t=0 and repeats it as the tail', () => {
    expect(buildConcatList([{ tMs: 100, file: 'a.jpg' }], 500)).toBe(
      "file 'a.jpg'\nduration 0.6000\nfile 'a.jpg'"
    );
  });

  it('uses the next frame time as each frame duration and holds the last', () => {
    const list = buildConcatList(
      [
        { tMs: 0, file: 'f0.jpg' },
        { tMs: 100, file: 'f1.jpg' },
      ],
      500
    );
    expect(list).toBe(
      "file 'f0.jpg'\nduration 0.1000\nfile 'f1.jpg'\nduration 0.5000\nfile 'f1.jpg'"
    );
  });

  it('floors a zero-length gap between identical timestamps at one millisecond', () => {
    const list = buildConcatList(
      [
        { tMs: 0, file: 'f0.jpg' },
        { tMs: 100, file: 'f1.jpg' },
        { tMs: 100, file: 'f2.jpg' },
      ],
      500
    );
    expect(list).toContain('duration 0.0010');
  });
});
