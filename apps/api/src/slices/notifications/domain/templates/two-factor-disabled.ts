import { z } from 'zod';
import { COLORS } from './base.js';
import { defineEmailTemplate, heading, paragraph } from './builder.js';

const schema = z.object({
  userName: z.string().optional(),
});

export const twoFactorDisabledEmail = defineEmailTemplate({
  schema,
  prepare: (params) => {
    const greeting = params.userName ? `Hi ${params.userName},` : 'Hi,';
    return { greeting };
  },
  html: `${heading(1, 'Two-Factor Authentication Disabled')}${paragraph({
    text: '{{greeting}}',
    tone: 'primary',
    marginBottom: 8,
  })}${paragraph({
    text: 'Two-factor authentication has been removed from your account. Your account is now protected by password only.',
  })}${paragraph({
    text: 'We recommend re-enabling 2FA in your account settings for maximum security.',
    fontSize: 14,
  })}${paragraph({
    text: `If you didn't disable this, contact us immediately at <a href="mailto:security@hushbox.ai" style="color: ${COLORS.accent}; text-decoration: none;">security@hushbox.ai</a>`,
    fontSize: 12,
    marginBottom: 0,
  })}
  `,
  text: `HushBox

Two-Factor Authentication Disabled

{{greeting}}

Two-factor authentication has been removed from your account. Your account is now protected by password only.

We recommend re-enabling 2FA in your account settings for maximum security.

If you didn't disable this, contact us immediately at security@hushbox.ai

---
© 2026 LOME-AI LLC
Questions? hello@hushbox.ai
`,
});
