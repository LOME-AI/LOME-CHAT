import { describe, expect, it, vi } from 'vitest';
import {
  getOwnedConversation,
  getOwnedPayment,
  ResourceNotFoundError,
  findActiveMember,
  findActiveSharedLink,
} from './db-helpers';

describe('db-helpers', () => {
  describe('ResourceNotFoundError', () => {
    it('creates error with correct message', () => {
      const error = new ResourceNotFoundError('Conversation');
      expect(error.message).toBe('Conversation not found');
      expect(error.name).toBe('ResourceNotFoundError');
    });
  });

  describe('getOwnedConversation', () => {
    it('returns conversation when found and owned by user', async () => {
      const mockConversation = {
        id: 'conv-123',
        userId: 'user-123',
        title: 'Test Conversation',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([mockConversation]),
      };

      const result = await getOwnedConversation(mockDb as never, 'conv-123', 'user-123');
      expect(result).toEqual(mockConversation);
    });

    it('throws ResourceNotFoundError when conversation not found', async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
      };

      await expect(getOwnedConversation(mockDb as never, 'conv-123', 'user-123')).rejects.toThrow(
        ResourceNotFoundError
      );
      await expect(getOwnedConversation(mockDb as never, 'conv-123', 'user-123')).rejects.toThrow(
        'Conversation not found'
      );
    });

    it('throws ResourceNotFoundError when conversation owned by different user', async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
      };

      await expect(
        getOwnedConversation(mockDb as never, 'conv-123', 'different-user')
      ).rejects.toThrow(ResourceNotFoundError);
    });
  });

  describe('getOwnedPayment', () => {
    it('returns payment when found and owned by user', async () => {
      const mockPayment = {
        id: 'payment-123',
        userId: 'user-123',
        amount: '10.00000000',
        status: 'pending' as const,
        helcimTransactionId: null,
        cardType: null,
        cardLastFour: null,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        webhookReceivedAt: null,
      };

      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([mockPayment]),
      };

      const result = await getOwnedPayment(mockDb as never, 'payment-123', 'user-123');
      expect(result).toEqual(mockPayment);
    });

    it('throws ResourceNotFoundError when payment not found', async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
      };

      await expect(getOwnedPayment(mockDb as never, 'payment-123', 'user-123')).rejects.toThrow(
        ResourceNotFoundError
      );
      await expect(getOwnedPayment(mockDb as never, 'payment-123', 'user-123')).rejects.toThrow(
        'Payment not found'
      );
    });
  });

  describe('findActiveMember', () => {
    it('returns member when found and active', async () => {
      const mockMember = {
        id: 'member-1',
        privilege: 'admin',
        userId: 'user-1',
      };

      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([mockMember]),
      };

      const result = await findActiveMember(mockDb as never, 'member-1', 'conv-1');
      expect(result).toEqual(mockMember);
    });

    it('returns undefined when member not found', async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      };

      const result = await findActiveMember(mockDb as never, 'member-1', 'conv-1');
      expect(result).toBeUndefined();
    });
  });

  describe('findActiveSharedLink', () => {
    it('returns shared link when found and not revoked', async () => {
      const mockLink = {
        id: 'link-1',
        privilege: 'read',
      };

      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([mockLink]),
      };

      const result = await findActiveSharedLink(mockDb as never, 'conv-1', new Uint8Array(32));
      expect(result).toEqual(mockLink);
    });

    it('returns undefined when link not found', async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      };

      const result = await findActiveSharedLink(mockDb as never, 'conv-1', new Uint8Array(32));
      expect(result).toBeUndefined();
    });
  });
});
