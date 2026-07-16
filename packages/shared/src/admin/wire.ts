import { z } from 'zod';

/**
 * Wire envelopes the admin slice's op routes emit, re-validated by the SPA
 * before use (the shared-Zod response re-validation mechanic). These schemas
 * DESCRIBE the existing wire — the server side of each shape lives in the
 * admin routes' `describeContract`/`previewResponse` and the engine's
 * `AdminOpRunResult`; a change there must change these together.
 */

/** Guardrail caps as they cross JSON: money serialized as a NanoUSD string. */
export const adminOpGuardrailsWireSchema = z.object({
  maxAmountNanoUsd: z
    .string()
    .regex(/^\d+$/, 'maxAmountNanoUsd must be a decimal NanoUSD string')
    .optional(),
  maxTargets: z.number().int().optional(),
  rateLimitKey: z.string().optional(),
});
export type AdminOpGuardrailsWire = z.infer<typeof adminOpGuardrailsWireSchema>;

/** One `GET /admin/ops` catalog entry — drives the ops table, palette, and form. */
export const adminOpWireSchema = z.object({
  name: z.string(),
  title: z.string(),
  kind: z.enum(['mutation', 'read']),
  effectClass: z.enum(['durable', 'ephemeral']),
  inverse: z.string().nullable(),
  fields: z.array(z.string()),
  guardrails: adminOpGuardrailsWireSchema.optional(),
});
export type AdminOpWire = z.infer<typeof adminOpWireSchema>;

/** The `GET /admin/ops` response envelope. */
export const adminOpsCatalogSchema = z.object({
  ops: z.array(adminOpWireSchema),
});
export type AdminOpsCatalog = z.infer<typeof adminOpsCatalogSchema>;

/** One effect row from the engine's dry-run/committed change list. */
export const adminOpEffectSchema = z.object({
  label: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type AdminOpEffect = z.infer<typeof adminOpEffectSchema>;

/** Preview response: the rolled-back run minus its (never-leaked) audit id. */
export const adminOpPreviewResultSchema = z.object({
  effects: z.array(adminOpEffectSchema),
  inverseInput: z.record(z.string(), z.unknown()).nullable(),
});
export type AdminOpPreviewResult = z.infer<typeof adminOpPreviewResultSchema>;

/** Execute response: the committed run, audit row id included. */
export const adminOpExecuteResultSchema = z.object({
  auditId: z.uuid(),
  effects: z.array(adminOpEffectSchema),
  inverseInput: z.record(z.string(), z.unknown()).nullable(),
});
export type AdminOpExecuteResult = z.infer<typeof adminOpExecuteResultSchema>;

/**
 * Read-surface wire schemas (dashboard + Customer 360). Server shapes:
 * apps/api admin slice `read-surface.ts` / `customer-360.ts` — a change there
 * must change these together. Money crosses as signed NanoUSD strings
 * (negative balances are legal states).
 */

/** Signed nano-USD wire string — display-only on the SPA side. */
const signedNanoUsdWire = z.string().regex(/^-?\d+$/, 'expected a signed decimal NanoUSD string');

export const adminJobCountsWireSchema = z.object({
  pending: z.number().int(),
  running: z.number().int(),
  dead: z.number().int(),
  discarded: z.number().int(),
});
export type AdminJobCountsWire = z.infer<typeof adminJobCountsWireSchema>;

/** One `admin_audit` row as the read surface serializes it. */
export const adminAuditRowWireSchema = z.object({
  id: z.string(),
  actor: z.string(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  details: z.unknown(),
  undoes: z.string().nullable(),
  undoneBy: z.string().nullable(),
  createdAt: z.string(),
});
export type AdminAuditRowWire = z.infer<typeof adminAuditRowWireSchema>;

/**
 * The details shape the engine writes for an executed effect (mirrors the
 * engine's own undo-target gate): rows matching it are undoable when their
 * op has a registered inverse and no undo has claimed them yet.
 */
export const adminAuditExecutedDetailsSchema = z.object({
  effects: z.array(z.unknown()),
  inverseInput: z.record(z.string(), z.unknown()).nullable(),
});
export type AdminAuditExecutedDetails = z.infer<typeof adminAuditExecutedDetailsSchema>;

/** The `GET /admin/dashboard` envelope. */
export const dashboardWireSchema = z.object({
  jobs: adminJobCountsWireSchema,
  recentActions: z.array(adminAuditRowWireSchema),
});
export type DashboardWire = z.infer<typeof dashboardWireSchema>;

/** A Customer-360 panel: loaded, or failed on its own with an error code. */
function panelSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]);
}

export const customer360MoneyPanelSchema = z.object({
  balance: z.object({
    purchasedNanoUsd: signedNanoUsdWire,
    freeNanoUsd: signedNanoUsdWire,
    allowance: z.object({
      day: z.string(),
      limitNanoUsd: signedNanoUsdWire,
      spentNanoUsd: signedNanoUsdWire,
      remainingNanoUsd: signedNanoUsdWire,
    }),
  }),
  recentLedger: z.array(
    z.object({
      createdAt: z.string(),
      kind: z.string(),
      amountNanoUsd: signedNanoUsdWire,
      balanceAfterNanoUsd: signedNanoUsdWire,
    })
  ),
});
export type Customer360MoneyPanel = z.infer<typeof customer360MoneyPanelSchema>;

export const customer360UsagePanelSchema = z.object({
  models: z.array(
    z.object({
      modelId: z.string(),
      totalNanoUsd: signedNanoUsdWire,
      recordCount: z.number().int(),
      estimatedCount: z.number().int(),
    })
  ),
});
export type Customer360UsagePanel = z.infer<typeof customer360UsagePanelSchema>;

export const customer360ConversationsPanelSchema = z.object({
  owned: z.number().int(),
  activeMemberships: z.number().int(),
});
export type Customer360ConversationsPanel = z.infer<typeof customer360ConversationsPanelSchema>;

export const adminJobRowWireSchema = z.object({
  id: z.string(),
  type: z.string(),
  shard: z.string(),
  status: z.string(),
  discarded: z.boolean(),
  failures: z.number().int(),
  claims: z.number().int(),
  payload: z.unknown(),
  errors: z.array(z.object({ at: z.string(), claim: z.number().int(), error: z.string() })),
  nextAttemptAt: z.string(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type AdminJobRowWire = z.infer<typeof adminJobRowWireSchema>;

/** The `GET /admin/users/overview` view: safe header + independent panels. */
export const customer360ViewSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    username: z.string(),
    emailVerified: z.boolean(),
    totpEnabled: z.boolean(),
    lockedAt: z.string().nullable(),
    hasAcknowledgedPhrase: z.boolean(),
  }),
  panels: z.object({
    money: panelSchema(customer360MoneyPanelSchema),
    usage: panelSchema(customer360UsagePanelSchema),
    conversations: panelSchema(customer360ConversationsPanelSchema),
    jobs: panelSchema(z.object({ jobs: z.array(adminJobRowWireSchema) })),
    adminHistory: panelSchema(z.object({ actions: z.array(adminAuditRowWireSchema) })),
  }),
});
export type Customer360View = z.infer<typeof customer360ViewSchema>;
export type Customer360Panel<T> = { ok: true; data: T } | { ok: false; error: string };
