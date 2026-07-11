import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

const mockGetEpochKey = vi.fn<(conversationId: string, epochNumber: number) => Uint8Array | null>();

vi.mock('@/lib/epoch-key-cache', () => ({
  getEpochKey: (conversationId: string, epochNumber: number) =>
    mockGetEpochKey(conversationId, epochNumber),
}));

const mockOpenMessageEnvelope =
  vi.fn<(epochPrivateKey: Uint8Array, wrappedContentKey: Uint8Array) => Uint8Array>();
const mockCreateShare =
  vi.fn<(contentKey: Uint8Array) => { shareSecret: Uint8Array; wrappedShareKey: Uint8Array }>();

vi.mock('@hushbox/crypto', () => ({
  openMessageEnvelope: (...args: [Uint8Array, Uint8Array]) => mockOpenMessageEnvelope(...args),
  createShare: (contentKey: Uint8Array) => mockCreateShare(contentKey),
}));

const mockToBase64 = vi.fn<(data: Uint8Array) => string>();
const mockFromBase64 = vi.fn<(b64: string) => Uint8Array>();

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    toBase64: (data: Uint8Array) => mockToBase64(data),
    fromBase64: (b64: string) => mockFromBase64(b64),
  };
});

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

// UNPORTED: the rebuilt share write (`POST /conversations/:id/shares`)
// requires a minting linkId this hook's wrap-once flow does not carry, so the
// mutation rejects like a 404 after the client-side crypto runs. The crypto
// behaviors keep their coverage; the success-path tests return with the
// UI-alignment task's port of the flow.
describe('useMessageShare', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFromBase64.mockImplementation((b64) => new TextEncoder().encode(b64));
  });

  it('unwraps the content key and wraps it for share before rejecting unported', async () => {
    const epochKey = new Uint8Array([7, 7, 7]);
    const contentKey = new Uint8Array([8, 8, 8]);
    const fakeSecret = new Uint8Array([1, 2, 3]);
    const fakeWrapped = new Uint8Array([4, 5, 6]);

    mockGetEpochKey.mockReturnValue(epochKey);
    mockOpenMessageEnvelope.mockReturnValue(contentKey);
    mockCreateShare.mockReturnValue({
      shareSecret: fakeSecret,
      wrappedShareKey: fakeWrapped,
    });
    mockToBase64.mockReturnValue('base64');

    const { useMessageShare } = await import('@/hooks/chat/use-message-share.js');
    const { result } = renderHook(() => useMessageShare(), { wrapper: createWrapper() });

    await expect(
      result.current.mutateAsync({
        messageId: 'msg-123',
        conversationId: 'conv-1',
        epochNumber: 2,
        wrappedContentKey: 'base64-wrapped-content-key',
      })
    ).rejects.toMatchObject({ message: 'NOT_FOUND', status: 404 });

    expect(mockGetEpochKey).toHaveBeenCalledWith('conv-1', 2);
    expect(mockOpenMessageEnvelope).toHaveBeenCalledTimes(1);
    const [openArgumentKey] = mockOpenMessageEnvelope.mock.calls[0] as [Uint8Array, Uint8Array];
    expect(openArgumentKey).toBe(epochKey);
    expect(mockCreateShare).toHaveBeenCalledWith(contentKey);
  });

  it('throws when the epoch key is not available in the cache', async () => {
    mockGetEpochKey.mockReturnValue(null);

    const { useMessageShare } = await import('@/hooks/chat/use-message-share.js');
    const { result } = renderHook(() => useMessageShare(), { wrapper: createWrapper() });

    await expect(
      result.current.mutateAsync({
        messageId: 'msg-1',
        conversationId: 'conv-1',
        epochNumber: 1,
        wrappedContentKey: 'key-b64',
      })
    ).rejects.toThrow('Epoch key not available');

    expect(mockCreateShare).not.toHaveBeenCalled();
  });
});
