import { describe, expect, it } from 'vitest';
import {
  assembleKeyChain,
  buildParentIndex,
  collectAncestorChain,
  exclusiveMessageIds,
} from './parent-chain.js';

describe('buildParentIndex', () => {
  it('maps each message id to its parent id', () => {
    const index = buildParentIndex([
      { id: 'a', parentMessageId: null },
      { id: 'b', parentMessageId: 'a' },
    ]);
    expect(index.get('b')).toBe('a');
  });

  it('maps a root message to null', () => {
    const index = buildParentIndex([{ id: 'a', parentMessageId: null }]);
    expect(index.get('a')).toBeNull();
  });
});

describe('collectAncestorChain', () => {
  const index = buildParentIndex([
    { id: 'root', parentMessageId: null },
    { id: 'mid', parentMessageId: 'root' },
    { id: 'tip', parentMessageId: 'mid' },
  ]);

  it('walks from the tip to the root in order', () => {
    expect(collectAncestorChain(index, 'tip')).toEqual(['tip', 'mid', 'root']);
  });

  it('returns only the tip when the tip is a root', () => {
    expect(collectAncestorChain(index, 'root')).toEqual(['root']);
  });

  it('returns an empty chain for a null tip', () => {
    expect(collectAncestorChain(index, null)).toEqual([]);
  });

  it('returns an empty chain for a tip absent from the index', () => {
    expect(collectAncestorChain(index, 'ghost')).toEqual([]);
  });

  it('stops walking when a parent id is missing from the index', () => {
    const dangling = buildParentIndex([{ id: 'tip', parentMessageId: 'gone' }]);
    expect(collectAncestorChain(dangling, 'tip')).toEqual(['tip']);
  });

  it('terminates on a cyclic parent reference instead of looping', () => {
    const cyclic = buildParentIndex([
      { id: 'a', parentMessageId: 'b' },
      { id: 'b', parentMessageId: 'a' },
    ]);
    expect(collectAncestorChain(cyclic, 'a')).toEqual(['a', 'b']);
  });
});

describe('exclusiveMessageIds', () => {
  // root → shared → tipA
  //              └→ tipB
  const index = buildParentIndex([
    { id: 'root', parentMessageId: null },
    { id: 'shared', parentMessageId: 'root' },
    { id: 'tipA', parentMessageId: 'shared' },
    { id: 'tipB', parentMessageId: 'shared' },
  ]);

  it('returns messages reachable only through the target tip', () => {
    expect(exclusiveMessageIds(index, 'tipA', ['tipB'])).toEqual(['tipA']);
  });

  it('returns the whole chain when no other tips exist', () => {
    expect(exclusiveMessageIds(index, 'tipA', [])).toEqual(['tipA', 'shared', 'root']);
  });

  it('returns nothing when the target chain is fully shared', () => {
    expect(exclusiveMessageIds(index, 'shared', ['tipA'])).toEqual([]);
  });

  it('ignores null tips among the other forks', () => {
    expect(exclusiveMessageIds(index, 'tipA', [null, 'tipB'])).toEqual(['tipA']);
  });
});

describe('assembleKeyChain', () => {
  const wrap = (epochNumber: number, visibleFromEpoch: number): { epochNumber: number; visibleFromEpoch: number } => ({
    epochNumber,
    visibleFromEpoch,
  });
  const link = (epochNumber: number): { epochNumber: number } => ({ epochNumber });

  it('returns null when the member holds no wraps', () => {
    expect(assembleKeyChain([], [link(2)], 3)).toBeNull();
  });

  it('keeps wraps at or above the member visibility floor', () => {
    const result = assembleKeyChain([wrap(1, 2), wrap(3, 2)], [], 3);
    expect(result?.wraps).toEqual([wrap(3, 2)]);
  });

  it('keeps chain links strictly above the visibility floor', () => {
    const result = assembleKeyChain([wrap(3, 2)], [link(2), link(3)], 3);
    expect(result?.chainLinks).toEqual([link(3)]);
  });

  it('uses the lowest visibleFromEpoch across the member wraps as the floor', () => {
    const result = assembleKeyChain([wrap(2, 1), wrap(3, 3)], [link(2), link(3)], 3);
    expect(result?.wraps).toEqual([wrap(2, 1), wrap(3, 3)]);
    expect(result?.chainLinks).toEqual([link(2), link(3)]);
  });

  it('reports the conversation currentEpoch unchanged', () => {
    expect(assembleKeyChain([wrap(1, 1)], [], 7)?.currentEpoch).toBe(7);
  });
});
