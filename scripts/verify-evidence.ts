#!/usr/bin/env tsx
/**
 * Service Evidence Verification Script
 *
 * Verifies that required external services were actually called during CI.
 * Works with recordServiceEvidence() from @hushbox/db.
 *
 * Usage:
 *   pnpm verify:evidence --require=ai-gateway
 *   pnpm verify:evidence --require=ai-gateway,hookdeck
 */
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  verifyServiceEvidence,
  SERVICE_NAMES,
  type ServiceName,
} from '@hushbox/db';
import { isMainModule } from './lib/is-main.js';
import { parseOrExit } from './lib/run-cli.js';

const VALID_SERVICES = Object.values(SERVICE_NAMES);

export interface ParsedArgs {
  require: ServiceName[];
}

/**
 * Parse CLI arguments
 */
export function parseCliArgs(args: string[]): ParsedArgs | { error: string } {
  const requireArgument = args.find((argument) => argument.startsWith('--require='));

  if (!requireArgument) {
    return { error: 'Usage: pnpm verify:evidence --require=ai-gateway,hookdeck' };
  }

  const servicesRaw = requireArgument.replace('--require=', '');
  const services = servicesRaw.split(',').map((s) => s.trim()) as ServiceName[];

  for (const service of services) {
    if (!VALID_SERVICES.includes(service)) {
      return { error: `Invalid service: ${service}. Valid services: ${VALID_SERVICES.join(', ')}` };
    }
  }

  return { require: services };
}

/**
 * Format verification result for display
 */
export function formatResult(
  result: { success: boolean; missing: ServiceName[] },
  required: ServiceName[]
): string {
  if (result.success) {
    return `✓ Verified real service calls: ${required.join(', ')}`;
  }

  return [
    `✗ Missing evidence for: ${result.missing.join(', ')}`,
    '  Tests may have used mocks or been skipped.',
  ].join('\n');
}

/* v8 ignore start -- CLI entry point uses process.exit, tested via integration */
/**
 * Main CLI entry point
 */
async function main(): Promise<void> {
  const parsed = parseOrExit(parseCliArgs);

  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const db = createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });

  const result = await verifyServiceEvidence(db, parsed.require);
  await db.$client.end();
  const output = formatResult(result, parsed.require);

  if (result.success) {
    console.log(output);
  } else {
    console.error(output);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  void main();
}
/* v8 ignore stop */
