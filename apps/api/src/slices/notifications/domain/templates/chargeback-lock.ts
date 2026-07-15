import { z } from 'zod';
import { BILLING_CONTACT_EMAIL } from '@hushbox/shared';
import { COLORS } from './base.js';
import { defineEmailTemplate, heading, paragraph } from './builder.js';

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
  html: `${heading(1, 'Account Locked')}${paragraph({
    text: '{{greeting}}',
    tone: 'primary',
    marginBottom: 8,
  })}${paragraph({
    text: 'Your HushBox account has been locked because of a payment dispute on a recent charge.',
  })}${paragraph({
    text: `The lock stays in place until the dispute is resolved. Contact us at <a href="mailto:${BILLING_CONTACT_EMAIL}" style="color: ${COLORS.accent}; text-decoration: none;">${BILLING_CONTACT_EMAIL}</a> to resolve it.`,
    fontSize: 14,
    marginBottom: 0,
  })}
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
