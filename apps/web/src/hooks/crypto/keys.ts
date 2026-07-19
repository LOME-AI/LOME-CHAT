import { client, fetchJson } from '@/lib/api-client';
import type { KeyChainResponse } from '@/lib/epoch-key-cache';

export const keyKeys = {
  all: ['keys'] as const,
  chain: (conversationId: string): readonly ['keys', string] =>
    [...keyKeys.all, conversationId] as const,
  batch: (conversationIds: readonly string[]) =>
    [...keyKeys.all, 'batch', conversationIds] as const,
};

/** Reusable query options for a conversation's key chain. Shared by hooks and route loaders. */
export function keyChainQueryOptions(conversationId: string): {
  queryKey: readonly ['keys', string];
  queryFn: () => Promise<KeyChainResponse>;
  staleTime: number;
} {
  return {
    queryKey: keyKeys.chain(conversationId),
    queryFn: async (): Promise<KeyChainResponse> => {
      return fetchJson<KeyChainResponse>(
        client.conversations[':conversationId'].keychain.$get({ param: { conversationId } })
      );
    },
    staleTime: 1000 * 60 * 60,
  };
}
