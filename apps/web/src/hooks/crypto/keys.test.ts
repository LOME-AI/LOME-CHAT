import { describe, it, expect, vi } from 'vitest';
import { keyKeys, keyChainQueryOptions } from '@/hooks/crypto/keys';

vi.mock('@/lib/api-client', () => ({
  client: {
    api: {
      keys: {
        ':conversationId': {
          $get: vi.fn(),
        },
      },
    },
  },
  fetchJson: vi.fn(),
}));

describe('keyKeys', () => {
  it('returns base key array', () => {
    expect(keyKeys.all).toEqual(['keys']);
  });

  it('returns chain key with conversationId', () => {
    expect(keyKeys.chain('conv-abc')).toEqual(['keys', 'conv-abc']);
  });

  it('returns batch key with the sorted conversation ids', () => {
    expect(keyKeys.batch(['conv-a', 'conv-b'])).toEqual(['keys', 'batch', ['conv-a', 'conv-b']]);
  });
});

describe('keyChainQueryOptions', () => {
  it('returns correct queryKey for a given conversationId', () => {
    const options = keyChainQueryOptions('conv-abc');
    expect(options.queryKey).toEqual(['keys', 'conv-abc']);
  });

  it('returns a callable queryFn', () => {
    const options = keyChainQueryOptions('conv-abc');
    expect(typeof options.queryFn).toBe('function');
  });

  it('returns staleTime of 1 hour', () => {
    const options = keyChainQueryOptions('conv-abc');
    expect(options.staleTime).toBe(1000 * 60 * 60);
  });

  it('uses the same queryKey as keyKeys.chain', () => {
    const options = keyChainQueryOptions('conv-xyz');
    expect(options.queryKey).toEqual(keyKeys.chain('conv-xyz'));
  });
});
