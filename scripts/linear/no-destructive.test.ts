import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Delete-free by construction: the autonomous grooming CLI must never reference
 * a destructive Linear operation. This reads every non-test source file in the
 * directory and asserts none names a delete/archive/unarchive method — a
 * structural guarantee the write path can only mutate, never destroy. It reads
 * the SOURCE files only (excluding `*.test.ts`) so the blocklist below does not
 * match this test itself.
 */
const DESTRUCTIVE = /\.(delete|archive|unarchive)\s*\(|\b(delete|archive|unarchive)[A-Za-z]*\s*\(/;

const here = path.dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

describe('linear grooming CLI is delete-free', () => {
  it('has source files to scan', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it.each(sources)('%s references no destructive SDK method', (file) => {
    const content = readFileSync(path.join(here, file), 'utf8');
    expect(DESTRUCTIVE.test(content)).toBe(false);
  });
});

describe('the destructive guard regex', () => {
  it.each(['client.deleteWebhook(', 'issue.archive(', 'client.unarchiveProject('])(
    'catches a destructive call: %s',
    (sample) => {
      expect(DESTRUCTIVE.test(sample)).toBe(true);
    }
  );

  it('does not match the word "delete" when it is not a call', () => {
    expect(DESTRUCTIVE.test('an intentional bulk delete).')).toBe(false);
  });
});
