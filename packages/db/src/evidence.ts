import { serviceEvidence } from './schema/service-evidence';
import type { Database } from './client';

export const SERVICE_NAMES = {
  AI_GATEWAY: 'ai-gateway',
  OPENROUTER: 'openrouter',
  HELCIM: 'helcim',
  HOOKDECK: 'hookdeck',
  LINEAR: 'linear',
  R2_STORAGE: 'r2-storage',
  R2_GC: 'r2-gc',
  BILLING_MISMATCH: 'billing-mismatch',
  RESEND: 'resend',
} as const;

export type ServiceName = (typeof SERVICE_NAMES)[keyof typeof SERVICE_NAMES];

/**
 * The evidence row is only written when `isCI === true`: real-adapter seams
 * call this after a successful real external API call, and CI's
 * `verify:evidence` step later asserts the rows exist. Production sees
 * `isCI === false` and skips the write.
 */
export async function recordServiceEvidence(
  db: Database,
  isCI: boolean,
  service: ServiceName,
  details?: Record<string, unknown>
): Promise<void> {
  if (!isCI) return;

  await db.insert(serviceEvidence).values({
    service,
    details: details ?? null,
  });
}

export async function verifyServiceEvidence(
  db: Database,
  required: ServiceName[]
): Promise<{ success: boolean; missing: ServiceName[] }> {
  if (required.length === 0) return { success: true, missing: [] };

  const rows = await db.selectDistinct({ service: serviceEvidence.service }).from(serviceEvidence);

  const found = new Set(rows.map((r) => r.service));
  const missing = required.filter((s) => !found.has(s));

  return { success: missing.length === 0, missing };
}
