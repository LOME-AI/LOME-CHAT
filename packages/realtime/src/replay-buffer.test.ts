import { describe, expect, it } from 'vitest';
import { ReplayBuffer } from './replay-buffer.js';
import type { FlowStreamEvent } from '@hushbox/shared';

function event(streamId: string, cursor: number, content = 'x'): FlowStreamEvent {
  return { streamId, cursor, event: { kind: 'text-delta', index: 0, content } };
}

function buffer(maxStreamBytes = 10_000): ReplayBuffer {
  return new ReplayBuffer({ maxStreamBytes });
}

describe('append', () => {
  it('buffers an event within the byte budget', () => {
    expect(buffer().append(event('s1', 1))).toBe('buffered');
  });

  it('throws when a cursor does not increase strictly', () => {
    const replayBuffer = buffer();
    replayBuffer.append(event('s1', 2));
    expect(() => replayBuffer.append(event('s1', 2))).toThrow(/cursor/);
  });

  it('throws when the first cursor of a stream is below one', () => {
    expect(() => buffer().append(event('s1', 0))).toThrow(/cursor/);
  });
});

describe('resume', () => {
  it('replays every buffered event from lastEventId zero in order', () => {
    const replayBuffer = buffer();
    replayBuffer.append(event('s1', 1, 'a'));
    replayBuffer.append(event('s1', 2, 'b'));
    const result = replayBuffer.resume('s1', 0);
    expect(result).toEqual({ kind: 'replay', events: [event('s1', 1, 'a'), event('s1', 2, 'b')] });
  });

  it('replays only events after the given cursor', () => {
    const replayBuffer = buffer();
    replayBuffer.append(event('s1', 1, 'a'));
    replayBuffer.append(event('s1', 2, 'b'));
    replayBuffer.append(event('s1', 3, 'c'));
    const result = replayBuffer.resume('s1', 2);
    expect(result).toEqual({ kind: 'replay', events: [event('s1', 3, 'c')] });
  });

  it('returns an empty replay when the client is fully caught up', () => {
    const replayBuffer = buffer();
    replayBuffer.append(event('s1', 1));
    expect(replayBuffer.resume('s1', 1)).toEqual({ kind: 'replay', events: [] });
  });

  it('keeps streams isolated from each other', () => {
    const replayBuffer = buffer();
    replayBuffer.append(event('s1', 1, 'a'));
    replayBuffer.append(event('s2', 1, 'b'));
    expect(replayBuffer.resume('s1', 0)).toEqual({
      kind: 'replay',
      events: [event('s1', 1, 'a')],
    });
  });

  it('reports an unknown stream as gone', () => {
    expect(buffer().resume('missing', 0)).toEqual({ kind: 'gone' });
  });

  it('reports a cursor beyond the buffered tail as gone', () => {
    const replayBuffer = buffer();
    replayBuffer.append(event('s1', 1));
    expect(replayBuffer.resume('s1', 5)).toEqual({ kind: 'gone' });
  });
});

describe('overflow', () => {
  it('drops replay for a stream that exceeds its byte budget', () => {
    const replayBuffer = buffer(100);
    replayBuffer.append(event('s1', 1, 'a'.repeat(200)));
    expect(replayBuffer.resume('s1', 0)).toEqual({ kind: 'gone' });
  });

  it('reports the overflowing append as dropped', () => {
    const replayBuffer = buffer(100);
    expect(replayBuffer.append(event('s1', 1, 'a'.repeat(200)))).toBe('dropped');
  });

  it('keeps an overflowed stream gone for later appends', () => {
    const replayBuffer = buffer(100);
    replayBuffer.append(event('s1', 1, 'a'.repeat(200)));
    expect(replayBuffer.append(event('s1', 2, 'b'))).toBe('dropped');
    expect(replayBuffer.resume('s1', 0)).toEqual({ kind: 'gone' });
  });

  it('leaves other streams replayable when one overflows', () => {
    const replayBuffer = buffer(100);
    replayBuffer.append(event('s1', 1, 'a'.repeat(200)));
    replayBuffer.append(event('s2', 1, 'b'));
    expect(replayBuffer.resume('s2', 0)).toEqual({ kind: 'replay', events: [event('s2', 1, 'b')] });
  });
});
