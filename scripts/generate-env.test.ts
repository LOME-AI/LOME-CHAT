import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateEnvFiles } from './generate-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = resolve(__dirname, '__test-fixtures__');

describe('generateEnvFiles', () => {
  beforeEach(() => {
    // Create test directory structure
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(join(TEST_DIR, 'apps/api'), { recursive: true });

    // Create minimal wrangler.toml
    writeFileSync(
      join(TEST_DIR, 'apps/api/wrangler.toml'),
      `# Wrangler configuration
name = "test-api"
main = "src/index.ts"

[dev]
port = 8787
`
    );

    // Suppress console output during tests
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    // Clean up test directory
    rmSync(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('generates .env.development', () => {
    it('creates the file', () => {
      generateEnvFiles(TEST_DIR);

      expect(existsSync(join(TEST_DIR, '.env.development'))).toBe(true);
    });

    it('includes header comment', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, '.env.development'), 'utf-8');
      expect(content).toContain('Auto-generated');
      expect(content).toContain('pnpm generate:env');
    });

    it('includes all vars with development values', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, '.env.development'), 'utf-8');
      expect(content).toContain('NODE_ENV=development');
      expect(content).toContain('BETTER_AUTH_URL=http://localhost:8787');
    });

    it('includes all secrets with development values', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, '.env.development'), 'utf-8');
      expect(content).toContain(
        'DATABASE_URL=postgres://postgres:postgres@localhost:4444/lome_chat'
      );
      expect(content).toContain('BETTER_AUTH_SECRET=');
      expect(content).toContain('RESEND_API_KEY=');
    });

    it('includes all frontend vars with development values', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, '.env.development'), 'utf-8');
      expect(content).toContain('VITE_API_URL=http://localhost:8787');
    });

    it('includes localOnly vars', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, '.env.development'), 'utf-8');
      expect(content).toContain(
        'MIGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/lome_chat'
      );
      expect(content).toContain('# Local only');
    });
  });

  describe('generates .dev.vars', () => {
    it('creates the file', () => {
      generateEnvFiles(TEST_DIR);

      expect(existsSync(join(TEST_DIR, 'apps/api/.dev.vars'))).toBe(true);
    });

    it('includes header comment', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, 'apps/api/.dev.vars'), 'utf-8');
      expect(content).toContain('Auto-generated');
    });

    it('includes only workerVars', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, 'apps/api/.dev.vars'), 'utf-8');
      expect(content).toContain('NODE_ENV=development');
      expect(content).toContain('DATABASE_URL=');
      expect(content).toContain('BETTER_AUTH_URL=');
      expect(content).toContain('BETTER_AUTH_SECRET=');
      // RESEND_API_KEY is empty in dev, so it may or may not be included
    });

    it('does not include VITE_ vars (frontend only)', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, 'apps/api/.dev.vars'), 'utf-8');
      expect(content).not.toContain('VITE_');
    });

    it('does not include localOnly vars (dev script only)', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, 'apps/api/.dev.vars'), 'utf-8');
      expect(content).not.toContain('MIGRATION_DATABASE_URL');
    });
  });

  describe('updates wrangler.toml', () => {
    it('adds [vars] section', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, 'apps/api/wrangler.toml'), 'utf-8');
      expect(content).toContain('[vars]');
    });

    it('includes production values for vars', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, 'apps/api/wrangler.toml'), 'utf-8');
      expect(content).toContain('NODE_ENV = "production"');
      expect(content).toContain('BETTER_AUTH_URL = "https://api.lome-chat.com"');
    });

    it('includes comments about secrets', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, 'apps/api/wrangler.toml'), 'utf-8');
      expect(content).toContain('Secrets deployed via CI');
      expect(content).toContain('DATABASE_URL');
      expect(content).toContain('BETTER_AUTH_SECRET');
      expect(content).toContain('RESEND_API_KEY');
    });

    it('does not include localOnly vars in secrets comment', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, 'apps/api/wrangler.toml'), 'utf-8');
      expect(content).not.toContain('MIGRATION_DATABASE_URL');
    });

    it('preserves existing wrangler.toml content', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, 'apps/api/wrangler.toml'), 'utf-8');
      expect(content).toContain('name = "test-api"');
      expect(content).toContain('[dev]');
      expect(content).toContain('port = 8787');
    });

    it('replaces existing [vars] section if present', () => {
      // Add existing [vars] section
      writeFileSync(
        join(TEST_DIR, 'apps/api/wrangler.toml'),
        `name = "test-api"

[vars]
OLD_VAR = "should-be-replaced"

[dev]
port = 8787
`
      );

      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, 'apps/api/wrangler.toml'), 'utf-8');
      expect(content).not.toContain('OLD_VAR');
      expect(content).toContain('NODE_ENV = "production"');
    });
  });
});
