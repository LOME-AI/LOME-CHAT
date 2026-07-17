import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { requestUrl } from '@/test-utils/request-url';
import { modelsKeys, useModels } from './use-models.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const MODELS = {
  models: [
    {
      modelId: 'openai/gpt-5',
      name: 'GPT-5',
      family: 'language',
      zdrReachable: true,
      adminDisabledAt: null,
    },
  ],
  truncated: false,
};

function wrapper({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('modelsKeys', () => {
  it('namespaces the models query key under admin', () => {
    expect(modelsKeys.all).toEqual(['admin', 'models']);
  });
});

describe('useModels', () => {
  it('fetches the model catalog through the typed client', async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(Response.json(MODELS, { status: 200 }))
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useModels(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.models[0]?.modelId).toBe('openai/gpt-5');
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toContain('/api/admin/models');
  });

  it('rejects a drifting wire shape loudly instead of rendering garbage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ models: 'nope' }, { status: 200 })))
    );

    const { result } = renderHook(() => useModels(), { wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});
