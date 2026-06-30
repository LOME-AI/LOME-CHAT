import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INPUTS_PREFIX } from '../ports/index.js';

/**
 * Config test for the staging-class backup safeguard: short-TTL inputs/
 * objects are client-encrypted run-scoped staging and must never reach the
 * Kopia → B2 backup. Asserts the backup workflow sets a kopia ignore policy
 * for the same prefix the key builders produce.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_WORKFLOW = path.resolve(HERE, '../../../../../../.github/workflows/backup.yml');

describe('backup config', () => {
  it('excludes the inputs/ staging prefix from the R2 backup snapshot', () => {
    const workflow = readFileSync(BACKUP_WORKFLOW, 'utf8');
    // Root-anchored kopia ignore pattern derived from the canonical prefix.
    const ignorePattern = `/${INPUTS_PREFIX}`;
    expect(workflow).toContain(`--add-ignore '${ignorePattern}'`);
  });
});
