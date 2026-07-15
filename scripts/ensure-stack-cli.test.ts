import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { statSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLocalSqlProvisionTarget, buildOptions } from './ensure-stack-cli.js';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const CLI = path.join(SCRIPTS_DIR, 'ensure-stack-cli.ts');
const DEV_VARS = path.join(REPO_ROOT, 'apps', 'api', '.dev.vars');

function mtimeMsOrNull(filePath: string): number | null {
  if (!existsSync(filePath)) return null;
  return statSync(filePath).mtimeMs;
}

describe('ensure-stack-cli CI behavior', () => {
  // The CLI must not touch env files when CI is set. The workflow's
  // generate:env step has already written CI-mode env files; a regen here
  // would overwrite them with Mode.Development values and drop the
  // GitHub-secret bindings the tests rely on.
  it('exits cleanly without rewriting apps/api/.dev.vars when CI=1', async () => {
    if (!existsSync(DEV_VARS)) {
      writeFileSync(DEV_VARS, '# placeholder for ensure-stack-cli.test\n');
    }
    const before = mtimeMsOrNull(DEV_VARS);

    const result = await execa('tsx', [CLI], {
      env: { ...process.env, CI: '1' },
      reject: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('CI no-op');
    const after = mtimeMsOrNull(DEV_VARS);
    expect(after).toBe(before);
  }, 30_000);
});

describe('buildOptions HB_STACK_SLOT validation', () => {
  const originalSlot = process.env['HB_STACK_SLOT'];
  const originalPort = process.env['HB_IDLE_DAEMON_PORT'];

  beforeEach(() => {
    // Satisfy the validation that follows the slot guard so the tests fail
    // (or pass) on the slot behavior alone.
    process.env['HB_IDLE_DAEMON_PORT'] = '8787';
  });

  afterEach(() => {
    if (originalSlot === undefined) delete process.env['HB_STACK_SLOT'];
    else process.env['HB_STACK_SLOT'] = originalSlot;
    if (originalPort === undefined) delete process.env['HB_IDLE_DAEMON_PORT'];
    else process.env['HB_IDLE_DAEMON_PORT'] = originalPort;
  });

  it('defaults to slot 0 when HB_STACK_SLOT is absent', () => {
    delete process.env['HB_STACK_SLOT'];

    expect(buildOptions({ pristine: false, wipe: false }).slot).toBe(0);
  });

  it('throws when HB_STACK_SLOT is empty', () => {
    process.env['HB_STACK_SLOT'] = '';

    expect(() => buildOptions({ pristine: false, wipe: false })).toThrow('invalid HB_STACK_SLOT');
  });

  it('throws when HB_STACK_SLOT is whitespace-only', () => {
    process.env['HB_STACK_SLOT'] = '   ';

    expect(() => buildOptions({ pristine: false, wipe: false })).toThrow('invalid HB_STACK_SLOT');
  });

  it('throws when HB_STACK_SLOT is fractional', () => {
    process.env['HB_STACK_SLOT'] = '1.5';

    expect(() => buildOptions({ pristine: false, wipe: false })).toThrow('invalid HB_STACK_SLOT');
  });
});

describe('assertLocalSqlProvisionTarget', () => {
  it('admits loopback database hosts', () => {
    expect(() => {
      assertLocalSqlProvisionTarget('postgres://user:pw@localhost:4444/hushbox');
    }).not.toThrow();
    expect(() => {
      assertLocalSqlProvisionTarget('postgres://user:pw@127.0.0.1:5432/hushbox');
    }).not.toThrow();
  });

  it('refuses a non-local database host (cannot run against production)', () => {
    expect(() => {
      assertLocalSqlProvisionTarget('postgres://user:pw@ep-prod.neon.tech/hushbox');
    }).toThrow(/local/);
  });

  it('refuses an unparseable database url', () => {
    expect(() => {
      assertLocalSqlProvisionTarget('not-a-url');
    }).toThrow();
  });
});
