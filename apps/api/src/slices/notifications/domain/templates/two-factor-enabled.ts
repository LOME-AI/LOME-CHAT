import { z } from 'zod';
import { COLORS } from './base.js';
import { defineEmailTemplate, heading, paragraph } from './builder.js';

const schema = z.object({
  userName: z.string().optional(),
});

export const twoFactorEnabledEmail = defineEmailTemplate({
  schema,
  prepare: (params) => {
    const greeting = params.userName ? `Hi ${params.userName},` : 'Hi,';
    return { greeting };
  },
  html: `${heading(1, 'Two-Factor Authentication Enabled')}${paragraph({
    text: '{{greeting}}',
    tone: 'primary',
    marginBottom: 8,
  })}${paragraph({
    text: "Two-factor authentication has been enabled on your account. You'll need your authenticator app to sign in from now on.",
  })}${paragraph({
    text: `If you didn't enable this, contact us immediately at <a href="mailto:security@hushbox.ai" style="color: ${COLORS.accent}; text-decoration: none;">security@hushbox.ai</a>`,
    fontSize: 12,
    marginBottom: 0,
  })}
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
