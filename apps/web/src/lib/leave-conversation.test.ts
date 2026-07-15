import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserMessageError } from '@hushbox/ui';
import { leaveConversation } from './leave-conversation';

const mockExecuteWithRotation = vi.fn();
const mockGetCurrentEpoch = vi.fn();
const mockGetEpochKey = vi.fn();

vi.mock('./rotation.js', () => ({
  executeWithRotation: (...args: unknown[]) => mockExecuteWithRotation(...args),
}));

vi.mock('./epoch-key-cache.js', () => ({
  getCurrentEpoch: (...args: unknown[]) => mockGetCurrentEpoch(...args),
  getEpochKey: (...args: unknown[]) => mockGetEpochKey(...args),
}));

describe('leaveConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteWithRotation.mockImplementation(() => Promise.resolve());
    mockGetCurrentEpoch.mockReturnValue(3);
    mockGetEpochKey.mockReturnValue(new Uint8Array(32).fill(7));
  });

  describe('owner path', () => {
    it('calls leave with only conversationId — no rotation', async () => {
      const leave = vi.fn(() => Promise.resolve());

      await leaveConversation({
        conversationId: 'conv-1',
        callerId: 'u1',
        plaintextTitle: 'My chat',
        privilege: 'owner',
        leave,
      });

      expect(leave).toHaveBeenCalledOnce();
      expect(leave).toHaveBeenCalledWith({ conversationId: 'conv-1' });
    });

    it('does not invoke executeWithRotation on owner path', async () => {
      const leave = vi.fn(() => Promise.resolve());

      await leaveConversation({
        conversationId: 'conv-1',
        callerId: 'u1',
        plaintextTitle: 'My chat',
        privilege: 'owner',
        leave,
      });

      expect(mockExecuteWithRotation).not.toHaveBeenCalled();
    });
  });

  describe('non-owner path', () => {
    it.each([['read'], ['write'], ['admin']] as const)(
      'invokes executeWithRotation for privilege %s',
      async (privilege) => {
        const leave = vi.fn(() => Promise.resolve());

        await leaveConversation({
          conversationId: 'conv-1',
          callerId: 'u1',
          plaintextTitle: 'My chat',
          privilege,
          leave,
        });

        expect(mockExecuteWithRotation).toHaveBeenCalledOnce();
      }
    );

    it('passes the epoch key + number from the cache into executeWithRotation', async () => {
      const epochKey = new Uint8Array(32).fill(42);
      mockGetCurrentEpoch.mockReturnValue(5);
      mockGetEpochKey.mockReturnValue(epochKey);
      const leave = vi.fn(() => Promise.resolve());

      await leaveConversation({
        conversationId: 'conv-1',
        callerId: 'u1',
        plaintextTitle: 'My chat',
        privilege: 'write',
        leave,
      });

      expect(mockExecuteWithRotation).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-1',
          currentEpochPrivateKey: epochKey,
          currentEpochNumber: 5,
          plaintextTitle: 'My chat',
          filterMembers: expect.any(Function),
          execute: expect.any(Function),
        })
      );
    });

    it('filterMembers excludes the caller and maps the remaining keys', async () => {
      const leave = vi.fn(() => Promise.resolve());

      await leaveConversation({
        conversationId: 'conv-1',
        callerId: 'u1',
        plaintextTitle: 'My chat',
        privilege: 'write',
        leave,
      });

      const call = mockExecuteWithRotation.mock.calls[0]![0] as {
        filterMembers: (
          keys: { userId: string | null; publicKey: string }[]
        ) => { publicKey: Uint8Array }[];
      };
      const filtered = call.filterMembers([
        { userId: 'u1', publicKey: btoa('aaaa') },
        { userId: 'u2', publicKey: btoa('bbbb') },
        { userId: 'u3', publicKey: btoa('cccc') },
      ]);
      expect(filtered).toHaveLength(2);
      expect(filtered[0]!.publicKey).toBeInstanceOf(Uint8Array);
      expect(filtered[1]!.publicKey).toBeInstanceOf(Uint8Array);
    });

    it('execute callback forwards rotation into the leave mutation', async () => {
      const leave = vi.fn(() => Promise.resolve());

      await leaveConversation({
        conversationId: 'conv-1',
        callerId: 'u1',
        plaintextTitle: 'My chat',
        privilege: 'write',
        leave,
      });

      const call = mockExecuteWithRotation.mock.calls[0]![0] as {
        execute: (rotation: { expectedEpoch: number }) => Promise<unknown>;
      };
      const fakeRotation = { expectedEpoch: 3 } as unknown as {
        expectedEpoch: number;
      };
      await call.execute(fakeRotation);

      expect(leave).toHaveBeenCalledWith({ conversationId: 'conv-1', rotation: fakeRotation });
    });

    it('throws UserMessageError when the epoch number is unknown', async () => {
      // eslint-disable-next-line unicorn/no-useless-undefined -- explicit return so TS matches getCurrentEpoch's `number | undefined`
      mockGetCurrentEpoch.mockImplementation(() => undefined);
      const leave = vi.fn(() => Promise.resolve());

      await expect(
        leaveConversation({
          conversationId: 'conv-1',
          callerId: 'u1',
          plaintextTitle: 'My chat',
          privilege: 'write',
          leave,
        })
      ).rejects.toThrow('Something went wrong. Please try again later.');
      expect(leave).not.toHaveBeenCalled();
    });

    it('throws UserMessageError when the epoch key is missing from the cache', async () => {
      mockGetCurrentEpoch.mockReturnValue(3);
      // eslint-disable-next-line unicorn/no-useless-undefined -- explicit return so TS matches getEpochKey's `Uint8Array | undefined`
      mockGetEpochKey.mockImplementation(() => undefined);
      const leave = vi.fn(() => Promise.resolve());

      await expect(
        leaveConversation({
          conversationId: 'conv-1',
          callerId: 'u1',
          plaintextTitle: 'My chat',
          privilege: 'write',
          leave,
        })
      ).rejects.toBeInstanceOf(UserMessageError);
      expect(leave).not.toHaveBeenCalled();
    });
  });
});
