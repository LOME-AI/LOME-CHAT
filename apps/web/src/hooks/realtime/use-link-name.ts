import { useMutation, useQueryClient } from '@tanstack/react-query';
import { unportedEndpoint } from '@/lib/unported-endpoint.js';
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
 * UNPORTED: the rebuilt backend exposes only `GET /conversations/:id/my-name`
 * (the read); there is no guest display-name mutation route yet. The hook
 * keeps its contract so the rename UI compiles; it fails like a 404 until the
 * backend mounts the mutation.
 */
export function useGuestLinkName(): ReturnType<
  typeof useMutation<{ success: true }, Error, GuestNameInput>
> {
  return useMutation({
    mutationFn: (_input: GuestNameInput) =>
      unportedEndpoint('PATCH /api/links/:conversationId/my-name'),
  });
}

/**
 * UNPORTED: no admin link-rename route exists on the rebuilt backend (links
 * carry `displayName` only at mint time via `POST /conversations/:id/links`).
 */
export function useAdminLinkName(): ReturnType<
  typeof useMutation<{ success: true }, Error, AdminNameInput>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (_input: AdminNameInput) =>
      unportedEndpoint('PATCH /api/links/:conversationId/:linkId/name'),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: linkKeys.list(variables.conversationId),
      });
    },
  });
}
