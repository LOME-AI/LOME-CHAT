import { z } from 'zod';
import { defineEmailTemplate, heading, paragraph } from './builder.js';

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
  html: `${heading(1, 'Account Temporarily Locked')}${paragraph({
    text: '{{greeting}}',
    tone: 'primary',
    marginBottom: 8,
  })}${paragraph({
    text: 'Your HushBox account has been temporarily locked due to multiple failed sign-in attempts.',
  })}${paragraph({
    text: 'You can try again in {{lockoutMinutes}} minutes.',
    fontSize: 14,
  })}${paragraph({
    text: "If this wasn't you, someone may be trying to access your account. We recommend changing your password when the lockout expires.",
    fontSize: 12,
    marginBottom: 0,
  })}
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
