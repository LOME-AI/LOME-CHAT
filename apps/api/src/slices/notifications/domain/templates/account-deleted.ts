import { z } from 'zod';
import { COLORS } from './base.js';
import { defineEmailTemplate } from './builder.js';

// Generic by design — the user record is gone by the time this sends.
const schema = z.object({});

export const accountDeletedEmail = defineEmailTemplate({
  schema,
  prepare: () => ({}),
  html: `
    <h1 style="margin: 0 0 16px 0; color: ${COLORS.textPrimary}; font-size: 24px; font-weight: 600;">
      Account Permanently Deleted
    </h1>
    <p style="margin: 0 0 16px 0; color: ${COLORS.textSecondary}; font-size: 16px; line-height: 1.5;">
      Your HushBox account has been permanently deleted. All conversations, messages, projects, and stored media have been removed from our servers.
    </p>
    <p style="margin: 0 0 16px 0; color: ${COLORS.textSecondary}; font-size: 14px; line-height: 1.5;">
      Financial records (payments, wallet ledger entries, usage history) are retained for audit and tax purposes, with your account identifier removed.
    </p>
    <p style="margin: 0; color: ${COLORS.textSecondary}; font-size: 12px; line-height: 1.5;">
      If this wasn't you, your account may have been compromised. Contact us immediately at <a href="mailto:security@hushbox.ai" style="color: ${COLORS.accent}; text-decoration: none;">security@hushbox.ai</a>
    </p>
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
