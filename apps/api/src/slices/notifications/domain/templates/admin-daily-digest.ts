import { z } from 'zod';
import { COLORS } from './base.js';
import { defineEmailTemplate } from './builder.js';

const actionSchema = z.object({
  opName: z.string(),
  actorEmail: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  occurredAt: z.string(),
});

export type AdminDigestAction = z.input<typeof actionSchema>;

const schema = z.object({
  day: z.string(),
  actions: z.array(actionSchema),
});

export function adminDailyDigestSubject(params: { readonly day: string }): string {
  return `HushBox Admin — Daily audit digest for ${params.day}`;
}

function formatAction(action: z.output<typeof actionSchema>): string {
  return `${action.occurredAt} — ${action.opName} by ${action.actorEmail} on ${action.targetType} ${action.targetId}`;
}

// The builder escapes every html placeholder, so the variable-length action
// list renders as escaped text lines inside a pre-line container — list
// markup cannot pass through a placeholder by design.
export const adminDailyDigestEmail = defineEmailTemplate({
  schema,
  prepare: (params) => {
    const count = params.actions.length;
    const plural = count === 1 ? '' : 's';
    return {
      day: params.day,
      summary:
        count === 0
          ? 'No admin actions were executed.'
          : `${String(count)} admin action${plural} executed.`,
      actionLines:
        count === 0
          ? 'No admin actions.'
          : params.actions.map((action) => formatAction(action)).join('\n'),
    };
  },
  html: `
    <h1 style="margin: 0 0 16px 0; color: ${COLORS.textPrimary}; font-size: 24px; font-weight: 600;">
      Daily Admin Digest
    </h1>
    <p style="margin: 0 0 8px 0; color: ${COLORS.textPrimary}; font-size: 16px; line-height: 1.5;">
      {{day}}
    </p>
    <p style="margin: 0 0 16px 0; color: ${COLORS.textSecondary}; font-size: 14px; line-height: 1.5;">
      {{summary}}
    </p>
    <p style="margin: 0; color: ${COLORS.textSecondary}; font-size: 13px; line-height: 1.8; white-space: pre-line; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;">{{actionLines}}</p>
  `,
  text: `HushBox

Daily Admin Digest — {{day}}

{{summary}}

{{actionLines}}

---
© 2026 LOME-AI LLC
Questions? hello@hushbox.ai
`,
});
