import { Marked } from 'marked';
import { z } from 'zod';
import { NEWSLETTER_POSTAL_ADDRESS } from '@hushbox/shared';
import { COLORS, wrapInBaseTemplate } from './base.js';
import { escapeHtml, heading } from './builder.js';
import type { EmailContent } from './builder.js';

const schema = z.object({
  subject: z.string(),
  bodyMarkdown: z.string(),
  unsubscribeUrl: z.string(),
});

export type NewsletterIssueParams = z.input<typeof schema>;

// A dedicated instance: the module-level `marked` singleton carries global
// option state that another consumer could mutate; this one is ours alone.
// Synchronous by construction — no async extensions are registered, so
// `parse(…, { async: false })` returns a string.
const markdownRenderer = new Marked({ gfm: true });

/**
 * Hand-composed rather than `defineEmailTemplate`: the builder HTML-escapes
 * every `{{placeholder}}` value, which would destroy the markdown-rendered
 * HTML. Composing directly against `wrapInBaseTemplate` keeps the builder's
 * escaping contract intact (ordinary values still pass through `escapeHtml`
 * here by hand) while injecting the rendered body verbatim.
 */
export function newsletterIssueEmail(params: NewsletterIssueParams): EmailContent {
  const validated = schema.parse(params);
  const bodyHtml = markdownRenderer.parse(validated.bodyMarkdown, { async: false });

  const html = wrapInBaseTemplate(`${heading(1, escapeHtml(validated.subject))}
    <div style="color: ${COLORS.textPrimary}; font-size: 16px; line-height: 1.6;">
      ${bodyHtml}
    </div>
    <p style="margin: 32px 0 0 0; padding-top: 16px; border-top: 1px solid ${COLORS.border}; color: ${COLORS.textSecondary}; font-size: 12px; line-height: 1.5;">
      HushBox · ${escapeHtml(NEWSLETTER_POSTAL_ADDRESS)}
    </p>
    <p style="margin: 4px 0 0 0; color: ${COLORS.textSecondary}; font-size: 12px; line-height: 1.5;">
      You're receiving this because you subscribed at hushbox.ai.
    </p>
    <p style="margin: 4px 0 0 0; font-size: 12px; line-height: 1.5;">
      <a href="${escapeHtml(validated.unsubscribeUrl)}" style="color: ${COLORS.textSecondary};">Unsubscribe</a>
    </p>
  `);

  const text = `HushBox

${validated.subject}

${validated.bodyMarkdown}

---
HushBox · ${NEWSLETTER_POSTAL_ADDRESS}
You're receiving this because you subscribed at hushbox.ai.
Unsubscribe: ${validated.unsubscribeUrl}
`;

  return { html, text };
}
