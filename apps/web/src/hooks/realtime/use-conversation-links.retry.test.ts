import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

// Retry/replay contract for the link mutations: the server dedups a retried
// request by its stable Idempotency-Key and keeps the FIRST attempt's stored
// key material. Every attempt must therefore carry byte-identical key material
// (linkPublicKey, memberWrap, rotation wraps) and the same Idempotency-Key —
// the mint-once-per-logical-mutation discipline. Key material lives inside the
// stable `variables` object minted by the caller, never re-randomized in
// `mutationFn`.

const mockPost = vi.fn<(payload: unknown, headers?: unknown) => Response>();
const mockPatch = vi.fn<(payload: unknown, headers?: unknown) => Response>();
const mockFetchJson = vi.fn<(input: unknown) => Promise<unknown>>();

vi.mock('@/lib/api-client.js', () => ({
  client: {
    conversations: {
      [':conversationId']: {
        links: {
          $post: (payload: unknown, headers?: unknown) => mockPost(payload, headers),
          [':linkId']: {
            privilege: {
              $patch: (payload: unknown, headers?: unknown) => mockPatch(payload, headers),
            },
          },
        },
      },
    },
  },
  fetchJson: (input: unknown) => mockFetchJson(input),
}));

import { useCreateLink, useChangeLinkPrivilege } from '@/hooks/realtime/use-conversation-links.js';

interface HeaderCarrier {
  headers: { 'Idempotency-Key': string };
}

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: 1, retryDelay: 0 },
    },
  });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

describe('link mutation retry contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('useCreateLink resends identical key material and Idempotency-Key on retry', async () => {
    mockFetchJson
      .mockRejectedValueOnce(new Error('network failure after server persisted'))
      .mockResolvedValueOnce({ linkId: 'link-1' });

    const { result } = renderHook(() => useCreateLink(), { wrapper: createWrapper() });

    await result.current.mutateAsync({
      conversationId: 'c1',
      linkPublicKey: 'pk-b64',
      memberWrap: 'wrap-b64',
      privilege: 'read',
      giveFullHistory: true,
      rotation: {
        expectedEpoch: 1,
        epochPublicKey: 'epoch-pk-b64',
        confirmationHash: 'hash-b64',
        chainLink: 'chain-b64',
        memberWraps: [{ memberPublicKey: 'member-pk-b64', wrap: 'member-wrap-b64' }],
        encryptedTitle: 'title-b64',
      },
    });

    expect(mockPost).toHaveBeenCalledTimes(2);
    const [firstPayload, firstHeaders] = mockPost.mock.calls[0]!;
    const [retryPayload, retryHeaders] = mockPost.mock.calls[1]!;
    expect(retryPayload).toEqual(firstPayload);
    expect((retryHeaders as HeaderCarrier).headers['Idempotency-Key']).toBe(
      (firstHeaders as HeaderCarrier).headers['Idempotency-Key']
    );
  });

  it('useChangeLinkPrivilege resends an identical request and Idempotency-Key on retry', async () => {
    mockFetchJson
      .mockRejectedValueOnce(new Error('network failure after server persisted'))
      .mockResolvedValueOnce({ ok: true });

    const { result } = renderHook(() => useChangeLinkPrivilege(), { wrapper: createWrapper() });

    await result.current.mutateAsync({
      conversationId: 'c1',
      linkId: 'link-1',
      privilege: 'write',
    });

    expect(mockPatch).toHaveBeenCalledTimes(2);
    const [firstPayload, firstHeaders] = mockPatch.mock.calls[0]!;
    const [retryPayload, retryHeaders] = mockPatch.mock.calls[1]!;
    expect(retryPayload).toEqual(firstPayload);
    expect((retryHeaders as HeaderCarrier).headers['Idempotency-Key']).toBe(
      (firstHeaders as HeaderCarrier).headers['Idempotency-Key']
    );
  });
});
