import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateEnvFiles, updateWorkflows, parseArgs, escapeEnvValue } from './generate-env.js';
import { getWorktreeConfig } from './worktree.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR_ENV = path.resolve(__dirname, '__test-fixtures-env__');
const TEST_DIR_CI = path.resolve(__dirname, '__test-fixtures-ci__');
const TEST_DIR_EDGE = path.resolve(__dirname, '__test-fixtures-edge__');

describe('generateEnvFiles', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR_ENV, { recursive: true });
    mkdirSync(path.join(TEST_DIR_ENV, 'apps/api'), { recursive: true });

    // Simulate main repo (.git as directory) for worktree detection
    mkdirSync(path.join(TEST_DIR_ENV, '.git'), { recursive: true });

    writeFileSync(
      path.join(TEST_DIR_ENV, 'apps/api/wrangler.toml'),
      `# Wrangler configuration
name = "test-api"
main = "src/index.ts"

[dev]
local_protocol = "http"
`
    );

    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(TEST_DIR_ENV, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('generates .dev.vars (Backend)', () => {
    it('creates the file', () => {
      generateEnvFiles(TEST_DIR_ENV);

      expect(existsSync(path.join(TEST_DIR_ENV, 'apps/api/.dev.vars'))).toBe(true);
    });

    it('includes header comment', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/.dev.vars'), 'utf8');
      expect(content).toContain('Auto-generated');
    });

    it('includes backend vars with development values', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/.dev.vars'), 'utf8');
      expect(content).toContain('NODE_ENV="development"');
      expect(content).toContain('API_URL="http://localhost:8788"');
      expect(content).toContain('FRONTEND_URL="http://localhost:5173"');
      expect(content).toContain('DATABASE_URL="');
      expect(content).toContain('OPAQUE_MASTER_SECRET="');
      expect(content).toContain('IRON_SESSION_SECRET="');
    });

    it('does not include CI/prod secrets in development mode', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/.dev.vars'), 'utf8');
      expect(content).not.toContain('RESEND_API_KEY');
      expect(content).not.toContain('HELCIM_API_TOKEN');
    });

    it('does not include VITE_ vars (frontend only)', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/.dev.vars'), 'utf8');
      expect(content).not.toContain('VITE_');
    });

    it('does not include scripts vars (scripts only)', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/.dev.vars'), 'utf8');
      expect(content).not.toContain('MIGRATION_DATABASE_URL');
    });
  });

  describe('generates .env.development (Frontend)', () => {
    it('creates the file', () => {
      generateEnvFiles(TEST_DIR_ENV);

      expect(existsSync(path.join(TEST_DIR_ENV, '.env.development'))).toBe(true);
    });

    it('includes header comment', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, '.env.development'), 'utf8');
      expect(content).toContain('Auto-generated');
      expect(content).toContain('pnpm generate:env');
    });

    it('includes frontend vars with development values', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, '.env.development'), 'utf8');
      expect(content).toContain('VITE_API_URL="http://localhost:8788"');
      expect(content).toContain('VITE_DRIZZLE_STUDIO_URL="http://localhost:4983"');
      expect(content).toContain('VITE_ADMIN_URL="http://localhost:7000"');
    });

    it('does NOT include backend vars', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, '.env.development'), 'utf8');
      expect(content).not.toContain('NODE_ENV=');
      expect(content).not.toContain('FRONTEND_URL=');
      // Use regex to check DATABASE_URL is not a standalone var
      expect(content).not.toMatch(/^DATABASE_URL=/m);
      expect(content).not.toContain('OPAQUE_MASTER_SECRET=');
      expect(content).not.toContain('IRON_SESSION_SECRET=');
    });

    it('does not include CI/prod secrets', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, '.env.development'), 'utf8');
      expect(content).not.toContain('RESEND_API_KEY');
      expect(content).not.toContain('OPENROUTER_API_KEY');
      expect(content).not.toContain('HELCIM_API_TOKEN');
      expect(content).not.toContain('VITE_HELCIM_JS_TOKEN');
    });

    it('does not include scripts vars', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, '.env.development'), 'utf8');
      expect(content).not.toContain('MIGRATION_DATABASE_URL');
    });
  });

  describe('generates .env.scripts (Scripts)', () => {
    it('creates the file', () => {
      generateEnvFiles(TEST_DIR_ENV);

      expect(existsSync(path.join(TEST_DIR_ENV, '.env.scripts'))).toBe(true);
    });

    it('includes header comment', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, '.env.scripts'), 'utf8');
      expect(content).toContain('Auto-generated');
    });

    it('includes scripts vars', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, '.env.scripts'), 'utf8');
      expect(content).toContain(
        'MIGRATION_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/hushbox"'
      );
    });

    it('includes DATABASE_URL in development (goes to Backend + Scripts)', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, '.env.scripts'), 'utf8');
      expect(content).toContain('DATABASE_URL="postgres://');
    });

    it('does not include frontend vars', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, '.env.scripts'), 'utf8');
      expect(content).not.toContain('VITE_API_URL');
      expect(content).not.toContain('VITE_HELCIM');
      expect(content).not.toContain('VITE_CI');
      expect(content).not.toContain('VITE_E2E');
    });
  });

  describe('updates wrangler.toml', () => {
    it('adds [vars] section', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/wrangler.toml'), 'utf8');
      expect(content).toContain('[vars]');
    });

    it('includes production values for backend non-secret vars', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/wrangler.toml'), 'utf8');
      expect(content).toContain('NODE_ENV = "production"');
      expect(content).toContain('API_URL = "https://api.hushbox.ai"');
      expect(content).toContain('FRONTEND_URL = "https://hushbox.ai"');
    });

    it('includes comments about backend secrets', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/wrangler.toml'), 'utf8');
      expect(content).toContain('Secrets deployed via CI');
      expect(content).toContain('DATABASE_URL');
      expect(content).toContain('OPAQUE_MASTER_SECRET');
      expect(content).toContain('IRON_SESSION_SECRET');
      expect(content).toContain('RESEND_API_KEY');
      expect(content).toContain('HELCIM_API_TOKEN');
      expect(content).toContain('HELCIM_WEBHOOK_VERIFIER');
    });

    it('does not include scripts vars in secrets comment', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/wrangler.toml'), 'utf8');
      expect(content).not.toContain('MIGRATION_DATABASE_URL');
    });

    it('preserves existing wrangler.toml content', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/wrangler.toml'), 'utf8');
      expect(content).toContain('name = "test-api"');
      expect(content).toContain('[dev]');
    });

    it('replaces existing [vars] section if present', () => {
      writeFileSync(
        path.join(TEST_DIR_ENV, 'apps/api/wrangler.toml'),
        `name = "test-api"

[vars]
OLD_VAR = "should-be-replaced"

[dev]
local_protocol = "http"
`
      );

      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/wrangler.toml'), 'utf8');
      expect(content).not.toContain('OLD_VAR');
      expect(content).toContain('NODE_ENV = "production"');
    });
  });

  describe('e2e mode', () => {
    beforeEach(() => {
      process.env['RESEND_API_KEY'] = 'test-resend-key';
      process.env['HELCIM_API_TOKEN_SANDBOX'] = 'test-helcim-token';
      process.env['HELCIM_WEBHOOK_VERIFIER_SANDBOX'] = 'test-helcim-verifier';
      process.env['VITE_HELCIM_JS_TOKEN_SANDBOX'] = 'test-vite-helcim-token';
    });

    afterEach(() => {
      delete process.env['RESEND_API_KEY'];
      delete process.env['HELCIM_API_TOKEN_SANDBOX'];
      delete process.env['HELCIM_WEBHOOK_VERIFIER_SANDBOX'];
      delete process.env['VITE_HELCIM_JS_TOKEN_SANDBOX'];
    });

    it('adds E2E=true flag but NOT CI=true to .dev.vars', () => {
      generateEnvFiles(TEST_DIR_ENV, 'e2e');

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/.dev.vars'), 'utf8');
      expect(content).not.toContain('CI="true"');
      expect(content).toContain('E2E="true"');
    });

    it('does not include Helcim secrets in .dev.vars (local e2e uses mock verifier)', () => {
      generateEnvFiles(TEST_DIR_ENV, 'e2e');

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/.dev.vars'), 'utf8');
      expect(content).not.toContain('HELCIM_API_TOKEN');
      // Webhook verifier uses development mock value
      expect(content).toContain('HELCIM_WEBHOOK_VERIFIER=');
      expect(content).not.toContain('RESEND_API_KEY');
    });

    it('does not include Helcim secrets in .env.development (local e2e has no secrets)', () => {
      generateEnvFiles(TEST_DIR_ENV, 'e2e');

      const content = readFileSync(path.join(TEST_DIR_ENV, '.env.development'), 'utf8');
      expect(content).not.toContain('VITE_HELCIM_JS_TOKEN');
      expect(content).not.toContain('VITE_CI');
      expect(content).toContain('VITE_E2E="true"');
    });

    it('includes base port vars in .env.scripts', () => {
      generateEnvFiles(TEST_DIR_ENV, 'e2e');

      const content = readFileSync(path.join(TEST_DIR_ENV, '.env.scripts'), 'utf8');
      expect(content).toContain('HB_STACK_SLOT="0"');
      expect(content).toContain('HB_VITE_PORT="5173"');
      expect(content).toContain('HB_PREVIEW_PORT="4173"');
      expect(content).toContain('HB_API_PORT="8788"');
      expect(content).toContain('HB_POSTGRES_PORT="5432"');
      expect(content).toContain('HB_NEON_PORT="4444"');
      expect(content).toContain('HB_REDIS_PORT="6379"');
      expect(content).toContain('HB_REDIS_HTTP_PORT="8079"');
      expect(content).toContain('HB_ASTRO_PORT="4321"');
      expect(content).toContain('HB_EMULATOR_ADB_PORT="5555"');
      expect(content).toContain('HB_EMULATOR_VNC_PORT="6080"');
      expect(content).toContain('HB_README_PREVIEW_PORT="6419"');
      expect(content).toContain('HB_MINIO_API_PORT="9000"');
      expect(content).toContain('HB_MINIO_CONSOLE_PORT="9001"');
      expect(content).toContain('HB_STUDIO_PORT="4983"');
      expect(content).toContain('HB_IDLE_DAEMON_PORT="7700"');
      expect(content).toContain('HB_ADMIN_PORT="7000"');
      expect(content).toContain('HB_CRAWLER_VIEW_PORT="7200"');
    });

    it('applies worktree detection like development mode', () => {
      generateEnvFiles(TEST_DIR_ENV, 'e2e');

      // E2E mode runs on local infrastructure, so worktree ports apply
      // (COMPOSE_PROJECT_NAME presence depends on whether we're in a worktree)
      const content = readFileSync(path.join(TEST_DIR_ENV, '.env.scripts'), 'utf8');
      expect(content).toBeDefined();
    });

    it('succeeds without CI secrets (local e2e needs no secrets)', () => {
      delete process.env['HELCIM_API_TOKEN_SANDBOX'];
      delete process.env['HELCIM_WEBHOOK_VERIFIER_SANDBOX'];

      expect(() => {
        generateEnvFiles(TEST_DIR_ENV, 'e2e');
      }).not.toThrow();
    });
  });

  describe('ciE2E mode', () => {
    beforeEach(() => {
      process.env['HELCIM_API_TOKEN_SANDBOX'] = 'test-helcim-token';
      process.env['HELCIM_WEBHOOK_VERIFIER_SANDBOX'] = 'test-helcim-verifier';
      process.env['VITE_HELCIM_JS_TOKEN_SANDBOX'] = 'test-vite-helcim-token';
    });

    afterEach(() => {
      delete process.env['HELCIM_API_TOKEN_SANDBOX'];
      delete process.env['HELCIM_WEBHOOK_VERIFIER_SANDBOX'];
      delete process.env['VITE_HELCIM_JS_TOKEN_SANDBOX'];
    });

    it('throws if a required ciE2E secret is missing', () => {
      delete process.env['HELCIM_API_TOKEN_SANDBOX'];

      expect(() => {
        generateEnvFiles(TEST_DIR_ENV, 'ciE2E');
      }).toThrow('Missing required secrets in process.env: HELCIM_API_TOKEN_SANDBOX');
    });

    it('throws listing all missing secrets', () => {
      delete process.env['HELCIM_API_TOKEN_SANDBOX'];
      delete process.env['HELCIM_WEBHOOK_VERIFIER_SANDBOX'];

      expect(() => {
        generateEnvFiles(TEST_DIR_ENV, 'ciE2E');
      }).toThrow(
        'Missing required secrets in process.env: HELCIM_API_TOKEN_SANDBOX, HELCIM_WEBHOOK_VERIFIER_SANDBOX'
      );
    });

    it('does NOT require OPENROUTER_API_KEY in ciE2E (factory mocks when isE2E=true)', () => {
      delete process.env['OPENROUTER_API_KEY'];

      expect(() => {
        generateEnvFiles(TEST_DIR_ENV, 'ciE2E');
      }).not.toThrow();
    });

    it('with skipBackend, does not require backend secrets and writes no .dev.vars', () => {
      delete process.env['HELCIM_API_TOKEN_SANDBOX'];
      delete process.env['HELCIM_WEBHOOK_VERIFIER_SANDBOX'];

      expect(() => {
        generateEnvFiles(TEST_DIR_ENV, 'ciE2E', { skipBackend: true });
      }).not.toThrow();

      expect(existsSync(path.join(TEST_DIR_ENV, 'apps/api/.dev.vars'))).toBe(false);
    });

    it('with skipBackend, still writes the frontend bundle env (.env.development + .env.scripts)', () => {
      generateEnvFiles(TEST_DIR_ENV, 'ciE2E', { skipBackend: true });

      const frontend = readFileSync(path.join(TEST_DIR_ENV, '.env.development'), 'utf8');
      expect(frontend).toContain('VITE_HELCIM_JS_TOKEN');
      expect(existsSync(path.join(TEST_DIR_ENV, '.env.scripts'))).toBe(true);
    });

    it('with skipBackend, still requires the frontend secret', () => {
      delete process.env['VITE_HELCIM_JS_TOKEN_SANDBOX'];

      expect(() => {
        generateEnvFiles(TEST_DIR_ENV, 'ciE2E', { skipBackend: true });
      }).toThrow(/Missing required secrets/);
    });
  });

  describe('ciVitest mode', () => {
    // Seed the CI-only restricted secrets so the missing-secret assertion is
    // independent of ambient env (locally these are unset; in CI they are real).
    beforeEach(() => {
      process.env['OPENROUTER_API_KEY_RESTRICTED'] = 'test-openrouter-restricted';
      process.env['LINEAR_API_KEY_READ'] = 'test-linear-read';
    });

    afterEach(() => {
      delete process.env['OPENROUTER_API_KEY_RESTRICTED'];
      delete process.env['LINEAR_API_KEY_READ'];
    });

    it('throws when the required ciVitest secret LINEAR_API_KEY_READ is missing', () => {
      delete process.env['LINEAR_API_KEY_READ'];

      expect(() => {
        generateEnvFiles(TEST_DIR_ENV, 'ciVitest');
      }).toThrow('Missing required secrets in process.env: LINEAR_API_KEY_READ');
    });
  });
});

describe('updateWorkflows', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR_CI, { recursive: true });
    mkdirSync(path.join(TEST_DIR_CI, '.github/workflows'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR_CI, { recursive: true, force: true });
  });

  const createCiYml = (content: string): void => {
    writeFileSync(path.join(TEST_DIR_CI, '.github/workflows/ci.yml'), content);
  };

  const readCiYml = (): string => {
    return readFileSync(path.join(TEST_DIR_CI, '.github/workflows/ci.yml'), 'utf8');
  };

  describe('e2e-build-env section', () => {
    it('emits frontend secrets only, excluding server secrets', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: e2e-build-env
old
# END GENERATED: e2e-build-env
rest`);
      updateWorkflows(TEST_DIR_CI);
      const content = readCiYml();
      expect(content).toContain(
        'VITE_HELCIM_JS_TOKEN_SANDBOX: ${{ secrets.VITE_HELCIM_JS_TOKEN_SANDBOX }}'
      );
      expect(content).not.toContain('HELCIM_API_TOKEN_SANDBOX:');
      expect(content).not.toContain('HELCIM_WEBHOOK_VERIFIER_SANDBOX:');
    });

    it('emits the NODE_ENV literal for the dev-mode e2e bundle build', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: e2e-build-env
old
# END GENERATED: e2e-build-env
rest`);
      updateWorkflows(TEST_DIR_CI);
      expect(readCiYml()).toContain('NODE_ENV: development');
    });
  });

  describe('e2e-env section', () => {
    it('generates env block using secret names for e2e secrets', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: e2e-env
old content
# END GENERATED: e2e-env
rest of file`);

      updateWorkflows(TEST_DIR_CI);

      const content = readCiYml();
      expect(content).toContain(
        'HELCIM_API_TOKEN_SANDBOX: ${{ secrets.HELCIM_API_TOKEN_SANDBOX }}'
      );
      expect(content).toContain(
        'HELCIM_WEBHOOK_VERIFIER_SANDBOX: ${{ secrets.HELCIM_WEBHOOK_VERIFIER_SANDBOX }}'
      );
      expect(content).toContain(
        'VITE_HELCIM_JS_TOKEN_SANDBOX: ${{ secrets.VITE_HELCIM_JS_TOKEN_SANDBOX }}'
      );
      // RESEND and OPENROUTER should NOT be present in e2e-env (not in e2e)
      expect(content).not.toContain('RESEND_API_KEY');
      expect(content).not.toContain('OPENROUTER_API_KEY');
    });

    it('preserves content outside markers', () => {
      createCiYml(`name: CI
before
# BEGIN GENERATED: e2e-env
old content
# END GENERATED: e2e-env
after`);

      updateWorkflows(TEST_DIR_CI);

      const content = readCiYml();
      expect(content).toContain('name: CI');
      expect(content).toContain('before');
      expect(content).toContain('after');
    });
  });

  describe('build-env section', () => {
    it('generates frontend production values', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: build-env
old content
# END GENERATED: build-env`);

      updateWorkflows(TEST_DIR_CI);

      const content = readCiYml();
      expect(content).toContain('VITE_API_URL: https://api.hushbox.ai');
    });

    it('uses production secret names for frontend secrets', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: build-env
old content
# END GENERATED: build-env`);

      updateWorkflows(TEST_DIR_CI);

      const content = readCiYml();
      expect(content).toContain(
        'VITE_HELCIM_JS_TOKEN: ${{ secrets.VITE_HELCIM_JS_TOKEN_PRODUCTION }}'
      );
    });

    it('overrides VITE_APP_VERSION with version job output', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: build-env
old content
# END GENERATED: build-env`);

      updateWorkflows(TEST_DIR_CI);

      const content = readCiYml();
      expect(content).toContain('VITE_APP_VERSION: ${{ needs.version.outputs.version }}');
    });

    it('does not use VITE_APP_VERSION secret in build-env', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: build-env
old content
# END GENERATED: build-env`);

      updateWorkflows(TEST_DIR_CI);

      const content = readCiYml();
      expect(content).not.toContain('secrets.VITE_APP_VERSION');
    });
  });

  describe('deploy-secrets section', () => {
    it('generates wrangler secret put commands for all backend secrets', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: deploy-secrets
old content
# END GENERATED: deploy-secrets`);

      updateWorkflows(TEST_DIR_CI);

      const content = readCiYml();
      expect(content).toContain(
        'echo "${{ secrets.DATABASE_URL }}" | pnpm exec wrangler secret put DATABASE_URL'
      );
      expect(content).toContain(
        'echo "${{ secrets.OPAQUE_MASTER_SECRET }}" | pnpm exec wrangler secret put OPAQUE_MASTER_SECRET'
      );
      expect(content).toContain(
        'echo "${{ secrets.IRON_SESSION_SECRET }}" | pnpm exec wrangler secret put IRON_SESSION_SECRET'
      );
      expect(content).toContain(
        'echo "${{ secrets.RESEND_API_KEY }}" | pnpm exec wrangler secret put RESEND_API_KEY'
      );
      expect(content).toContain(
        'echo "${{ secrets.OPENROUTER_API_KEY_PRODUCTION }}" | pnpm exec wrangler secret put OPENROUTER_API_KEY'
      );
    });

    it('uses version job output for APP_VERSION instead of secret', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: deploy-secrets
old content
# END GENERATED: deploy-secrets`);

      updateWorkflows(TEST_DIR_CI);

      const content = readCiYml();
      expect(content).toContain(
        'echo "${{ needs.version.outputs.version }}" | pnpm exec wrangler secret put APP_VERSION'
      );
      expect(content).not.toContain('secrets.APP_VERSION');
    });

    it('uses production secret names for Helcim deploy secrets', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: deploy-secrets
old content
# END GENERATED: deploy-secrets`);

      updateWorkflows(TEST_DIR_CI);

      const content = readCiYml();
      expect(content).toContain(
        'echo "${{ secrets.HELCIM_API_TOKEN_PRODUCTION }}" | pnpm exec wrangler secret put HELCIM_API_TOKEN'
      );
      expect(content).toContain(
        'echo "${{ secrets.HELCIM_WEBHOOK_VERIFIER_PRODUCTION }}" | pnpm exec wrangler secret put HELCIM_WEBHOOK_VERIFIER'
      );
    });

    it('never deploys the Ops-lane R2 admin credentials to the runtime Worker', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: deploy-secrets
old content
# END GENERATED: deploy-secrets`);

      updateWorkflows(TEST_DIR_CI);

      const content = readCiYml();
      // Destination.Ops creds must stay off the Worker — no wrangler secret put.
      expect(content).not.toContain('R2_ADMIN_ACCESS_KEY_ID');
      expect(content).not.toContain('R2_ADMIN_SECRET_ACCESS_KEY');
    });
  });

  describe('decode-google-services section', () => {
    it('generates base64 decode command with production secret reference', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: decode-google-services
old content
# END GENERATED: decode-google-services`);

      updateWorkflows(TEST_DIR_CI);

      const content = readCiYml();
      expect(content).toContain(
        'run: echo "$GOOGLE_SERVICES_JSON_BASE64" | base64 -d > apps/web/android/app/google-services.json'
      );
      expect(content).toContain('env:');
      expect(content).toContain(
        'GOOGLE_SERVICES_JSON_BASE64: ${{ secrets.GOOGLE_SERVICES_JSON_BASE64 }}'
      );
    });
  });

  describe('verify-secrets section', () => {
    it('generates for loop with all backend secret keys', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: verify-secrets
old content
# END GENERATED: verify-secrets`);

      updateWorkflows(TEST_DIR_CI);

      const content = readCiYml();
      expect(content).toContain(
        'for secret in DATABASE_URL UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN OPAQUE_MASTER_SECRET IRON_SESSION_SECRET CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD ADMIN_ACTOR_ALLOWLIST ADMIN_SQL_PANEL_DATABASE_URL CLOUDFLARE_ACCESS_LOG_API_TOKEN CLOUDFLARE_ACCOUNT_ID APP_VERSION RESEND_API_KEY RESEND_WEBHOOK_SECRET OPENROUTER_API_KEY FCM_PROJECT_ID FCM_SERVICE_ACCOUNT_JSON HELCIM_API_TOKEN LINEAR_API_KEY_READ HELCIM_WEBHOOK_VERIFIER R2_S3_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY SENTRY_DSN; do'
      );
      // The Ops-lane admin creds are not Worker secrets, so they are not verified here.
      expect(content).not.toContain('R2_ADMIN_ACCESS_KEY_ID');
    });
  });

  describe('ops-env section', () => {
    it('generates env block using canonical worker keys (not GitHub secret names)', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: ops-env
old content
# END GENERATED: ops-env`);

      updateWorkflows(TEST_DIR_CI);

      const content = readCiYml();
      // Worker key (canonical) on LHS, GitHub secret name on RHS — for aliased secrets.
      expect(content).toContain('OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY_PRODUCTION }}');
      expect(content).toContain('HELCIM_API_TOKEN: ${{ secrets.HELCIM_API_TOKEN_PRODUCTION }}');
      // Same name on both sides — for non-aliased secrets.
      expect(content).toContain('DATABASE_URL: ${{ secrets.DATABASE_URL }}');
      expect(content).toContain('R2_S3_ENDPOINT: ${{ secrets.R2_S3_ENDPOINT }}');
      expect(content).toContain('R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}');
      expect(content).toContain('R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}');
    });

    it('exposes the Ops-lane R2 admin credentials to the runner', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: ops-env
old content
# END GENERATED: ops-env`);

      updateWorkflows(TEST_DIR_CI);

      const content = readCiYml();
      // Destination.Ops secrets are bucket-admin R2 creds, needed by ops scripts
      // (configure-cors) but deliberately kept off the runtime Worker.
      expect(content).toContain('R2_ADMIN_ACCESS_KEY_ID: ${{ secrets.R2_ADMIN_ACCESS_KEY_ID }}');
      expect(content).toContain(
        'R2_ADMIN_SECRET_ACCESS_KEY: ${{ secrets.R2_ADMIN_SECRET_ACCESS_KEY }}'
      );
    });

    it('emits non-secret production literals (e.g. R2_BUCKET_MEDIA) so runner scripts have them too', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: ops-env
old content
# END GENERATED: ops-env`);

      updateWorkflows(TEST_DIR_CI);

      const content = readCiYml();
      // R2_BUCKET_MEDIA is a literal string in production mode (not a secret).
      // It lives in wrangler.toml [vars] for the Worker AND here in the env
      // block so ops scripts running on the GitHub runner see it via process.env.
      expect(content).toContain('R2_BUCKET_MEDIA: hushbox-media');
      // It must NOT use a secrets reference (no GitHub secret of this name exists).
      expect(content).not.toContain('R2_BUCKET_MEDIA: ${{');
    });

    it('does not emit frontend-only secrets (e.g. VITE_HELCIM_JS_TOKEN)', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: ops-env
old content
# END GENERATED: ops-env`);

      updateWorkflows(TEST_DIR_CI);

      const content = readCiYml();
      expect(content).not.toContain('VITE_HELCIM_JS_TOKEN');
    });

    it('overrides APP_VERSION to use the version job output (not the empty GitHub secret)', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: ops-env
old content
# END GENERATED: ops-env`);

      updateWorkflows(TEST_DIR_CI);

      const content = readCiYml();
      // APP_VERSION is computed by the version job at workflow time, not stored
      // as a GitHub secret. The deploy job's env block uses the same override
      // already applied in deploy-secrets so ops scripts see a real value.
      expect(content).toContain('APP_VERSION: ${{ needs.version.outputs.version }}');
      expect(content).not.toContain('APP_VERSION: ${{ secrets.APP_VERSION }}');
    });

    it('preserves content outside markers', () => {
      createCiYml(`name: CI
before
# BEGIN GENERATED: ops-env
old content
# END GENERATED: ops-env
after`);

      updateWorkflows(TEST_DIR_CI);

      const content = readCiYml();
      expect(content).toContain('name: CI');
      expect(content).toContain('before');
      expect(content).toContain('after');
    });
  });

  describe('ops-dispatch-env section', () => {
    it('exposes the same backend secrets and literals as ops-env', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: ops-dispatch-env
old content
# END GENERATED: ops-dispatch-env`);

      updateWorkflows(TEST_DIR_CI);

      const content = readCiYml();
      expect(content).toContain('DATABASE_URL: ${{ secrets.DATABASE_URL }}');
      expect(content).toContain('R2_S3_ENDPOINT: ${{ secrets.R2_S3_ENDPOINT }}');
      expect(content).toContain('R2_BUCKET_MEDIA: hushbox-media');
    });

    it('omits the deploy-only APP_VERSION (no version job exists in the manual runner)', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: ops-dispatch-env
old content
# END GENERATED: ops-dispatch-env`);

      updateWorkflows(TEST_DIR_CI);

      const content = readCiYml();
      expect(content).not.toContain('APP_VERSION');
      expect(content).not.toContain('needs.version.outputs.version');
    });
  });

  describe('multiple sections', () => {
    it('updates all sections in a single call', () => {
      createCiYml(`name: CI

# BEGIN GENERATED: e2e-env
old e2e
# END GENERATED: e2e-env

# BEGIN GENERATED: build-env
old build
# END GENERATED: build-env

# BEGIN GENERATED: deploy-secrets
old deploy
# END GENERATED: deploy-secrets

# BEGIN GENERATED: verify-secrets
old verify
# END GENERATED: verify-secrets
`);

      updateWorkflows(TEST_DIR_CI);

      const content = readCiYml();
      expect(content).not.toContain('old e2e');
      expect(content).not.toContain('old build');
      expect(content).not.toContain('old deploy');
      expect(content).not.toContain('old verify');
      // e2e-env has Helcim secrets (not RESEND - production only)
      expect(content).toContain('HELCIM_API_TOKEN_SANDBOX:');
      expect(content).toContain('VITE_API_URL:');
      // deploy-secrets has RESEND for production
      expect(content).toContain('wrangler secret put RESEND_API_KEY');
      expect(content).toContain('for secret in');
    });
  });
});

describe('updateWorkflows edge cases', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR_EDGE, { recursive: true });
    mkdirSync(path.join(TEST_DIR_EDGE, '.github/workflows'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR_EDGE, { recursive: true, force: true });
  });

  it('handles file with no markers gracefully', () => {
    writeFileSync(path.join(TEST_DIR_EDGE, '.github/workflows/ci.yml'), 'name: CI\njobs: {}');

    updateWorkflows(TEST_DIR_EDGE);

    const content = readFileSync(path.join(TEST_DIR_EDGE, '.github/workflows/ci.yml'), 'utf8');
    expect(content).toBe('name: CI\njobs: {}');
  });

  it('does nothing if ci.yml does not exist', () => {
    rmSync(path.join(TEST_DIR_EDGE, '.github/workflows'), { recursive: true, force: true });
    mkdirSync(path.join(TEST_DIR_EDGE, '.github/workflows'), { recursive: true });

    expect(() => {
      updateWorkflows(TEST_DIR_EDGE);
    }).not.toThrow();
  });
});

describe('parseArgs', () => {
  it('returns development by default', () => {
    expect(parseArgs([])).toBe('development');
  });

  it('returns development when no mode flag provided', () => {
    expect(parseArgs(['--other=flag'])).toBe('development');
  });

  it('parses --mode=development', () => {
    expect(parseArgs(['--mode=development'])).toBe('development');
  });

  it('parses --mode=ciVitest', () => {
    expect(parseArgs(['--mode=ciVitest'])).toBe('ciVitest');
  });

  it('parses --mode=e2e', () => {
    expect(parseArgs(['--mode=e2e'])).toBe('e2e');
  });

  it('parses --mode=production', () => {
    expect(parseArgs(['--mode=production'])).toBe('production');
  });

  it('throws for invalid mode', () => {
    expect(() => parseArgs(['--mode=invalid'])).toThrow(
      'Invalid mode: invalid. Valid modes: development, ciVitest, e2e, ciE2E, production'
    );
  });

  it('throws for empty mode', () => {
    expect(() => parseArgs(['--mode='])).toThrow('Invalid mode: . Valid modes:');
  });
});

describe('escapeEnvValue', () => {
  it('wraps simple values in double quotes', () => {
    expect(escapeEnvValue('simple')).toBe('"simple"');
  });

  it('handles values with equals signs', () => {
    expect(escapeEnvValue('abc123=xyz')).toBe('"abc123=xyz"');
  });

  it('handles values with hash characters (comments)', () => {
    expect(escapeEnvValue('value#comment')).toBe('"value#comment"');
  });

  it('handles values with spaces', () => {
    expect(escapeEnvValue('hello world')).toBe('"hello world"');
  });

  it('handles values with multiple special characters', () => {
    expect(escapeEnvValue('abc=def#ghi jkl')).toBe('"abc=def#ghi jkl"');
  });

  it('single-quotes values containing double quotes so dotenv preserves them verbatim', () => {
    // dotenv does NOT unescape \" inside double-quoted values, so JSON values
    // (e.g. CF_ACCESS_DEV_PRIVATE_JWK) written as "{\"kty\":…}" reach wrangler
    // and with-env consumers with literal backslashes and fail JSON.parse.
    // Single-quoted dotenv values are taken verbatim.
    expect(escapeEnvValue('say "hello"')).toBe(`'say "hello"'`);
    expect(escapeEnvValue('{"kty":"OKP","crv":"Ed25519"}')).toBe(`'{"kty":"OKP","crv":"Ed25519"}'`);
  });

  it('round-trips a JSON value through dotenv parsing', async () => {
    const { parse } = await import('dotenv');
    const value = '{"kty":"OKP","x":"abc"}';
    const parsed = parse(`KEY=${escapeEnvValue(value)}`);
    expect(parsed['KEY']).toBe(value);
    expect(JSON.parse(parsed['KEY']!)).toEqual({ kty: 'OKP', x: 'abc' });
  });

  it('escapes backslashes', () => {
    expect(escapeEnvValue(String.raw`path\to\file`)).toBe(String.raw`"path\\to\\file"`);
  });

  it('throws loudly on values containing both quote kinds', () => {
    // Neither dotenv quoting style represents this shape faithfully:
    // double-quoting writes \" that dotenv does not unescape, and a
    // single-quoted value cannot contain a literal single quote. Writing
    // either silently corrupts the value, so refuse and name the key.
    expect(() => escapeEnvValue(`it's "quoted"`, 'MY_SECRET')).toThrow(/MY_SECRET/);
    expect(() => escapeEnvValue(`it's "quoted"`, 'MY_SECRET')).toThrow(/quote/i);
  });

  it('throws on both quote kinds even without a key, with a fallback name', () => {
    expect(() => escapeEnvValue(`it's "quoted"`)).toThrow(/unknown key/i);
  });

  it('handles empty values', () => {
    expect(escapeEnvValue('')).toBe('""');
  });

  it('handles values with newlines', () => {
    expect(escapeEnvValue('line1\nline2')).toBe('"line1\nline2"');
  });
});

describe('worktree port integration', () => {
  const TEST_DIR_WT = path.resolve(__dirname, '__test-fixtures-worktree-env__');

  beforeEach(() => {
    mkdirSync(TEST_DIR_WT, { recursive: true });
    mkdirSync(path.join(TEST_DIR_WT, 'apps/api'), { recursive: true });

    writeFileSync(
      path.join(TEST_DIR_WT, 'apps/api/wrangler.toml'),
      `# Wrangler configuration
name = "test-api"
main = "src/index.ts"

[dev]
local_protocol = "http"
`
    );

    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(TEST_DIR_WT, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('main repo (slot 0)', () => {
    beforeEach(() => {
      mkdirSync(path.join(TEST_DIR_WT, '.git'), { recursive: true });
    });

    it('uses base ports in .dev.vars', () => {
      generateEnvFiles(TEST_DIR_WT);

      const content = readFileSync(path.join(TEST_DIR_WT, 'apps/api/.dev.vars'), 'utf8');
      expect(content).toContain('API_URL="http://localhost:8788"');
      expect(content).toContain('FRONTEND_URL="http://localhost:5173"');
    });

    it('uses the base Astro port for MARKETING_URL in .dev.vars', () => {
      generateEnvFiles(TEST_DIR_WT);

      const content = readFileSync(path.join(TEST_DIR_WT, 'apps/api/.dev.vars'), 'utf8');
      expect(content).toContain('MARKETING_URL="http://localhost:4321"');
    });

    it('uses base ports in .env.development', () => {
      generateEnvFiles(TEST_DIR_WT);

      const content = readFileSync(path.join(TEST_DIR_WT, '.env.development'), 'utf8');
      expect(content).toContain('VITE_API_URL="http://localhost:8788"');
    });

    it('uses base ports in .env.scripts', () => {
      generateEnvFiles(TEST_DIR_WT);

      const content = readFileSync(path.join(TEST_DIR_WT, '.env.scripts'), 'utf8');
      expect(content).toContain('localhost:4444');
      expect(content).toContain('localhost:5432');
    });

    it('appends worktree vars to .env.scripts', () => {
      generateEnvFiles(TEST_DIR_WT);

      const content = readFileSync(path.join(TEST_DIR_WT, '.env.scripts'), 'utf8');
      expect(content).toContain('COMPOSE_PROJECT_NAME="hushbox"');
      expect(content).toContain('HB_STACK_SLOT="0"');
      expect(content).toContain('HB_VITE_PORT="5173"');
      expect(content).toContain('HB_PREVIEW_PORT="4173"');
      expect(content).toContain('HB_API_PORT="8788"');
      expect(content).toContain('HB_POSTGRES_PORT="5432"');
      expect(content).toContain('HB_NEON_PORT="4444"');
      expect(content).toContain('HB_REDIS_PORT="6379"');
      expect(content).toContain('HB_REDIS_HTTP_PORT="8079"');
      expect(content).toContain('HB_ASTRO_PORT="4321"');
      expect(content).toContain('HB_EMULATOR_ADB_PORT="5555"');
      expect(content).toContain('HB_EMULATOR_VNC_PORT="6080"');
      expect(content).toContain('HB_README_PREVIEW_PORT="6419"');
      expect(content).toContain('HB_MINIO_API_PORT="9000"');
      expect(content).toContain('HB_MINIO_CONSOLE_PORT="9001"');
      expect(content).toContain('HB_STUDIO_PORT="4983"');
      expect(content).toContain('HB_IDLE_DAEMON_PORT="7700"');
      expect(content).toContain('HB_ADMIN_PORT="7000"');
      expect(content).toContain('HB_CRAWLER_VIEW_PORT="7200"');
    });
  });

  describe('worktree (slot > 0)', () => {
    beforeEach(() => {
      writeFileSync(
        path.join(TEST_DIR_WT, '.git'),
        'gitdir: /home/user/repo/.git/worktrees/my-feature\n'
      );
    });

    it('offsets ports in .dev.vars', () => {
      generateEnvFiles(TEST_DIR_WT);

      const content = readFileSync(path.join(TEST_DIR_WT, 'apps/api/.dev.vars'), 'utf8');
      expect(content).not.toContain('localhost:8788');
      expect(content).not.toContain('localhost:5173');
      expect(content).not.toContain('localhost:4444');
      expect(content).not.toContain('localhost:8079');
    });

    it('rewrites MARKETING_URL from the base Astro port to the computed worktree port', () => {
      generateEnvFiles(TEST_DIR_WT);

      const { ports } = getWorktreeConfig(TEST_DIR_WT);
      const content = readFileSync(path.join(TEST_DIR_WT, 'apps/api/.dev.vars'), 'utf8');
      expect(content).not.toContain('MARKETING_URL="http://localhost:4321"');
      expect(content).toContain(`MARKETING_URL="http://localhost:${String(ports.astro)}"`);
    });

    it('offsets ports in .env.development', () => {
      generateEnvFiles(TEST_DIR_WT);

      const content = readFileSync(path.join(TEST_DIR_WT, '.env.development'), 'utf8');
      expect(content).not.toContain('localhost:8788');
      expect(content).not.toContain('localhost:4983');
      expect(content).not.toContain('localhost:7000');
    });

    it('offsets ports in .env.scripts', () => {
      generateEnvFiles(TEST_DIR_WT);

      const content = readFileSync(path.join(TEST_DIR_WT, '.env.scripts'), 'utf8');
      expect(content).not.toContain('localhost:4444');
      expect(content).not.toContain('localhost:5432');
    });

    it('appends worktree vars with offset ports to .env.scripts', () => {
      generateEnvFiles(TEST_DIR_WT);

      const content = readFileSync(path.join(TEST_DIR_WT, '.env.scripts'), 'utf8');
      expect(content).toContain('COMPOSE_PROJECT_NAME="hushbox-');
      expect(content).not.toContain('HB_VITE_PORT="5173"');
      expect(content).not.toContain('HB_API_PORT="8788"');
    });

    it('does not offset ports in CI modes', () => {
      process.env['HELCIM_API_TOKEN_SANDBOX'] = 'test';
      process.env['HELCIM_WEBHOOK_VERIFIER_SANDBOX'] = 'test';
      process.env['VITE_HELCIM_JS_TOKEN_SANDBOX'] = 'test';

      generateEnvFiles(TEST_DIR_WT, 'ciE2E');

      const content = readFileSync(path.join(TEST_DIR_WT, 'apps/api/.dev.vars'), 'utf8');
      expect(content).toContain('localhost:8788');
      expect(content).toContain('localhost:5173');

      delete process.env['HELCIM_API_TOKEN_SANDBOX'];
      delete process.env['HELCIM_WEBHOOK_VERIFIER_SANDBOX'];
      delete process.env['VITE_HELCIM_JS_TOKEN_SANDBOX'];
    });
  });
});

const TEST_DIR_VARIANTS = path.resolve(__dirname, '__test-fixtures-variants__');

describe('build-env variants', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR_VARIANTS, { recursive: true });
    mkdirSync(path.join(TEST_DIR_VARIANTS, '.github/workflows'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR_VARIANTS, { recursive: true, force: true });
  });

  const createWorkflow = (filename: string, content: string): void => {
    writeFileSync(path.join(TEST_DIR_VARIANTS, '.github/workflows', filename), content);
  };

  const readWorkflow = (filename: string): string => {
    return readFileSync(path.join(TEST_DIR_VARIANTS, '.github/workflows', filename), 'utf8');
  };

  describe('build-env-android', () => {
    it('overrides VITE_PLATFORM to inputs.vite-platform expression', () => {
      createWorkflow(
        'build-android.yml',
        `name: Android
        # BEGIN GENERATED: build-env-android
        old content
        # END GENERATED: build-env-android`
      );

      updateWorkflows(TEST_DIR_VARIANTS);

      const content = readWorkflow('build-android.yml');
      expect(content).toContain('VITE_PLATFORM: ${{ inputs.vite-platform }}');
    });

    it('overrides VITE_APP_VERSION to use inputs.version', () => {
      createWorkflow(
        'build-android.yml',
        `name: Android
        # BEGIN GENERATED: build-env-android
        old content
        # END GENERATED: build-env-android`
      );

      updateWorkflows(TEST_DIR_VARIANTS);

      const content = readWorkflow('build-android.yml');
      expect(content).toContain('VITE_APP_VERSION: ${{ inputs.version }}');
    });

    it('does not use VITE_APP_VERSION secret', () => {
      createWorkflow(
        'build-android.yml',
        `name: Android
        # BEGIN GENERATED: build-env-android
        old content
        # END GENERATED: build-env-android`
      );

      updateWorkflows(TEST_DIR_VARIANTS);

      const content = readWorkflow('build-android.yml');
      expect(content).not.toContain('secrets.VITE_APP_VERSION');
    });

    it('does not include VITE_OPAQUE_SERVER_ID (removed, hard-coded in crypto)', () => {
      createWorkflow(
        'build-android.yml',
        `name: Android
        # BEGIN GENERATED: build-env-android
        old content
        # END GENERATED: build-env-android`
      );

      updateWorkflows(TEST_DIR_VARIANTS);

      const content = readWorkflow('build-android.yml');
      expect(content).not.toContain('VITE_OPAQUE_SERVER_ID');
    });
  });

  describe('build-env-web-release', () => {
    it('overrides VITE_PLATFORM to web', () => {
      createWorkflow(
        'release.yml',
        `name: Release
        # BEGIN GENERATED: build-env-web-release
        old content
        # END GENERATED: build-env-web-release`
      );

      updateWorkflows(TEST_DIR_VARIANTS);

      const content = readWorkflow('release.yml');
      expect(content).toContain('VITE_PLATFORM: web');
    });

    it('overrides VITE_APP_VERSION to use prepare-version job output', () => {
      createWorkflow(
        'release.yml',
        `name: Release
        # BEGIN GENERATED: build-env-web-release
        old content
        # END GENERATED: build-env-web-release`
      );

      updateWorkflows(TEST_DIR_VARIANTS);

      const content = readWorkflow('release.yml');
      expect(content).toContain('VITE_APP_VERSION: ${{ needs.prepare-version.outputs.version }}');
    });
  });

  describe('shared values across variants', () => {
    it('all variants include VITE_API_URL from envConfig', () => {
      createWorkflow(
        'build-android.yml',
        `name: Android
        # BEGIN GENERATED: build-env-android
        old
        # END GENERATED: build-env-android`
      );
      createWorkflow(
        'release.yml',
        `name: Release
        # BEGIN GENERATED: build-env-web-release
        old
        # END GENERATED: build-env-web-release`
      );

      updateWorkflows(TEST_DIR_VARIANTS);

      const android = readWorkflow('build-android.yml');
      const release = readWorkflow('release.yml');
      expect(android).toContain('VITE_API_URL: https://api.hushbox.ai');
      expect(release).toContain('VITE_API_URL: https://api.hushbox.ai');
    });

    it('all variants include VITE_HELCIM_JS_TOKEN from envConfig', () => {
      createWorkflow(
        'build-android.yml',
        `name: Android
        # BEGIN GENERATED: build-env-android
        old
        # END GENERATED: build-env-android`
      );
      createWorkflow(
        'release.yml',
        `name: Release
        # BEGIN GENERATED: build-env-web-release
        old
        # END GENERATED: build-env-web-release`
      );

      updateWorkflows(TEST_DIR_VARIANTS);

      const android = readWorkflow('build-android.yml');
      const release = readWorkflow('release.yml');
      expect(android).toContain(
        'VITE_HELCIM_JS_TOKEN: ${{ secrets.VITE_HELCIM_JS_TOKEN_PRODUCTION }}'
      );
      expect(release).toContain(
        'VITE_HELCIM_JS_TOKEN: ${{ secrets.VITE_HELCIM_JS_TOKEN_PRODUCTION }}'
      );
    });
  });

  describe('multi-file processing', () => {
    it('updates markers across multiple workflow files', () => {
      createWorkflow(
        'ci.yml',
        `name: CI
        # BEGIN GENERATED: build-env
        old ci
        # END GENERATED: build-env`
      );
      createWorkflow(
        'release.yml',
        `name: Release
        # BEGIN GENERATED: build-env-web-release
        old release
        # END GENERATED: build-env-web-release`
      );

      updateWorkflows(TEST_DIR_VARIANTS);

      const ci = readWorkflow('ci.yml');
      const release = readWorkflow('release.yml');
      expect(ci).toContain('VITE_API_URL: https://api.hushbox.ai');
      expect(ci).not.toContain('old ci');
      expect(release).toContain('VITE_API_URL: https://api.hushbox.ai');
      expect(release).not.toContain('old release');
    });

    it('skips missing workflow files gracefully', () => {
      // Only create ci.yml, not release.yml or build-android.yml
      createWorkflow(
        'ci.yml',
        `name: CI
        # BEGIN GENERATED: build-env
        old
        # END GENERATED: build-env`
      );

      expect(() => {
        updateWorkflows(TEST_DIR_VARIANTS);
      }).not.toThrow();

      const ci = readWorkflow('ci.yml');
      expect(ci).toContain('VITE_API_URL:');
    });
  });
});
