import type { Context } from 'hono';
import type { EvidenceConfig } from '@hushbox/db';
import type { EnvUtilities } from '@hushbox/shared';
import type { AppEnv } from '../types.js';

/**
 * Bundle the dependencies any external-service factory needs to record
 * evidence after a successful real API call. Used by every middleware that
 * wires a service which records evidence (today: aiClientMiddleware,
 * helcimMiddleware).
 *
 * `recordServiceEvidence` itself gates the write on `isCI === true`; this
 * helper just collects the inputs from Hono context.
 *
 * Fail-fast on missing `envUtils`: every production caller runs after
 * `envMiddleware()`, so a missing binding indicates a test harness skipped
 * the middleware chain. Tests that need this should call
 * `createEnvUtilities(c.env)` directly per the "Environment Detection"
 * guidance in `docs/CODE-RULES.md` rather than getting a silent `isCI: false`
 * fallback that hides setup bugs.
 */
export function createEvidenceConfig(c: Context<AppEnv>): EvidenceConfig {
  // Cast to `EnvUtilities | undefined`: the typed Variables interface declares
  // envUtils as non-optional because the production middleware chain always
  // sets it via `envMiddleware()`. Tests that bypass middleware (e.g.
  // evidence-config.test.ts's "envUtils missing" case) genuinely observe
  // undefined here, so the runtime guard below is real defense, not dead
  // code — even though the type system insists it can't happen.
  const envUtilities = c.get('envUtils') as EnvUtilities | undefined;
  if (envUtilities === undefined) {
    throw new Error(
      'createEvidenceConfig requires envUtils — run envMiddleware() or call createEnvUtilities(c.env) in test setup'
    );
  }
  return {
    db: c.get('db'),
    isCI: envUtilities.isCI,
  };
}
