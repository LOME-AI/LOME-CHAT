import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from './client';
import { serviceEvidence } from './schema/service-evidence';
import {
  recordServiceEvidence,
  verifyServiceEvidence,
  SERVICE_NAMES,
  type ServiceName,
} from './evidence';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

describe('evidence', () => {
  let db: Database;
  // The dev database is shared with concurrent runs: every row this suite
  // writes carries the run-unique prefix, and cleanup deletes only those rows.
  const testRunId = `test-${String(Date.now())}`;

  beforeAll(() => {
    db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
  });

  afterAll(async () => {
    await db.delete(serviceEvidence).where(eq(serviceEvidence.service, `${testRunId}-ai-gateway`));
    await db.delete(serviceEvidence).where(eq(serviceEvidence.service, `${testRunId}-hookdeck`));
    await db.$client.end();
  });

  describe('SERVICE_NAMES', () => {
    it('exports expected service names', () => {
      expect(SERVICE_NAMES.AI_GATEWAY).toBe('ai-gateway');
      expect(SERVICE_NAMES.HELCIM).toBe('helcim');
      expect(SERVICE_NAMES.HOOKDECK).toBe('hookdeck');
      expect(SERVICE_NAMES.LINEAR).toBe('linear');
    });

    it('exports R2 storage, R2 GC and billing-mismatch service names', () => {
      expect(SERVICE_NAMES.R2_STORAGE).toBe('r2-storage');
      expect(SERVICE_NAMES.R2_GC).toBe('r2-gc');
      expect(SERVICE_NAMES.BILLING_MISMATCH).toBe('billing-mismatch');
    });

    it('exports the resend email service name', () => {
      expect(SERVICE_NAMES.RESEND).toBe('resend');
    });

    it('exports the openrouter service name alongside the existing ai-gateway name', () => {
      expect(SERVICE_NAMES.OPENROUTER).toBe('openrouter');
      expect(SERVICE_NAMES.AI_GATEWAY).toBe('ai-gateway');
    });

    it('has correct type inference', () => {
      const name: ServiceName = SERVICE_NAMES.AI_GATEWAY;
      expect(name).toBe('ai-gateway');
    });
  });

  describe('recordServiceEvidence', () => {
    it('does nothing when isCI is false', async () => {
      const testService = `${testRunId}-ai-gateway` as ServiceName;

      await recordServiceEvidence(db, false, testService);

      const rows = await db
        .select()
        .from(serviceEvidence)
        .where(eq(serviceEvidence.service, testService));

      expect(rows).toHaveLength(0);
    });

    it('inserts record when isCI is true', async () => {
      const testService = `${testRunId}-ai-gateway` as ServiceName;

      await recordServiceEvidence(db, true, testService);

      const rows = await db
        .select()
        .from(serviceEvidence)
        .where(eq(serviceEvidence.service, testService));

      expect(rows).toHaveLength(1);
      expect(rows[0]?.service).toBe(testService);
      expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    });

    it('stores details when provided', async () => {
      const testService = `${testRunId}-hookdeck` as ServiceName;
      const details = { requestId: '123', status: 'success' };

      await recordServiceEvidence(db, true, testService, details);

      const rows = await db
        .select()
        .from(serviceEvidence)
        .where(eq(serviceEvidence.service, testService));

      expect(rows).toHaveLength(1);
      expect(rows[0]?.details).toEqual(details);
    });

    it('allows multiple records for same service', async () => {
      const testService = `${testRunId}-ai-gateway` as ServiceName;

      await recordServiceEvidence(db, true, testService);
      await recordServiceEvidence(db, true, testService);

      const rows = await db
        .select()
        .from(serviceEvidence)
        .where(eq(serviceEvidence.service, testService));

      expect(rows.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('verifyServiceEvidence', () => {
    beforeEach(async () => {
      await recordServiceEvidence(db, true, `${testRunId}-ai-gateway` as ServiceName);
    });

    it('returns success when all required services have evidence', async () => {
      const result = await verifyServiceEvidence(db, [`${testRunId}-ai-gateway` as ServiceName]);

      expect(result.success).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it('returns failure with missing services', async () => {
      const result = await verifyServiceEvidence(db, [
        `${testRunId}-ai-gateway` as ServiceName,
        `${testRunId}-nonexistent` as ServiceName,
      ]);

      expect(result.success).toBe(false);
      expect(result.missing).toContain(`${testRunId}-nonexistent`);
    });

    it('returns success for empty required list', async () => {
      const result = await verifyServiceEvidence(db, []);

      expect(result.success).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it('handles multiple required services', async () => {
      await recordServiceEvidence(db, true, `${testRunId}-hookdeck` as ServiceName);

      const result = await verifyServiceEvidence(db, [
        `${testRunId}-ai-gateway` as ServiceName,
        `${testRunId}-hookdeck` as ServiceName,
      ]);

      expect(result.success).toBe(true);
      expect(result.missing).toHaveLength(0);
    });
  });
});
