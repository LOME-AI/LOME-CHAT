import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryResult,
  type UseMutationResult,
} from '@tanstack/react-query';
import { client, fetchJson } from '@/lib/api-client';
import type { NewsletterSettingsBody, NewsletterSettingsResponse } from '@hushbox/shared';

export const newsletterKeys = {
  settings: ['newsletter-settings'] as const,
};

export function useNewsletterSettings(): UseQueryResult<NewsletterSettingsResponse> {
  return useQuery<NewsletterSettingsResponse>({
    queryKey: newsletterKeys.settings,
    queryFn: () => fetchJson(client.newsletter.me.$get()),
  });
}

interface UpdateContext {
  previous: NewsletterSettingsResponse | undefined;
}

/**
 * `PUT /newsletter/me` is naturally idempotent — no `Idempotency-Key` header.
 * The response is server truth, not an echo: a complaint-suppressed subscriber
 * toggling on gets `{subscribed: false}` back, so `onSuccess` always overwrites
 * the optimistic cache entry with the server's answer instead of trusting the
 * requested value.
 */
export function useUpdateNewsletterSettings(): UseMutationResult<
  NewsletterSettingsResponse,
  Error,
  NewsletterSettingsBody,
  UpdateContext
> {
  const queryClient = useQueryClient();
  return useMutation<NewsletterSettingsResponse, Error, NewsletterSettingsBody, UpdateContext>({
    mutationFn: (variables: NewsletterSettingsBody): Promise<NewsletterSettingsResponse> =>
      fetchJson(client.newsletter.me.$put({ json: variables })),
    onMutate: async (variables): Promise<UpdateContext> => {
      await queryClient.cancelQueries({ queryKey: newsletterKeys.settings });
      const previous = queryClient.getQueryData<NewsletterSettingsResponse>(
        newsletterKeys.settings
      );
      queryClient.setQueryData<NewsletterSettingsResponse>(newsletterKeys.settings, {
        subscribed: variables.subscribed,
      });
      return { previous };
    },
    onError: (_error, _variables, context): void => {
      if (context !== undefined) {
        queryClient.setQueryData(newsletterKeys.settings, context.previous);
      }
    },
    onSuccess: (data): void => {
      queryClient.setQueryData(newsletterKeys.settings, data);
    },
  });
}
