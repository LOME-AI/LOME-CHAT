import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPerformEpochRotation = vi.fn();
const mockEncryptMessageForStorage = vi.fn();

vi.mock('@hushbox/crypto', () => ({
  performEpochRotation: (...args: unknown[]) => mockPerformEpochRotation(...args),
  encryptTextForEpoch: (...args: unknown[]) => mockEncryptMessageForStorage(...args),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    toBase64: vi.fn((bytes: Uint8Array) => Buffer.from(bytes).toString('base64')),
    fromBase64: vi.fn((s: string) => new Uint8Array(Buffer.from(s, 'base64'))),
  };
});

const mockFetchJson = vi.fn();
vi.mock('./api-client', () => ({
  client: {
    conversations: {
      ':conversationId': {
        'member-keys': {
          $get: vi.fn(() => 'member-keys-promise'),
        },
      },
    },
  },
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
}));

const mockSetEpochKey = vi.fn();
const mockSetCurrentEpoch = vi.fn();
vi.mock('./epoch-key-cache', () => ({
  setEpochKey: (...args: unknown[]) => mockSetEpochKey(...args),
  setCurrentEpoch: (...args: unknown[]) => mockSetCurrentEpoch(...args),
}));

import { buildRotation, executeWithRotation } from './rotation';

describe('buildRotation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when currentEpochPrivateKey is all zeros', () => {
    expect(() =>
      buildRotation({
        conversationId: 'conv-1',
        currentEpochPrivateKey: new Uint8Array(32).fill(0),
        currentEpochNumber: 3,
        members: [{ publicKey: new Uint8Array(32).fill(2) }],
        plaintextTitle: 'Test Title',
      })
    ).toThrow('Cannot rotate: epoch key unavailable');
  });

  it('calls performEpochRotation with private key and member public keys', () => {
    const privateKey = new Uint8Array(32).fill(1);
    const pubKey1 = new Uint8Array(32).fill(2);
    const pubKey2 = new Uint8Array(32).fill(3);
    const rotationResult = {
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(11),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [
        { memberPublicKey: pubKey1, wrap: new Uint8Array(48).fill(20) },
        { memberPublicKey: pubKey2, wrap: new Uint8Array(48).fill(21) },
      ],
      chainLink: new Uint8Array(64).fill(13),
    };
    mockPerformEpochRotation.mockReturnValue(rotationResult);
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(64).fill(99));

    buildRotation({
      conversationId: 'conv-1',
      currentEpochPrivateKey: privateKey,
      currentEpochNumber: 3,
      members: [{ publicKey: pubKey1 }, { publicKey: pubKey2 }],
      plaintextTitle: 'Test Title',
    });

    expect(mockPerformEpochRotation).toHaveBeenCalledWith(
      privateKey,
      [pubKey1, pubKey2],
      'conv-1',
      4
    );
  });

  it('encrypts the title with the new epoch public key', () => {
    const rotationResult = {
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(11),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    };
    mockPerformEpochRotation.mockReturnValue(rotationResult);
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    buildRotation({
      conversationId: 'conv-1',
      currentEpochPrivateKey: new Uint8Array(32).fill(1),
      currentEpochNumber: 1,
      members: [],
      plaintextTitle: 'My Chat',
    });

    expect(mockEncryptMessageForStorage).toHaveBeenCalledWith(
      rotationResult.epochPublicKey,
      'My Chat'
    );
  });

  it('returns StreamChatRotation params with base64-encoded fields and correct metadata', () => {
    const pubKey1 = new Uint8Array(32).fill(2);
    const rotationResult = {
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(11),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [{ memberPublicKey: pubKey1, wrap: new Uint8Array(48).fill(20) }],
      chainLink: new Uint8Array(64).fill(13),
    };
    mockPerformEpochRotation.mockReturnValue(rotationResult);
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    const result = buildRotation({
      conversationId: 'conv-1',
      currentEpochPrivateKey: new Uint8Array(32).fill(1),
      currentEpochNumber: 5,
      members: [{ publicKey: pubKey1 }],
      plaintextTitle: 'Title',
    });

    expect(result.params.expectedEpoch).toBe(5);
    expect(typeof result.params.epochPublicKey).toBe('string');
    expect(typeof result.params.confirmationHash).toBe('string');
    expect(typeof result.params.chainLink).toBe('string');
    expect(typeof result.params.encryptedTitle).toBe('string');
    expect(result.params.memberWraps).toHaveLength(1);
    expect(typeof result.params.memberWraps[0]!.memberPublicKey).toBe('string');
    expect(typeof result.params.memberWraps[0]!.wrap).toBe('string');
    // Verify memberWraps shape: only memberPublicKey + wrap (no metadata)
    expect(Object.keys(result.params.memberWraps[0]!)).toEqual(['memberPublicKey', 'wrap']);
  });

  it('returns new epoch private key and incremented epoch number', () => {
    const newPrivateKey = new Uint8Array(32).fill(11);
    const rotationResult = {
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: newPrivateKey,
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    };
    mockPerformEpochRotation.mockReturnValue(rotationResult);
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    const result = buildRotation({
      conversationId: 'conv-1',
      currentEpochPrivateKey: new Uint8Array(32).fill(1),
      currentEpochNumber: 3,
      members: [],
      plaintextTitle: 'Title',
    });

    expect(result.newEpochPrivateKey).toBe(newPrivateKey);
    expect(result.newEpochNumber).toBe(4);
  });
});

describe('executeWithRotation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches member keys, builds rotation, executes mutation, and updates cache', async () => {
    const memberKeys = [
      {
        memberId: 'm1',
        userId: 'u1',
        linkId: null,
        publicKey: 'cHViMQ==',
        privilege: 'owner',
        visibleFromEpoch: 1,
      },
      {
        memberId: 'm2',
        userId: 'u2',
        linkId: null,
        publicKey: 'cHViMg==',
        privilege: 'write',
        visibleFromEpoch: 1,
      },
    ];
    mockFetchJson.mockResolvedValue({ members: memberKeys });

    // echo input keys back in memberWraps (like the real function)
    const newPrivateKey = new Uint8Array(32).fill(77);
    mockPerformEpochRotation.mockImplementation(
      (_privateKey: Uint8Array, memberPublicKeys: Uint8Array[]) => ({
        epochPublicKey: new Uint8Array(32).fill(10),
        epochPrivateKey: newPrivateKey,
        confirmationHash: new Uint8Array(32).fill(12),
        memberWraps: memberPublicKeys.map((key) => ({
          memberPublicKey: key,
          wrap: new Uint8Array(48).fill(20),
        })),
        chainLink: new Uint8Array(64).fill(13),
      })
    );
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    const mockExecute = vi.fn().mockResolvedValue({});
    const mockFilterMembers = vi.fn((keys: { publicKey: string }[]) =>
      keys.map((k) => ({
        publicKey: new Uint8Array(Buffer.from(k.publicKey, 'base64')),
      }))
    );

    const result = await executeWithRotation({
      conversationId: 'conv-1',
      currentEpochPrivateKey: new Uint8Array(32).fill(1),
      currentEpochNumber: 3,
      plaintextTitle: 'Test',
      filterMembers: mockFilterMembers,
      execute: mockExecute,
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);

    expect(mockFilterMembers).toHaveBeenCalledWith(memberKeys);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith(result.params);

    expect(mockSetEpochKey).toHaveBeenCalledWith('conv-1', 4, newPrivateKey);
    expect(mockSetCurrentEpoch).toHaveBeenCalledWith('conv-1', 4);
  });

  it('retries on 409 StaleEpochError', async () => {
    const memberKeys = [
      {
        memberId: 'm1',
        userId: 'u1',
        linkId: null,
        publicKey: 'cHViMQ==',
        privilege: 'owner',
        visibleFromEpoch: 1,
      },
    ];
    mockFetchJson.mockResolvedValue({ members: memberKeys });

    const newPrivateKey = new Uint8Array(32).fill(77);
    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: newPrivateKey,
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    const staleError = new Error('Epoch rotation conflict');
    Object.assign(staleError, { name: 'ApiError', status: 409, data: { code: 'STALE_EPOCH' } });

    const mockExecute = vi.fn().mockRejectedValueOnce(staleError).mockResolvedValueOnce({});

    await executeWithRotation({
      conversationId: 'conv-1',
      currentEpochPrivateKey: new Uint8Array(32).fill(1),
      currentEpochNumber: 3,
      plaintextTitle: 'Test',
      filterMembers: (keys) =>
        keys.map((k) => ({
          publicKey: new Uint8Array(Buffer.from(k.publicKey, 'base64')),
        })),
      execute: mockExecute,
    });

    expect(mockExecute).toHaveBeenCalledTimes(2);
    // member keys re-fetched after 409
    expect(mockFetchJson).toHaveBeenCalledTimes(2);
  });

  it('gives up after max retries on repeated 409', async () => {
    const memberKeys = [
      {
        memberId: 'm1',
        userId: 'u1',
        linkId: null,
        publicKey: 'cHViMQ==',
        privilege: 'owner',
        visibleFromEpoch: 1,
      },
    ];
    mockFetchJson.mockResolvedValue({ members: memberKeys });

    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(11),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    const staleError = new Error('Epoch rotation conflict');
    Object.assign(staleError, { name: 'ApiError', status: 409, data: { code: 'STALE_EPOCH' } });

    const mockExecute = vi.fn().mockRejectedValue(staleError);

    await expect(
      executeWithRotation({
        conversationId: 'conv-1',
        currentEpochPrivateKey: new Uint8Array(32).fill(1),
        currentEpochNumber: 3,
        plaintextTitle: 'Test',
        filterMembers: (keys) =>
          keys.map((k) => ({
            publicKey: new Uint8Array(Buffer.from(k.publicKey, 'base64')),
          })),
        execute: mockExecute,
      })
    ).rejects.toThrow('Epoch rotation conflict');

    // initial + 1 retry
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it('throws non-409 errors immediately without retry', async () => {
    const memberKeys = [
      {
        memberId: 'm1',
        userId: 'u1',
        linkId: null,
        publicKey: 'cHViMQ==',
        privilege: 'owner',
        visibleFromEpoch: 1,
      },
    ];
    mockFetchJson.mockResolvedValue({ members: memberKeys });

    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(11),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    const networkError = new Error('Network error');
    const mockExecute = vi.fn().mockRejectedValue(networkError);

    await expect(
      executeWithRotation({
        conversationId: 'conv-1',
        currentEpochPrivateKey: new Uint8Array(32).fill(1),
        currentEpochNumber: 3,
        plaintextTitle: 'Test',
        filterMembers: (keys) =>
          keys.map((k) => ({
            publicKey: new Uint8Array(Buffer.from(k.publicKey, 'base64')),
          })),
        execute: mockExecute,
      })
    ).rejects.toThrow('Network error');

    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});
