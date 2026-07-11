import { describe, it, expect } from 'vitest';
import { parseServerFrame } from '@/lib/server-frames.js';

describe('parseServerFrame', () => {
  it('parses the ready frame', () => {
    expect(parseServerFrame('{"type":"ready"}')).toEqual({ type: 'ready' });
  });

  it('parses an event frame carrying a realtime event', () => {
    const raw = JSON.stringify({
      type: 'event',
      event: { type: 'typing:start', timestamp: 1, conversationId: 'c1', userId: 'u1' },
    });
    const frame = parseServerFrame(raw);
    expect(frame).toEqual({
      type: 'event',
      event: { type: 'typing:start', timestamp: 1, conversationId: 'c1', userId: 'u1' },
    });
  });

  it('parses a stream frame with an inference event', () => {
    const raw = JSON.stringify({
      type: 'stream',
      streamId: 'answer0#0',
      cursor: 3,
      event: { kind: 'text-delta', index: 0, content: 'hello' },
    });
    expect(parseServerFrame(raw)).toEqual({
      type: 'stream',
      streamId: 'answer0#0',
      cursor: 3,
      event: { kind: 'text-delta', index: 0, content: 'hello' },
    });
  });

  it('parses a stream-start inference event', () => {
    const raw = JSON.stringify({
      type: 'stream',
      streamId: 's1',
      cursor: 1,
      event: { kind: 'stream-start', modelId: 'openai/gpt-4o' },
    });
    const frame = parseServerFrame(raw);
    expect(frame).not.toBeNull();
    if (frame?.type !== 'stream') throw new Error('expected stream frame');
    expect(frame.event).toEqual({ kind: 'stream-start', modelId: 'openai/gpt-4o' });
  });

  it('parses stream-gone', () => {
    expect(parseServerFrame('{"type":"stream-gone","streamId":"s1"}')).toEqual({
      type: 'stream-gone',
      streamId: 's1',
    });
  });

  it('parses run-started', () => {
    expect(parseServerFrame('{"type":"run-started","runId":"r1"}')).toEqual({
      type: 'run-started',
      runId: 'r1',
    });
  });

  it('parses run-finished with a succeeded outcome', () => {
    const raw = JSON.stringify({
      type: 'run-finished',
      runId: 'r1',
      outcome: { outcome: 'succeeded' },
    });
    expect(parseServerFrame(raw)).toEqual({
      type: 'run-finished',
      runId: 'r1',
      outcome: { outcome: 'succeeded' },
    });
  });

  it('parses run-finished with a failed outcome carrying a code', () => {
    const raw = JSON.stringify({
      type: 'run-finished',
      runId: 'r1',
      outcome: { outcome: 'failed', code: 'INTERNAL' },
    });
    expect(parseServerFrame(raw)).toEqual({
      type: 'run-finished',
      runId: 'r1',
      outcome: { outcome: 'failed', code: 'INTERNAL' },
    });
  });

  it('returns null for malformed JSON', () => {
    expect(parseServerFrame('not-json')).toBeNull();
  });

  it('returns null for an unknown frame type', () => {
    expect(parseServerFrame('{"type":"mystery"}')).toBeNull();
  });

  it('returns null for a stream frame with an invalid inference event', () => {
    const raw = JSON.stringify({
      type: 'stream',
      streamId: 's1',
      cursor: 1,
      event: { kind: 'nope' },
    });
    expect(parseServerFrame(raw)).toBeNull();
  });

  it('returns null for a run-finished frame with an unknown outcome', () => {
    const raw = JSON.stringify({
      type: 'run-finished',
      runId: 'r1',
      outcome: { outcome: 'exploded' },
    });
    expect(parseServerFrame(raw)).toBeNull();
  });

  it('returns null for an event frame with an invalid realtime event', () => {
    const raw = JSON.stringify({ type: 'event', event: { type: 'bogus' } });
    expect(parseServerFrame(raw)).toBeNull();
  });
});
