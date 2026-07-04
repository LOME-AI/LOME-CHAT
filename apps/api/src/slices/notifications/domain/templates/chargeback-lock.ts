import { z } from 'zod';
import { BILLING_CONTACT_EMAIL } from '@hushbox/shared';
import { COLORS } from './base.js';
import { defineEmailTemplate } from './builder.js';

const schema = z.object({
  userName: z.string().optional(),
});

// The chargeback auto-lock is indefinite — it lifts only when the dispute is
// resolved, so this copy carries no lockout duration and points the user at
// billing support rather than telling them to wait.
export const chargebackLockEmail = defineEmailTemplate({
  schema,
  prepare: (params) => {
    const greeting = params.userName ? `Hi ${params.userName},` : 'Hi,';
    return { greeting };
  },
  html: `
    <h1 style="margin: 0 0 16px 0; color: ${COLORS.textPrimary}; font-size: 24px; font-weight: 600;">
      Account Locked
    </h1>
    <p style="margin: 0 0 8px 0; color: ${COLORS.textPrimary}; font-size: 16px; line-height: 1.5;">
      {{greeting}}
    </p>
    <p style="margin: 0 0 16px 0; color: ${COLORS.textSecondary}; font-size: 16px; line-height: 1.5;">
      Your HushBox account has been locked because of a payment dispute on a recent charge.
    </p>
    <p style="margin: 0; color: ${COLORS.textSecondary}; font-size: 14px; line-height: 1.5;">
      The lock stays in place until the dispute is resolved. Contact us at <a href="mailto:${BILLING_CONTACT_EMAIL}" style="color: ${COLORS.accent}; text-decoration: none;">${BILLING_CONTACT_EMAIL}</a> to resolve it.
    </p>
  `,
  text: `HushBox

Account Locked

{{greeting}}

Your HushBox account has been locked because of a payment dispute on a recent charge.

The lock stays in place until the dispute is resolved. Contact us at ${BILLING_CONTACT_EMAIL} to resolve it.

---
© 2026 LOME-AI LLC
Questions? hello@hushbox.ai
`,
});
