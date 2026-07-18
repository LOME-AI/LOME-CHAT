import { describe, expect, it } from 'vitest';

import { adSpecSchema, type AdSpecInput } from './ad-spec.js';

function baseSpec(overrides: Partial<AdSpecInput> = {}): AdSpecInput {
  return {
    id: 'hq-tour',
    width: 1080,
    height: 1920,
    fps: 30,
    durationInFrames: 900,
    scenes: [{ type: 'video', id: 's1', from: 0, durationInFrames: 90, src: 's1.mp4' }],
    ...overrides,
  };
}

describe('adSpecSchema', () => {
  it('applies defaults for a minimal video scene', () => {
    const spec = adSpecSchema.parse(baseSpec());
    expect(spec.scenes[0]).toMatchObject({ trimStartFrames: 0, muted: false });
    expect(spec.overlays).toEqual([]);
    expect(spec.voiceovers).toEqual([]);
  });

  it('accepts a receipt scene with lines', () => {
    const spec = adSpecSchema.parse(
      baseSpec({
        scenes: [
          { type: 'receipt', id: 's6', from: 780, durationInFrames: 120, lines: ['a', 'b'] },
        ],
      })
    );
    expect(spec.scenes[0]).toMatchObject({ type: 'receipt', lines: ['a', 'b'] });
  });

  it('rejects a spec with no scenes', () => {
    expect(() => adSpecSchema.parse(baseSpec({ scenes: [] }))).toThrow();
  });

  it('rejects an unknown scene type', () => {
    const bad = baseSpec({
      scenes: [{ type: 'nope', id: 'x', from: 0, durationInFrames: 1 }],
    } as unknown as Partial<AdSpecInput>);
    expect(() => adSpecSchema.parse(bad)).toThrow();
  });

  it('accepts a screen-replace scene and defaults its pin shaping', () => {
    const spec = adSpecSchema.parse(
      baseSpec({
        scenes: [
          {
            type: 'screenReplace',
            id: 's5',
            from: 540,
            durationInFrames: 120,
            plateSrc: 's5.mp4',
            screenSrc: 'ui.webm',
            track: [
              { x: 456, y: 912, width: 168, height: 341 },
              { x: 367, y: 702, width: 346, height: 707 },
            ],
          },
        ],
      })
    );
    expect(spec.scenes[0]).toMatchObject({ cornerRadiusRatio: 0.13, overshoot: 0.02 });
  });

  it('rejects a screen-replace scene with an empty track', () => {
    const bad = baseSpec({
      scenes: [
        {
          type: 'screenReplace',
          id: 's5',
          from: 0,
          durationInFrames: 120,
          plateSrc: 's5.mp4',
          screenSrc: 'ui.webm',
          track: [],
        },
      ],
    });
    expect(() => adSpecSchema.parse(bad)).toThrow();
  });

  it('accepts an overlay emphasis word', () => {
    const spec = adSpecSchema.parse(
      baseSpec({
        overlays: [
          { from: 0, durationInFrames: 90, text: 'We built one thing.', emphasis: 'one thing' },
        ],
      })
    );
    expect(spec.overlays[0]).toMatchObject({ text: 'We built one thing.', emphasis: 'one thing' });
  });

  it('applies music bed defaults', () => {
    const spec = adSpecSchema.parse(baseSpec({ music: { src: 'bed.m4a', endAtFrame: 780 } }));
    expect(spec.music).toMatchObject({
      src: 'bed.m4a',
      endAtFrame: 780,
      baseVolume: 0.28,
      peakVolume: 0.38,
      swellFrames: 30,
    });
  });

  it('rejects a music volume above 1', () => {
    expect(() =>
      adSpecSchema.parse(baseSpec({ music: { src: 'bed.m4a', peakVolume: 1.5 } }))
    ).toThrow();
  });

  it('rejects a receipt scene with no lines', () => {
    const bad = baseSpec({
      scenes: [{ type: 'receipt', id: 's6', from: 0, durationInFrames: 1, lines: [] }],
    });
    expect(() => adSpecSchema.parse(bad)).toThrow();
  });

  it('rejects a negative scene start', () => {
    expect(() =>
      adSpecSchema.parse(
        baseSpec({
          scenes: [{ type: 'video', id: 's1', from: -1, durationInFrames: 90, src: 's1.mp4' }],
        })
      )
    ).toThrow();
  });
});
