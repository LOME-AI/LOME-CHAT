import { useMutation, useQueryClient } from '@tanstack/react-query';
import { client, fetchJson } from '@/lib/api-client.js';
import { idempotentHeaders } from '@/lib/idempotent-mutation.js';
import { linkKeys } from '@/hooks/realtime/use-conversation-links.js';

interface GuestNameInput {
  conversationId: string;
  displayName: string;
}

interface AdminNameInput {
  conversationId: string;
  linkId: string;
  displayName: string;
}

/**
 * A link guest renames its own display label via `PATCH
 * /conversations/:id/my-name`. The link credential rides the request
 * automatically (api-client's `X-Link-Public-Key` header), exactly like every
 * other guest call. The route is server-side `naturally-idempotent`, so the
 * `Idempotency-Key` is belt-and-suspenders — harmless and ignored.
 */
export function useGuestLinkName(): ReturnType<
  typeof useMutation<{ success: true }, Error, GuestNameInput>
> {
  return useMutation({
    mutationFn: (input: GuestNameInput) =>
      fetchJson<{ success: true }>(
        client.conversations[':conversationId']['my-name'].$patch(
          {
            param: { conversationId: input.conversationId },
            json: { displayName: input.displayName },
          },
          idempotentHeaders(input)
        )
      ),
  });
}

/**
 * Admin renames a link's display label via `PATCH
 * /conversations/:id/links/:linkId/name`.
 */
export function useAdminLinkName(): ReturnType<
  typeof useMutation<{ success: true }, Error, AdminNameInput>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AdminNameInput) =>
      fetchJson<{ success: true }>(
        client.conversations[':conversationId'].links[':linkId'].name.$patch(
          {
            param: { conversationId: input.conversationId, linkId: input.linkId },
            json: { displayName: input.displayName },
          },
          idempotentHeaders(input)
        )
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: linkKeys.list(variables.conversationId),
      });
    },
  });
}
