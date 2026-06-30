import { z } from 'zod';
import { COLORS } from './base.js';
import { defineEmailTemplate } from './builder.js';

const schema = z.object({
  userName: z.string().optional(),
});

export const passwordChangedEmail = defineEmailTemplate({
  schema,
  prepare: (params) => {
    const greeting = params.userName ? `Hi ${params.userName},` : 'Hi,';
    return { greeting };
  },
  html: `
    <h1 style="margin: 0 0 16px 0; color: ${COLORS.textPrimary}; font-size: 24px; font-weight: 600;">
      Password Changed
    </h1>
    <p style="margin: 0 0 8px 0; color: ${COLORS.textPrimary}; font-size: 16px; line-height: 1.5;">
      {{greeting}}
    </p>
    <p style="margin: 0 0 16px 0; color: ${COLORS.textSecondary}; font-size: 16px; line-height: 1.5;">
      Your password was just changed. All other sessions have been signed out.
    </p>
    <p style="margin: 0 0 16px 0; color: ${COLORS.textSecondary}; font-size: 14px; line-height: 1.5;">
      If this was you, no action is needed.
    </p>
    <p style="margin: 0; color: ${COLORS.textSecondary}; font-size: 12px; line-height: 1.5;">
      If you didn't change your password, your account may be compromised. Contact us immediately at <a href="mailto:security@hushbox.ai" style="color: ${COLORS.accent}; text-decoration: none;">security@hushbox.ai</a>
    </p>
  `,
  text: `HushBox

Password Changed

{{greeting}}

Your password was just changed. All other sessions have been signed out.

If this was you, no action is needed.

If you didn't change your password, your account may be compromised. Contact us immediately at security@hushbox.ai

---
© 2026 LOME-AI LLC
Questions? hello@hushbox.ai
`,
});
