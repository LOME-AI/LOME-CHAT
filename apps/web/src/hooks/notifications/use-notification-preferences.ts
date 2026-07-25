import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { client, fetchJson } from '@/lib/api-client';
import { useStableSession } from '@/hooks/auth/use-stable-session';
import type { InferRequestType, InferResponseType } from 'hono/client';

/** Account-level notification settings, typed from the route that serves them. */
export type NotificationPreferences = InferResponseType<
  typeof client.notifications.preferences.$get,
  200
>;

/** The write shape: the whole preferences object, replaced in one call. */
export type NotificationPreferencesUpdate = InferRequestType<
  typeof client.notifications.preferences.$put
>['json'];

export const notificationPreferencesKeys = {
  preferences: ['notification-preferences'] as const,
};

/**
 * `GET /notifications/preferences` requires a session, so the query stays
 * disabled until auth has settled — a refetch racing a logout would 401.
 */
export function useNotificationPreferences(): UseQueryResult<NotificationPreferences> {
  const { isAuthenticated } = useStableSession();
  return useQuery<NotificationPreferences>({
    queryKey: notificationPreferencesKeys.preferences,
    queryFn: () => fetchJson(client.notifications.preferences.$get()),
    enabled: isAuthenticated,
  });
}

interface UpdateContext {
  previous: NotificationPreferences | undefined;
}

/**
 * `PUT /notifications/preferences` replaces the whole object and is naturally
 * idempotent, so callers send every field and no `Idempotency-Key` is needed.
 * The optimistic write keeps the switches from lagging the click; the server's
 * echo still wins on success, since it is the row that decides delivery.
 */
export function useUpdateNotificationPreferences(): UseMutationResult<
  NotificationPreferences,
  Error,
  NotificationPreferencesUpdate,
  UpdateContext
> {
  const queryClient = useQueryClient();
  return useMutation<NotificationPreferences, Error, NotificationPreferencesUpdate, UpdateContext>({
    mutationFn: (variables: NotificationPreferencesUpdate): Promise<NotificationPreferences> =>
      fetchJson(client.notifications.preferences.$put({ json: variables })),
    onMutate: async (variables): Promise<UpdateContext> => {
      await queryClient.cancelQueries({ queryKey: notificationPreferencesKeys.preferences });
      const previous = queryClient.getQueryData<NotificationPreferences>(
        notificationPreferencesKeys.preferences
      );
      queryClient.setQueryData<NotificationPreferences>(
        notificationPreferencesKeys.preferences,
        variables
      );
      return { previous };
    },
    onError: (_error, _variables, context): void => {
      if (context !== undefined) {
        queryClient.setQueryData(notificationPreferencesKeys.preferences, context.previous);
      }
    },
    onSuccess: (data): void => {
      queryClient.setQueryData(notificationPreferencesKeys.preferences, data);
    },
  });
}
