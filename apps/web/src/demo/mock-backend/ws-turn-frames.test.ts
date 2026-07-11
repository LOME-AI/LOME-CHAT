import { describe, it, expect } from 'vitest';
import { buildTurnFrames } from './ws-turn-frames';

describe('buildTurnFrames', () => {
  const params = {
    runId: 'run-1',
    modelId: 'demo-model',
    content: 'Hello demo world',
    chunkSize: 6,
  };

  it('opens with run-started and the stream-start label', () => {
    const frames = buildTurnFrames(params);
    expect(frames[0]).toEqual({ type: 'run-started', runId: 'run-1' });
    expect(frames[1]).toMatchObject({
      type: 'stream',
      cursor: 1,
      event: { kind: 'stream-start', modelId: 'demo-model' },
    });
  });

  it('chunks the content into text-delta frames with increasing cursors', () => {
    const frames = buildTurnFrames(params);
    const deltas = frames.flatMap((f) =>
      f.type === 'stream' && f.event.kind === 'text-delta' ? [f.event.content] : []
    );
    expect(deltas).toHaveLength(3);
    expect(deltas.join('')).toBe('Hello demo world');
    const cursors = frames.flatMap((f) => (f.type === 'stream' ? [f.cursor] : []));
    expect(cursors).toEqual([...cursors].toSorted((a, b) => a - b));
  });

  it('ends with a finish event and run-finished succeeded', () => {
    const frames = buildTurnFrames(params);
    const last = frames.at(-1);
    expect(last).toEqual({
      type: 'run-finished',
      runId: 'run-1',
      outcome: { outcome: 'succeeded' },
    });
    const secondToLast = frames.at(-2);
    expect(secondToLast).toMatchObject({ type: 'stream', event: { kind: 'finish' } });
  });

  it('emits media-start and media-done for a media turn', () => {
    const frames = buildTurnFrames({
      ...params,
      media: { mediaType: 'image', mimeType: 'image/png' },
    });
    const kinds = frames.flatMap((f) => (f.type === 'stream' ? [f.event.kind] : []));
    expect(kinds).toContain('media-start');
    expect(kinds).toContain('media-done');
    expect(kinds.indexOf('media-start')).toBeLessThan(kinds.indexOf('media-done'));
  });
});
