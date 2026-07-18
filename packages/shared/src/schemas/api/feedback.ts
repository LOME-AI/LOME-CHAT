import { z } from 'zod';
import { FeedbackKind, FEEDBACK_BODY_MAX_LENGTH } from '../../feedback.js';

/**
 * Request body for POST /feedback — the in-app feedback composer's submission.
 * `body` is plaintext product feedback (not conversation content), trimmed and
 * bounded so an empty or oversized note is rejected at the boundary.
 */
export const submitFeedbackBodySchema = z.object({
  kind: FeedbackKind,
  body: z.string().trim().min(1).max(FEEDBACK_BODY_MAX_LENGTH),
});

export type SubmitFeedbackBody = z.infer<typeof submitFeedbackBodySchema>;
