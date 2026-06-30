import { z } from 'zod';
import { COLORS } from './base.js';
import { defineEmailTemplate } from './builder.js';

const schema = z.object({
  userName: z.string().optional(),
});

export const twoFactorEnabledEmail = defineEmailTemplate({
  schema,
  prepare: (params) => {
    const greeting = params.userName ? `Hi ${params.userName},` : 'Hi,';
    return { greeting };
  },
  html: `
    <h1 style="margin: 0 0 16px 0; color: ${COLORS.textPrimary}; font-size: 24px; font-weight: 600;">
      Two-Factor Authentication Enabled
    </h1>
    <p style="margin: 0 0 8px 0; color: ${COLORS.textPrimary}; font-size: 16px; line-height: 1.5;">
      {{greeting}}
    </p>
    <p style="margin: 0 0 16px 0; color: ${COLORS.textSecondary}; font-size: 16px; line-height: 1.5;">
      Two-factor authentication has been enabled on your account. You'll need your authenticator app to sign in from now on.
    </p>
    <p style="margin: 0; color: ${COLORS.textSecondary}; font-size: 12px; line-height: 1.5;">
      If you didn't enable this, contact us immediately at <a href="mailto:security@hushbox.ai" style="color: ${COLORS.accent}; text-decoration: none;">security@hushbox.ai</a>
    </p>
  `,
  text: `HushBox

Two-Factor Authentication Enabled

{{greeting}}

Two-factor authentication has been enabled on your account. You'll need your authenticator app to sign in from now on.

If you didn't enable this, contact us immediately at security@hushbox.ai

---
© 2026 LOME-AI LLC
Questions? hello@hushbox.ai
`,
});
