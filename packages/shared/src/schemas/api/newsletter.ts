import { z } from 'zod';

/** Request body for the public newsletter signup (anonymous, pre-confirm). */
export const newsletterSubscribeBodySchema = z.object({
  email: z.email(),
});

export type NewsletterSubscribeBody = z.infer<typeof newsletterSubscribeBodySchema>;

/** Request body for the double-opt-in confirmation link. */
export const newsletterConfirmBodySchema = z.object({
  token: z.string().min(1),
});

export type NewsletterConfirmBody = z.infer<typeof newsletterConfirmBodySchema>;

/** Request body for the one-click unsubscribe link. */
export const newsletterUnsubscribeBodySchema = z.object({
  token: z.string().min(1),
});

export type NewsletterUnsubscribeBody = z.infer<typeof newsletterUnsubscribeBodySchema>;

/** Request body for the signed-in settings toggle. */
export const newsletterSettingsBodySchema = z.object({
  subscribed: z.boolean(),
});

export type NewsletterSettingsBody = z.infer<typeof newsletterSettingsBodySchema>;

/** Response for the signed-in settings read/toggle. */
export const newsletterSettingsResponseSchema = z.object({
  subscribed: z.boolean(),
});

export type NewsletterSettingsResponse = z.infer<typeof newsletterSettingsResponseSchema>;

/**
 * Enumeration-safe acknowledgement: the public signup always answers the
 * same shape whether the address is new, already subscribed, or suppressed,
 * so the endpoint cannot be used to probe the list.
 */
export const newsletterSubscribeResponseSchema = z.object({
  ok: z.literal(true),
});

export type NewsletterSubscribeResponse = z.infer<typeof newsletterSubscribeResponseSchema>;

/** Acknowledgement for a successful confirmation. */
export const newsletterConfirmResponseSchema = z.object({
  ok: z.literal(true),
});

export type NewsletterConfirmResponse = z.infer<typeof newsletterConfirmResponseSchema>;

/** Acknowledgement for a successful unsubscribe. */
export const newsletterUnsubscribeResponseSchema = z.object({
  ok: z.literal(true),
});

export type NewsletterUnsubscribeResponse = z.infer<typeof newsletterUnsubscribeResponseSchema>;
