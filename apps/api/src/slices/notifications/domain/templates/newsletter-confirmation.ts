import { z } from 'zod';
import { COLORS } from './base.js';
import { defineEmailTemplate, heading, paragraph } from './builder.js';

const schema = z.object({
  confirmUrl: z.string(),
});

// Transactional double-opt-in email: deliberately no postal address and no
// unsubscribe link — CAN-SPAM exempts transactional mail, and an unsubscribe
// link on an unconfirmed address would be a subscription-state footgun.
export const newsletterConfirmationEmail = defineEmailTemplate({
  schema,
  prepare: (params) => ({ confirmUrl: params.confirmUrl }),
  html: `${heading(1, 'Confirm your subscription')}
${paragraph({
  text: 'You (or some scoundrel with your email address) asked to join the HushBox mailing list. Either way, nothing happens until you confirm.',
  marginBottom: 32,
})}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 32px 0;">
      <tr>
        <td align="center" style="background-color: ${COLORS.accent}; border-radius: 8px;">
          <a href="{{confirmUrl}}" style="display: inline-block; padding: 16px 32px; color: #ffffff; font-size: 16px; font-weight: 600; text-decoration: none; min-width: 120px; text-align: center;">
            Confirm subscription
          </a>
        </td>
      </tr>
    </table>
    <p style="margin: 0; color: ${COLORS.textSecondary}; font-size: 14px;">
      This link expires in 24 hours.
    </p>
    <p style="margin: 16px 0 0 0; color: ${COLORS.textSecondary}; font-size: 12px; line-height: 1.5;">
      Not you? Ignore this email and we'll never write again.
    </p>
  `,
  text: `HushBox

Confirm your subscription

You (or some scoundrel with your email address) asked to join the HushBox mailing list. Either way, nothing happens until you confirm.

Confirm by visiting this link:
{{confirmUrl}}

This link expires in 24 hours.

Not you? Ignore this email and we'll never write again.

---
© 2026 LOME-AI LLC
Questions? hello@hushbox.ai
`,
});
