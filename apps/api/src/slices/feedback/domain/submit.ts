import { z } from 'zod';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { feedbackDuplicateError } from './errors.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { FeedbackStore, FeedbackSubmission } from '../ports/index.js';

/**
 * The replayable POST /feedback response. `byKey` re-validates it when
 * replaying a stored response, so it must describe exactly what the handler
 * serializes.
 */
export const submitFeedbackResponseSchema = z.object({ id: z.uuid() });

export type SubmitFeedbackResponse = z.infer<typeof submitFeedbackResponseSchema>;

/**
 * Persist one feedback note for `userId`. The body is already boundary-validated
 * (`submitFeedbackBodySchema`); persistence is the whole job, so this is a thin
 * seam over the single-writer store — submit is NOT naturally idempotent (two
 * submits are two rows), so the route dedups it with `idempotent.byKey`.
 *
 * The store's conditional insert suppresses an identical body resubmitted inside
 * the dedup window (resolving `null`); that becomes a `FEEDBACK_DUPLICATE`
 * refusal here rather than a silent no-op, so the client learns the note already
 * landed instead of seeing a second success.
 */
export function submitFeedback(
  store: FeedbackStore,
  userId: string,
  input: FeedbackSubmission
): ResultAsync<SubmitFeedbackResponse, DomainError> {
  return store
    .insert(userId, input)
    .andThen((inserted) =>
      inserted === null ? errAsync(feedbackDuplicateError()) : okAsync(inserted)
    );
}
