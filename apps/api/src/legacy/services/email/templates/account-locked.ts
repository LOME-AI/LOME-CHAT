import { z } from 'zod';
import { COLORS } from './base.js';
import { defineEmailTemplate } from './builder.js';

const schema = z.object({
  userName: z.string().optional(),
  lockoutMinutes: z.number(),
});

export const accountLockedEmail = defineEmailTemplate({
  schema,
  prepare: (params) => {
    const greeting = params.userName ? `Hi ${params.userName},` : 'Hi,';
    const lockoutMinutes = String(params.lockoutMinutes);
    return { greeting, lockoutMinutes };
  },
  html: `
    <h1 style="margin: 0 0 16px 0; color: ${COLORS.textPrimary}; font-size: 24px; font-weight: 600;">
      Account Temporarily Locked
    </h1>
    <p style="margin: 0 0 8px 0; color: ${COLORS.textPrimary}; font-size: 16px; line-height: 1.5;">
      {{greeting}}
    </p>
    <p style="margin: 0 0 16px 0; color: ${COLORS.textSecondary}; font-size: 16px; line-height: 1.5;">
      Your HushBox account has been temporarily locked due to multiple failed sign-in attempts.
    </p>
    <p style="margin: 0 0 16px 0; color: ${COLORS.textSecondary}; font-size: 14px; line-height: 1.5;">
      You can try again in {{lockoutMinutes}} minutes.
    </p>
    <p style="margin: 0; color: ${COLORS.textSecondary}; font-size: 12px; line-height: 1.5;">
      If this wasn't you, someone may be trying to access your account. We recommend changing your password when the lockout expires.
    </p>
  `,
  text: `HushBox

Account Temporarily Locked

{{greeting}}

Your HushBox account has been temporarily locked due to multiple failed sign-in attempts.

You can try again in {{lockoutMinutes}} minutes.

If this wasn't you, someone may be trying to access your account. We recommend changing your password when the lockout expires.

---
© 2026 LOME-AI LLC
Questions? hello@hushbox.ai
`,
});
