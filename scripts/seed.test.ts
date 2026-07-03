import { describe, it, expect, afterEach } from 'vitest';
import { execa } from 'execa';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SEED_NOT_DEFINED_MESSAGE,
  SEED_REMOTE_REFUSAL_MESSAGE,
  runSeedPlaceholder,
} from './seed.js';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SEED_CLI = path.join(SCRIPTS_DIR, 'seed.ts');

describe('runSeedPlaceholder', () => {
  it('throws the not-defined error', () => {
    expect(() => runSeedPlaceholder()).toThrow(SEED_NOT_DEFINED_MESSAGE);
  });

  it('names the redesigned schema in the message', () => {
    expect(SEED_NOT_DEFINED_MESSAGE).toContain(
      'seed data for the redesigned schema is not yet defined'
    );
  });

  it('does not reference any legacy path in the message', () => {
    expect(SEED_NOT_DEFINED_MESSAGE).not.toMatch(/legacy/i);
  });

  it('says what must happen in the message', () => {
    expect(SEED_NOT_DEFINED_MESSAGE).toContain('Define seed data');
  });
});

describe('runSeedPlaceholder remote-DB guard', () => {
  const original = process.env['DATABASE_URL'];
  afterEach(() => {
    if (original === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = original;
  });

  it('refuses a remote (non-local) DATABASE_URL before reaching the not-defined state', () => {
    process.env['DATABASE_URL'] = 'postgres://user:pass@db.prod.neon.tech/hushbox';
    expect(() => runSeedPlaceholder()).toThrow(SEED_REMOTE_REFUSAL_MESSAGE);
  });

  it('refuses an unparseable DATABASE_URL (fails closed)', () => {
    process.env['DATABASE_URL'] = 'not a valid url';
    expect(() => runSeedPlaceholder()).toThrow(SEED_REMOTE_REFUSAL_MESSAGE);
  });

  it('falls through to not-defined for a 127.0.0.1 DATABASE_URL', () => {
    process.env['DATABASE_URL'] = 'postgres://postgres:postgres@127.0.0.1:4444/hushbox';
    expect(() => runSeedPlaceholder()).toThrow(SEED_NOT_DEFINED_MESSAGE);
  });

  it('falls through to not-defined for a bracketed IPv6 loopback DATABASE_URL', () => {
    process.env['DATABASE_URL'] = 'postgres://postgres:postgres@[::1]:5432/hushbox';
    expect(() => runSeedPlaceholder()).toThrow(SEED_NOT_DEFINED_MESSAGE);
  });

  it('falls through to not-defined when DATABASE_URL is unset', () => {
    delete process.env['DATABASE_URL'];
    expect(() => runSeedPlaceholder()).toThrow(SEED_NOT_DEFINED_MESSAGE);
  });
});

describe('seed CLI entry point', () => {
  it('exits with code 1', async () => {
    const result = await execa('tsx', [SEED_CLI], { reject: false });
    expect(result.exitCode).toBe(1);
  }, 30_000);

  it('prints the not-defined error to stderr', async () => {
    const result = await execa('tsx', [SEED_CLI], { reject: false });
    expect(result.stderr).toContain('seed data for the redesigned schema is not yet defined');
  }, 30_000);
});
