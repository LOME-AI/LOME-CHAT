import { z } from 'zod';
import { COLORS } from './base.js';
import { defineEmailTemplate, heading, paragraph } from './builder.js';

const schema = z.object({
  userName: z.string().optional(),
});

export const passwordResetEmail = defineEmailTemplate({
  schema,
  prepare: (params) => {
    const greeting = params.userName ? `Hi ${params.userName},` : 'Hi,';
    return { greeting };
  },
  html: `${heading(1, 'Password Reset')}${paragraph({
    text: '{{greeting}}',
    tone: 'primary',
    marginBottom: 8,
  })}${paragraph({
    text: 'Your password was just reset with your recovery phrase. All other sessions have been signed out.',
  })}${paragraph({
    text: 'If this was you, no action is needed — sign in with your new password.',
    fontSize: 14,
  })}${paragraph({
    text: `If you didn't reset your password, your account may be compromised. Contact us immediately at <a href="mailto:security@hushbox.ai" style="color: ${COLORS.accent}; text-decoration: none;">security@hushbox.ai</a>`,
    fontSize: 12,
    marginBottom: 0,
  })}
  `,
  text: `HushBox

Password Reset

{{greeting}}

Your password was just reset with your recovery phrase. All other sessions have been signed out.

If this was you, no action is needed — sign in with your new password.

If you didn't reset your password, your account may be compromised. Contact us immediately at security@hushbox.ai

---
© 2026 LOME-AI LLC
Questions? hello@hushbox.ai
`,
});
