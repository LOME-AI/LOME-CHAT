import { describe, expect, it, vi } from 'vitest';
import { evictUserFromRooms } from './user-rooms.js';

describe('evictUserFromRooms', () => {
  it('evicts the user from every room in their active-room set', async () => {
    const evicted: { conversationId: string; userId: string }[] = [];
    await evictUserFromRooms('u1', {
      listRooms: () => Promise.resolve(['c1', 'c2']),
      evictRoom: (conversationId, userId) => {
        evicted.push({ conversationId, userId });
        return Promise.resolve();
      },
    });
    expect(evicted).toEqual([
      { conversationId: 'c1', userId: 'u1' },
      { conversationId: 'c2', userId: 'u1' },
    ]);
  });

  it('evicts nothing when the set is empty', async () => {
    const evictRoom = vi.fn(() => Promise.resolve());
    await evictUserFromRooms('u1', {
      listRooms: () => Promise.resolve([]),
      evictRoom,
    });
    expect(evictRoom).not.toHaveBeenCalled();
  });

  it('swallows a set-read failure and evicts nothing (best-effort)', async () => {
    const evictRoom = vi.fn(() => Promise.resolve());
    const onError = vi.fn();
    await expect(
      evictUserFromRooms('u1', {
        listRooms: () => Promise.reject(new Error('redis down')),
        evictRoom,
        onError,
      })
    ).resolves.toBeUndefined();
    expect(evictRoom).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('continues evicting the remaining rooms when one room evict fails', async () => {
    const evicted: string[] = [];
    const onError = vi.fn();
    await evictUserFromRooms('u1', {
      listRooms: () => Promise.resolve(['c1', 'c2', 'c3']),
      evictRoom: (conversationId) => {
        if (conversationId === 'c2') return Promise.reject(new Error('room unreachable'));
        evicted.push(conversationId);
        return Promise.resolve();
      },
      onError,
    });
    expect(evicted).toEqual(['c1', 'c3']);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('does not throw when a room evict fails and no onError is supplied', async () => {
    await expect(
      evictUserFromRooms('u1', {
        listRooms: () => Promise.resolve(['c1']),
        evictRoom: () => Promise.reject(new Error('boom')),
      })
    ).resolves.toBeUndefined();
  });
});
