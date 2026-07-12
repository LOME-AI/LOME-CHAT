import { describe, it, expect } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

import { idempotencyKeyFor, idempotentHeaders } from '@/lib/idempotent-mutation.js';

function createWrapper(client: QueryClient): ({ children }: { children: ReactNode }) => ReactNode {
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
    return createElement(QueryClientProvider, { client }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

describe('idempotencyKeyFor', () => {
  it('returns the same key for the same variables reference', () => {
    const variables = { conversationId: 'conv-1' };
    expect(idempotencyKeyFor(variables)).toBe(idempotencyKeyFor(variables));
  });

  it('returns different keys for distinct variables objects', () => {
    expect(idempotencyKeyFor({ conversationId: 'conv-1' })).not.toBe(
      idempotencyKeyFor({ conversationId: 'conv-1' })
    );
  });
});

describe('idempotentHeaders', () => {
  it('wraps the key in a per-call headers object', () => {
    const variables = { conversationId: 'conv-1' };
    expect(idempotentHeaders(variables)).toEqual({
      headers: { 'Idempotency-Key': idempotencyKeyFor(variables) },
    });
  });
});

describe('reuse across a retried mutation', () => {
  it('sends the SAME key on a mutation that fails once then succeeds', async () => {
    const keysSeen: string[] = [];
    let attempts = 0;
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: 1, retryDelay: 0 } },
    });

    const { result } = renderHook(
      () =>
        useMutation({
          mutationFn: (variables: { conversationId: string }): Promise<string> => {
            attempts += 1;
            keysSeen.push(idempotencyKeyFor(variables));
            if (attempts === 1) return Promise.reject(new Error('transient'));
            return Promise.resolve('ok');
          },
        }),
      { wrapper: createWrapper(queryClient) }
    );

    await act(async () => {
      await result.current.mutateAsync({ conversationId: 'conv-1' });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(keysSeen).toHaveLength(2);
    expect(keysSeen[0]).toBe(keysSeen[1]);
  });
});
