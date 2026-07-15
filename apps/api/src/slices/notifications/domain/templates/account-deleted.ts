import { z } from 'zod';
import { COLORS } from './base.js';
import { defineEmailTemplate, heading, paragraph } from './builder.js';

// Generic by design — the user record is gone by the time this sends.
const schema = z.object({});

export const accountDeletedEmail = defineEmailTemplate({
  schema,
  prepare: () => ({}),
  html: `${heading(1, 'Account Permanently Deleted')}${paragraph({
    text: 'Your HushBox account has been permanently deleted. All conversations, messages, projects, and stored media have been removed from our servers.',
  })}${paragraph({
    text: 'Financial records (payments, wallet ledger entries, usage history) are retained for audit and tax purposes, with your account identifier removed.',
    fontSize: 14,
  })}${paragraph({
    text: `If this wasn't you, your account may have been compromised. Contact us immediately at <a href="mailto:security@hushbox.ai" style="color: ${COLORS.accent}; text-decoration: none;">security@hushbox.ai</a>`,
    fontSize: 12,
    marginBottom: 0,
  })}
  `,
  text: `HushBox

Account Permanently Deleted

Your HushBox account has been permanently deleted. All conversations, messages, projects, and stored media have been removed from our servers.

Financial records (payments, wallet ledger entries, usage history) are retained for audit and tax purposes, with your account identifier removed.

If this wasn't you, your account may have been compromised. Contact us immediately at security@hushbox.ai

---
© 2026 LOME-AI LLC
Questions? hello@hushbox.ai
`,
});
