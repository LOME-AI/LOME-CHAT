import { z } from 'zod';
import { COLORS } from './base.js';
import { defineEmailTemplate } from './builder.js';

const schema = z.object({
  opName: z.string(),
  actorEmail: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  reason: z.string(),
  occurredAt: z.string(),
  isUndo: z.boolean(),
  auditId: z.string(),
});

/**
 * Subjects live beside the template (not in the composing adapter, unlike the
 * user-facing templates) because the op subject varies by input — the digest
 * cron and per-mutation sender consume both as one contract.
 */
export function adminOpNotificationSubject(params: {
  readonly opName: string;
  readonly isUndo: boolean;
}): string {
  const prefix = params.isUndo ? 'Undo executed' : 'Operation executed';
  return `HushBox Admin — ${prefix}: ${params.opName}`;
}

export const adminOpNotificationEmail = defineEmailTemplate({
  schema,
  prepare: (params) => ({
    heading: params.isUndo ? 'Admin Undo Executed' : 'Admin Operation Executed',
    opName: params.opName,
    actorEmail: params.actorEmail,
    target: `${params.targetType} ${params.targetId}`,
    reason: params.reason,
    occurredAt: params.occurredAt,
    auditId: params.auditId,
  }),
  html: `
    <h1 style="margin: 0 0 16px 0; color: ${COLORS.textPrimary}; font-size: 24px; font-weight: 600;">
      {{heading}}
    </h1>
    <p style="margin: 0 0 8px 0; color: ${COLORS.textPrimary}; font-size: 16px; line-height: 1.5;">
      {{opName}}
    </p>
    <p style="margin: 0 0 4px 0; color: ${COLORS.textSecondary}; font-size: 14px; line-height: 1.5;">
      Actor: {{actorEmail}}
    </p>
    <p style="margin: 0 0 4px 0; color: ${COLORS.textSecondary}; font-size: 14px; line-height: 1.5;">
      Target: {{target}}
    </p>
    <p style="margin: 0 0 4px 0; color: ${COLORS.textSecondary}; font-size: 14px; line-height: 1.5;">
      Reason: {{reason}}
    </p>
    <p style="margin: 0 0 16px 0; color: ${COLORS.textSecondary}; font-size: 14px; line-height: 1.5;">
      At: {{occurredAt}}
    </p>
    <p style="margin: 0; color: ${COLORS.textSecondary}; font-size: 12px; line-height: 1.5;">
      Audit record: {{auditId}}
    </p>
  `,
  text: `HushBox

{{heading}}

{{opName}}

Actor: {{actorEmail}}
Target: {{target}}
Reason: {{reason}}
At: {{occurredAt}}

Audit record: {{auditId}}

---
© 2026 LOME-AI LLC
Questions? hello@hushbox.ai
`,
});
