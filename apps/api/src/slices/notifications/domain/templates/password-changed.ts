import { z } from 'zod';
import { COLORS } from './base.js';
import { defineEmailTemplate, heading, paragraph } from './builder.js';

const schema = z.object({
  userName: z.string().optional(),
});

export const passwordChangedEmail = defineEmailTemplate({
  schema,
  prepare: (params) => {
    const greeting = params.userName ? `Hi ${params.userName},` : 'Hi,';
    return { greeting };
  },
  html: `${heading(1, 'Password Changed')}${paragraph({
    text: '{{greeting}}',
    tone: 'primary',
    marginBottom: 8,
  })}${paragraph({
    text: 'Your password was just changed. All other sessions have been signed out.',
  })}${paragraph({
    text: 'If this was you, no action is needed.',
    fontSize: 14,
  })}${paragraph({
    text: `If you didn't change your password, your account may be compromised. Contact us immediately at <a href="mailto:security@hushbox.ai" style="color: ${COLORS.accent}; text-decoration: none;">security@hushbox.ai</a>`,
    fontSize: 12,
    marginBottom: 0,
  })}
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
