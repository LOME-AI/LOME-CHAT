import { describe, it, expect, beforeEach } from 'vitest';
import { clearRecents, getRecents, pushRecent } from './recents.js';
import type { RecentEntry } from './recents.js';

function entry(id: string): RecentEntry {
  return { id, label: id, action: { kind: 'op', name: id } };
}

beforeEach(() => {
  clearRecents();
});

describe('recents', () => {
  it('starts empty', () => {
    expect(getRecents()).toEqual([]);
  });

  it('returns the most recent entry first', () => {
    pushRecent(entry('a'));
    pushRecent(entry('b'));
    expect(getRecents().map((recent) => recent.id)).toEqual(['b', 'a']);
  });

  it('dedupes by id, moving a repeat to the front', () => {
    pushRecent(entry('a'));
    pushRecent(entry('b'));
    pushRecent(entry('a'));
    expect(getRecents().map((recent) => recent.id)).toEqual(['a', 'b']);
  });

  it('caps the list at five entries', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      pushRecent(entry(id));
    }
    expect(getRecents()).toHaveLength(5);
    expect(getRecents()[0]?.id).toBe('f');
  });
});
