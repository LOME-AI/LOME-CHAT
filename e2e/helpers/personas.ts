import { test } from '@playwright/test';
import {
  pooledPersonaName,
  TEST_PERSONAS,
  testPersonaName,
  type E2EProjectName,
} from '../../scripts/seed.js';

/**
 * Project- AND worker-aware persona email. Must be called inside a test/fixture
 * — reads `test.info()` lazily. Pooled personas (alice/bob/dave) resolve to the
 * current Playwright worker's isolated copy via `parallelIndex`, so a test's
 * page identity and every email/username reference to that persona stay
 * consistent within the worker while never colliding with another worker's
 * wallet. `test-alice` + project `chromium` on worker 0 →
 * `test-alice-chromium@test.hushbox.ai`; on worker 3 →
 * `test-alice-w3-chromium@test.hushbox.ai`.
 */
export function personaEmail(baseName: string, projectName?: string): string {
  const project = projectName ?? test.info().project.name;
  const resolved = pooledPersonaName(baseName, test.info().parallelIndex);
  return `${resolved}-${project}@test.hushbox.ai`;
}

/**
 * Project- and worker-aware persona SQL username — single source of truth is the
 * seeded `TEST_PERSONAS` array in `scripts/seed.ts`. Resolves the current
 * worker's pooled copy first (see {@link personaEmail}), then looks up its
 * username. Route display-string lookups through this helper so search/login
 * matches exactly one seeded user.
 */
export function personaUsername(baseName: string, projectName?: string): string {
  const project = (projectName ?? test.info().project.name) as E2EProjectName;
  const resolved = pooledPersonaName(baseName, test.info().parallelIndex);
  const fullName = testPersonaName(resolved, project);
  const persona = TEST_PERSONAS.find((p) => p.name === fullName);
  if (!persona) {
    throw new Error(
      `personaUsername: no seeded persona for "${fullName}" (baseName=${baseName}, project=${project})`
    );
  }
  return persona.username;
}
