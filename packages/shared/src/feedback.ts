import { z } from 'zod';

/**
 * The closed set of in-app feedback kinds. One source feeding the pgEnum, the
 * Zod contracts, and the admin wire schemas — adding a member is a deliberate
 * enum migration, never ad-hoc data.
 */
export const FEEDBACK_KINDS = ['bug', 'idea', 'praise'] as const;

/**
 * Maximum length of a feedback body. Single source for the composer's soft
 * counter and the API schema's `.max()` bound — the client shows a truncation
 * notice past it and sends only the first `FEEDBACK_BODY_MAX_LENGTH` characters.
 */
export const FEEDBACK_BODY_MAX_LENGTH = 4000;

/** Zod schema for feedback-kind validation. */
export const FeedbackKind = z.enum(FEEDBACK_KINDS);

/** TypeScript type for a feedback kind. */
export type FeedbackKind = z.infer<typeof FeedbackKind>;

/**
 * The closed set of feedback triage statuses. Feeds the pgEnum, the admin
 * `feedback.setStatus` op input, and the admin wire schemas.
 */
export const FEEDBACK_STATUSES = ['new', 'triaged', 'resolved', 'wont_fix', 'spam'] as const;

/** Zod schema for feedback-status validation. */
export const FeedbackStatus = z.enum(FEEDBACK_STATUSES);

/** TypeScript type for a feedback status. */
export type FeedbackStatus = z.infer<typeof FeedbackStatus>;
