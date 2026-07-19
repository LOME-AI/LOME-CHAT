import { useQuery } from '@tanstack/react-query';
import { normalizeUsername } from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client.js';

export const userSearchKeys = {
  all: ['user-search'] as const,
  search: (query: string, conversationId?: string) =>
    [...userSearchKeys.all, query, conversationId] as const,
};

export function useUserSearch(
  query: string,
  options?: { excludeConversationId?: string }
): ReturnType<typeof useQuery> {
  const normalizedQuery = normalizeUsername(query);
  const conversationId = options?.excludeConversationId;
  return useQuery({
    queryKey: userSearchKeys.search(normalizedQuery, conversationId),
    queryFn: () =>
      fetchJson(
        client.account.users.search.$get({
          query: { q: normalizedQuery, conversationId: conversationId ?? '' },
        })
      ),
    // The rebuilt search is conversation-scoped: `conversationId` is required.
    enabled: normalizedQuery.length >= 2 && conversationId !== undefined,
  });
}
