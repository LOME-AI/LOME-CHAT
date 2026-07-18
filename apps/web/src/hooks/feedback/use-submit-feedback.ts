import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { client, fetchJson } from '@/lib/api-client';
import { idempotentHeaders } from '@/lib/idempotent-mutation';
import type { SubmitFeedbackBody } from '@hushbox/shared';

/**
 * Submit in-app product feedback (`POST /feedback`). The route requires an
 * `Idempotency-Key`; `idempotentHeaders` mints one per logical `mutate()` call
 * and reuses it across TanStack retries. No query invalidation — feedback has no
 * cached client state to refresh.
 */
export function useSubmitFeedback(): UseMutationResult<void, Error, SubmitFeedbackBody> {
  return useMutation({
    mutationFn: async (variables: SubmitFeedbackBody): Promise<void> => {
      await fetchJson<unknown>(
        client.feedback.$post({ json: variables }, idempotentHeaders(variables))
      );
    },
  });
}
