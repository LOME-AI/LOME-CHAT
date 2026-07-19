import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockUnwrapEpochKey = vi.hoisted(() =>
  vi.fn((_key: Uint8Array, _wrap: Uint8Array) => new Uint8Array([99]))
);
const mockTraverseChainLink = vi.hoisted(() =>
  vi.fn((_newer: Uint8Array, _cl: Uint8Array) => new Uint8Array([88]))
);
const mockVerifyEpochKeyConfirmation = vi.hoisted(() =>
  vi.fn(
    (_key: Uint8Array, _conversationId: string, _epochNumber: number, _hash: Uint8Array) => true
  )
);

vi.mock('@hushbox/crypto', () => ({
  unwrapEpochKey: (...args: Parameters<typeof mockUnwrapEpochKey>) => mockUnwrapEpochKey(...args),
  traverseChainLink: (...args: Parameters<typeof mockTraverseChainLink>) =>
    mockTraverseChainLink(...args),
  verifyEpochKeyConfirmation: (...args: Parameters<typeof mockVerifyEpochKeyConfirmation>) =>
    mockVerifyEpochKeyConfirmation(...args),
}));

import {
  getEpochKey,
  setEpochKey,
  clearEpochKeyCache,
  getCacheSize,
  getCurrentEpoch,
  setCurrentEpoch,
  processKeyChain,
  subscribe,
  getSnapshot,
} from './epoch-key-cache';

describe('epoch-key-cache', () => {
  beforeEach(() => {
    clearEpochKeyCache();
  });

  describe('getEpochKey', () => {
    it('returns undefined for missing key', () => {
      const result = getEpochKey('conv-1', 1);

      expect(result).toBeUndefined();
    });
  });

  describe('setEpochKey / getEpochKey', () => {
    it('returns stored key after set', () => {
      const key = new Uint8Array([1, 2, 3, 4]);
      setEpochKey('conv-1', 1, key);

      const result = getEpochKey('conv-1', 1);

      expect(result).toEqual(new Uint8Array([1, 2, 3, 4]));
    });

    it('returns different keys for different epoch numbers', () => {
      const key1 = new Uint8Array([10, 20]);
      const key2 = new Uint8Array([30, 40]);
      setEpochKey('conv-1', 1, key1);
      setEpochKey('conv-1', 2, key2);

      expect(getEpochKey('conv-1', 1)).toEqual(new Uint8Array([10, 20]));
      expect(getEpochKey('conv-1', 2)).toEqual(new Uint8Array([30, 40]));
    });

    it('does not collide between different conversations', () => {
      const key1 = new Uint8Array([1, 1]);
      const key2 = new Uint8Array([2, 2]);
      setEpochKey('conv-a', 1, key1);
      setEpochKey('conv-b', 1, key2);

      expect(getEpochKey('conv-a', 1)).toEqual(new Uint8Array([1, 1]));
      expect(getEpochKey('conv-b', 1)).toEqual(new Uint8Array([2, 2]));
    });

    it('retains first value when same key is set twice', () => {
      const key1 = new Uint8Array([1]);
      const key2 = new Uint8Array([2]);
      setEpochKey('conv-1', 1, key1);
      setEpochKey('conv-1', 1, key2);

      expect(getEpochKey('conv-1', 1)).toEqual(new Uint8Array([1]));
    });

    it('does not notify when key already cached', () => {
      setEpochKey('conv-1', 1, new Uint8Array([10, 20]));
      const listener = vi.fn();
      subscribe(listener);
      const versionBefore = getSnapshot();

      setEpochKey('conv-1', 1, new Uint8Array([99, 99]));

      expect(listener).not.toHaveBeenCalled();
      expect(getSnapshot()).toBe(versionBefore);
    });

    it('skips version bump for duplicate key', () => {
      setEpochKey('conv-1', 1, new Uint8Array([5]));
      const v1 = getSnapshot();

      setEpochKey('conv-1', 1, new Uint8Array([5]));
      const v2 = getSnapshot();

      expect(v2).toBe(v1);
    });
  });

  describe('clearEpochKeyCache', () => {
    it('removes all entries', () => {
      setEpochKey('conv-1', 1, new Uint8Array([1]));
      setEpochKey('conv-2', 1, new Uint8Array([2]));

      clearEpochKeyCache();

      expect(getEpochKey('conv-1', 1)).toBeUndefined();
      expect(getEpochKey('conv-2', 1)).toBeUndefined();
    });

    it('zeros key bytes before clearing', () => {
      const key = new Uint8Array([42, 43, 44]);
      setEpochKey('conv-1', 1, key);

      clearEpochKeyCache();

      // The original Uint8Array reference should be zeroed
      expect(key.every((b) => b === 0)).toBe(true);
    });

    it('is safe to call when cache is empty', () => {
      expect(() => {
        clearEpochKeyCache();
      }).not.toThrow();
    });
  });

  describe('getCacheSize', () => {
    it('returns 0 for empty cache', () => {
      expect(getCacheSize()).toBe(0);
    });

    it('returns correct count after inserts', () => {
      setEpochKey('conv-1', 1, new Uint8Array([1]));
      setEpochKey('conv-1', 2, new Uint8Array([2]));
      setEpochKey('conv-2', 1, new Uint8Array([3]));

      expect(getCacheSize()).toBe(3);
    });

    it('returns 0 after clear', () => {
      setEpochKey('conv-1', 1, new Uint8Array([1]));

      clearEpochKeyCache();

      expect(getCacheSize()).toBe(0);
    });
  });

  describe('setCurrentEpoch / getCurrentEpoch', () => {
    it('stores and retrieves the epoch number', () => {
      setCurrentEpoch('conv-1', 5);

      const result = getCurrentEpoch('conv-1');

      expect(result).toBe(5);
    });

    it('triggers subscriber notifications', async () => {
      const listener = vi.fn();
      subscribe(listener);
      const versionBefore = getSnapshot();

      setCurrentEpoch('conv-1', 3);

      // Version increments synchronously
      expect(getSnapshot()).toBe(versionBefore + 1);
      // Listener notification is deferred via queueMicrotask
      await Promise.resolve();
      expect(listener).toHaveBeenCalledOnce();
    });

    it('does not notify when value unchanged', () => {
      setCurrentEpoch('conv-1', 5);
      const listener = vi.fn();
      subscribe(listener);
      const versionBefore = getSnapshot();

      setCurrentEpoch('conv-1', 5);

      expect(listener).not.toHaveBeenCalled();
      expect(getSnapshot()).toBe(versionBefore);
    });

    it('ignores lower epoch number (prevents downgrade)', () => {
      setCurrentEpoch('conv-1', 5);

      setCurrentEpoch('conv-1', 3);

      expect(getCurrentEpoch('conv-1')).toBe(5);
    });

    it('does not notify when epoch would be downgraded', () => {
      setCurrentEpoch('conv-1', 5);
      const listener = vi.fn();
      subscribe(listener);
      const versionBefore = getSnapshot();

      setCurrentEpoch('conv-1', 3);

      expect(listener).not.toHaveBeenCalled();
      expect(getSnapshot()).toBe(versionBefore);
    });
  });

  describe('processKeyChain', () => {
    beforeEach(() => {
      mockUnwrapEpochKey.mockReset();
      mockTraverseChainLink.mockReset();
      mockVerifyEpochKeyConfirmation.mockReset();
      mockUnwrapEpochKey.mockReturnValue(new Uint8Array([99]));
      mockTraverseChainLink.mockReturnValue(new Uint8Array([88]));
      mockVerifyEpochKeyConfirmation.mockReturnValue(true);
    });

    it('populates current epoch from the key chain', () => {
      const keyChain = {
        wraps: [
          {
            epochNumber: 3,
            wrap: 'AAAA',
            confirmationHash: 'BBBB',
          },
        ],
        chainLinks: [],
        currentEpoch: 3,
      };

      processKeyChain('conv-1', keyChain, new Uint8Array([1]));

      expect(getCurrentEpoch('conv-1')).toBe(3);
    });

    it('skips wrap when confirmation hash verification fails', () => {
      mockVerifyEpochKeyConfirmation.mockReturnValue(false);

      const keyChain = {
        wraps: [
          {
            epochNumber: 3,
            wrap: 'AAAA',
            confirmationHash: 'BBBB',
          },
        ],
        chainLinks: [],
        currentEpoch: 3,
      };

      processKeyChain('conv-1', keyChain, new Uint8Array([1]));

      expect(getEpochKey('conv-1', 3)).toBeUndefined();
    });

    it('caches wrap when confirmation hash verification passes', () => {
      mockVerifyEpochKeyConfirmation.mockReturnValue(true);

      const keyChain = {
        wraps: [
          {
            epochNumber: 3,
            wrap: 'AAAA',
            confirmationHash: 'BBBB',
          },
        ],
        chainLinks: [],
        currentEpoch: 3,
      };

      processKeyChain('conv-1', keyChain, new Uint8Array([1]));

      expect(getEpochKey('conv-1', 3)).toEqual(new Uint8Array([99]));
    });

    it('skips chain-linked key when confirmation hash verification fails', () => {
      // First call (wrap): pass. Second call (chain link for older epoch): fail.
      mockVerifyEpochKeyConfirmation.mockReturnValueOnce(true).mockReturnValueOnce(false);

      const keyChain = {
        wraps: [
          {
            epochNumber: 3,
            wrap: 'AAAA',
            confirmationHash: 'CCCC',
          },
        ],
        chainLinks: [
          // Epoch 2 chain link provides epoch 2's confirmation hash for the lookup map
          { epochNumber: 2, chainLink: 'XXXX', confirmationHash: 'FFFF' },
          { epochNumber: 3, chainLink: 'DDDD', confirmationHash: 'EEEE' },
        ],
        currentEpoch: 3,
      };

      processKeyChain('conv-1', keyChain, new Uint8Array([1]));

      expect(getEpochKey('conv-1', 3)).toEqual(new Uint8Array([99]));
      expect(getEpochKey('conv-1', 2)).toBeUndefined();
    });

    it('caches chain-linked key when confirmation hash verification passes', () => {
      mockVerifyEpochKeyConfirmation.mockReturnValue(true);

      const keyChain = {
        wraps: [
          {
            epochNumber: 3,
            wrap: 'AAAA',
            confirmationHash: 'CCCC',
          },
        ],
        chainLinks: [{ epochNumber: 3, chainLink: 'DDDD', confirmationHash: 'EEEE' }],
        currentEpoch: 3,
      };

      processKeyChain('conv-1', keyChain, new Uint8Array([1]));

      expect(getEpochKey('conv-1', 3)).toEqual(new Uint8Array([99]));
      expect(getEpochKey('conv-1', 2)).toEqual(new Uint8Array([88]));
    });

    it('verifies wrap confirmation bound to conversation and epoch number', () => {
      const keyChain = {
        wraps: [{ epochNumber: 3, wrap: 'AAAA', confirmationHash: 'BBBB' }],
        chainLinks: [],
        currentEpoch: 3,
      };

      processKeyChain('conv-1', keyChain, new Uint8Array([1]));

      expect(mockVerifyEpochKeyConfirmation).toHaveBeenCalledWith(
        new Uint8Array([99]),
        'conv-1',
        3,
        expect.any(Uint8Array)
      );
    });

    it('verifies chain-linked confirmation bound to the older epoch number', () => {
      const keyChain = {
        wraps: [{ epochNumber: 3, wrap: 'AAAA', confirmationHash: 'CCCC' }],
        chainLinks: [
          { epochNumber: 3, chainLink: 'DDDD', confirmationHash: 'EEEE' },
          { epochNumber: 2, chainLink: 'GGGG', confirmationHash: 'FFFF' },
        ],
        currentEpoch: 3,
      };

      processKeyChain('conv-1', keyChain, new Uint8Array([1]));

      expect(mockVerifyEpochKeyConfirmation).toHaveBeenCalledWith(
        new Uint8Array([88]),
        'conv-1',
        2,
        expect.any(Uint8Array)
      );
    });

    it('does not downgrade current epoch from stale key chain', () => {
      setCurrentEpoch('conv-1', 5);

      const staleKeyChain = {
        wraps: [{ epochNumber: 3, wrap: 'AAAA', confirmationHash: 'BBBB' }],
        chainLinks: [],
        currentEpoch: 3,
      };

      processKeyChain('conv-1', staleKeyChain, new Uint8Array([1]));

      expect(getCurrentEpoch('conv-1')).toBe(5);
    });
  });

  describe('clearEpochKeyCache currentEpoch', () => {
    it('clears the current epoch map', () => {
      setCurrentEpoch('conv-1', 5);
      setCurrentEpoch('conv-2', 7);

      clearEpochKeyCache();

      expect(getCurrentEpoch('conv-1')).toBeUndefined();
      expect(getCurrentEpoch('conv-2')).toBeUndefined();
    });
  });
});
