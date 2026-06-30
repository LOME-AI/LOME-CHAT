import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseDevVariables,
  parseWranglerToml,
  parseEnvDevelopment,
  getExpectedEnvUtilities,
  verifyBackendEnv,
  verifyFrontendEnv,
  formatEnvUtilities,
  formatEnvContext,
  parseCliArgs,
  verifyAll,
  printVerificationResult,
} from './verify-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, '__test-fixtures__');

describe('verify-env', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe('parseDevVariables', () => {
    it('parses NODE_ENV, CI, and E2E from .dev.vars file', async () => {
      const content = `NODE_ENV=development
CI=true
E2E=true
DATABASE_URL=postgres://localhost
`;
      await writeFile(path.join(TEST_DIR, '.dev.vars'), content);

      const result = await parseDevVariables(path.join(TEST_DIR, '.dev.vars'));

      expect(result).toEqual({
        NODE_ENV: 'development',
        CI: 'true',
        E2E: 'true',
      });
    });

    it('strips double quotes from values', async () => {
      const content = `NODE_ENV="development"
CI="true"
DATABASE_URL="postgres://localhost"
`;
      await writeFile(path.join(TEST_DIR, '.dev.vars'), content);

      const result = await parseDevVariables(path.join(TEST_DIR, '.dev.vars'));

      expect(result).toEqual({
        NODE_ENV: 'development',
        CI: 'true',
        E2E: undefined,
      });
    });

    it('strips single quotes from values', async () => {
      const content = `NODE_ENV='production'
`;
      await writeFile(path.join(TEST_DIR, '.dev.vars'), content);

      const result = await parseDevVariables(path.join(TEST_DIR, '.dev.vars'));

      expect(result).toEqual({
        NODE_ENV: 'production',
        CI: undefined,
        E2E: undefined,
      });
    });

    it('returns undefined for missing variables', async () => {
      const content = `NODE_ENV=production
DATABASE_URL=postgres://localhost
`;
      await writeFile(path.join(TEST_DIR, '.dev.vars'), content);

      const result = await parseDevVariables(path.join(TEST_DIR, '.dev.vars'));

      expect(result).toEqual({
        NODE_ENV: 'production',
        CI: undefined,
        E2E: undefined,
      });
    });

    it('throws if file does not exist', async () => {
      await expect(parseDevVariables(path.join(TEST_DIR, 'nonexistent.vars'))).rejects.toThrow();
    });
  });

  describe('parseWranglerToml', () => {
    it('parses NODE_ENV from [vars] section', async () => {
      const content = `name = "hushbox-api"
main = "src/index.ts"

[vars]
NODE_ENV = "production"
API_URL = "https://api.hushbox.ai"
FRONTEND_URL = "https://hushbox.ai"
`;
      await writeFile(path.join(TEST_DIR, 'wrangler.toml'), content);

      const result = await parseWranglerToml(path.join(TEST_DIR, 'wrangler.toml'));

      expect(result).toEqual({
        NODE_ENV: 'production',
        CI: undefined,
        E2E: undefined,
      });
    });

    it('throws if file does not exist', async () => {
      await expect(parseWranglerToml(path.join(TEST_DIR, 'nonexistent.toml'))).rejects.toThrow();
    });

    it('returns undefined values when no [vars] section exists', async () => {
      const content = `name = "hushbox-api"
main = "src/index.ts"
`;
      await writeFile(path.join(TEST_DIR, 'wrangler.toml'), content);

      const result = await parseWranglerToml(path.join(TEST_DIR, 'wrangler.toml'));

      expect(result).toEqual({
        NODE_ENV: undefined,
        CI: undefined,
        E2E: undefined,
      });
    });
  });

  describe('parseEnvDevelopment', () => {
    it('parses VITE_CI from .env.development file', async () => {
      const content = `VITE_API_URL=http://localhost:8787
VITE_CI=true
`;
      await writeFile(path.join(TEST_DIR, '.env.development'), content);

      const result = await parseEnvDevelopment(path.join(TEST_DIR, '.env.development'));

      expect(result).toEqual({
        VITE_CI: 'true',
        VITE_E2E: undefined,
      });
    });

    it('returns undefined for missing VITE_CI', async () => {
      const content = `VITE_API_URL=http://localhost:8787
`;
      await writeFile(path.join(TEST_DIR, '.env.development'), content);

      const result = await parseEnvDevelopment(path.join(TEST_DIR, '.env.development'));

      expect(result).toEqual({
        VITE_CI: undefined,
        VITE_E2E: undefined,
      });
    });

    it('parses VITE_E2E from .env.development file', async () => {
      const content = `VITE_API_URL=http://localhost:8787
VITE_CI=true
VITE_E2E=true
`;
      await writeFile(path.join(TEST_DIR, '.env.development'), content);

      const result = await parseEnvDevelopment(path.join(TEST_DIR, '.env.development'));

      expect(result).toEqual({
        VITE_CI: 'true',
        VITE_E2E: 'true',
      });
    });
  });

  describe('getExpectedEnvUtilities', () => {
    it('returns correct expectations for development mode', () => {
      const expected = getExpectedEnvUtilities('development');

      expect(expected).toEqual({
        isDev: true,
        isLocalDev: true,
        isDevServer: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      });
    });

    it('returns correct expectations for ciVitest mode', () => {
      const expected = getExpectedEnvUtilities('ciVitest');

      expect(expected).toEqual({
        isDev: true,
        isLocalDev: false,
        isDevServer: false,
        isProduction: false,
        isCI: true,
        isE2E: false,
        requiresRealServices: true,
      });
    });

    it('returns correct expectations for e2e mode', () => {
      const expected = getExpectedEnvUtilities('e2e');

      expect(expected).toEqual({
        isDev: true,
        isLocalDev: true,
        isDevServer: false,
        isProduction: false,
        isCI: false,
        isE2E: true,
        requiresRealServices: false,
      });
    });

    it('returns correct expectations for production mode', () => {
      const expected = getExpectedEnvUtilities('production');

      expect(expected).toEqual({
        isDev: false,
        isLocalDev: false,
        isDevServer: false,
        isProduction: true,
        isCI: false,
        isE2E: false,
        requiresRealServices: true,
      });
    });
  });

  describe('verifyBackendEnv', () => {
    it('returns success when env matches expectations for development', async () => {
      const content = `NODE_ENV=development
DATABASE_URL=postgres://localhost
`;
      await writeFile(path.join(TEST_DIR, '.dev.vars'), content);

      const result = await verifyBackendEnv('development', {
        devVarsPath: path.join(TEST_DIR, '.dev.vars'),
        wranglerTomlPath: path.join(TEST_DIR, 'wrangler.toml'),
      });

      expect(result.success).toBe(true);
      expect(result.actual.isLocalDev).toBe(true);
      expect(result.actual.isCI).toBe(false);
    });

    it('returns success when env matches expectations for ciVitest', async () => {
      const content = `NODE_ENV=development
CI=true
DATABASE_URL=postgres://localhost
`;
      await writeFile(path.join(TEST_DIR, '.dev.vars'), content);

      const result = await verifyBackendEnv('ciVitest', {
        devVarsPath: path.join(TEST_DIR, '.dev.vars'),
        wranglerTomlPath: path.join(TEST_DIR, 'wrangler.toml'),
      });

      expect(result.success).toBe(true);
      expect(result.actual.isCI).toBe(true);
      expect(result.actual.isLocalDev).toBe(false);
    });

    it('returns success when env matches expectations for e2e', async () => {
      const content = `NODE_ENV=development
E2E=true
DATABASE_URL=postgres://localhost
`;
      await writeFile(path.join(TEST_DIR, '.dev.vars'), content);

      const result = await verifyBackendEnv('e2e', {
        devVarsPath: path.join(TEST_DIR, '.dev.vars'),
        wranglerTomlPath: path.join(TEST_DIR, 'wrangler.toml'),
      });

      expect(result.success).toBe(true);
      expect(result.actual.isCI).toBe(false);
      expect(result.actual.isE2E).toBe(true);
    });

    it('returns success when env matches expectations for production', async () => {
      const content = `name = "hushbox-api"

[vars]
NODE_ENV = "production"
`;
      await writeFile(path.join(TEST_DIR, 'wrangler.toml'), content);

      const result = await verifyBackendEnv('production', {
        devVarsPath: path.join(TEST_DIR, '.dev.vars'),
        wranglerTomlPath: path.join(TEST_DIR, 'wrangler.toml'),
      });

      expect(result.success).toBe(true);
      expect(result.actual.isProduction).toBe(true);
    });

    it('returns failure with diff when env does not match expectations', async () => {
      // Missing CI=true for ciVitest mode
      const content = `NODE_ENV=development
DATABASE_URL=postgres://localhost
`;
      await writeFile(path.join(TEST_DIR, '.dev.vars'), content);

      const result = await verifyBackendEnv('ciVitest', {
        devVarsPath: path.join(TEST_DIR, '.dev.vars'),
        wranglerTomlPath: path.join(TEST_DIR, 'wrangler.toml'),
      });

      expect(result.success).toBe(false);
      expect(result.mismatches).toContainEqual({
        key: 'isCI',
        expected: true,
        actual: false,
      });
    });
  });

  describe('verifyFrontendEnv', () => {
    it('returns success when env matches expectations for development', async () => {
      const content = `VITE_API_URL=http://localhost:8787
`;
      await writeFile(path.join(TEST_DIR, '.env.development'), content);

      const result = await verifyFrontendEnv('development', {
        envDevelopmentPath: path.join(TEST_DIR, '.env.development'),
      });

      expect(result.success).toBe(true);
      expect(result.actual.isLocalDev).toBe(true);
    });

    it('returns success when env matches expectations for ciVitest', async () => {
      const content = `VITE_API_URL=http://localhost:8787
VITE_CI=true
`;
      await writeFile(path.join(TEST_DIR, '.env.development'), content);

      const result = await verifyFrontendEnv('ciVitest', {
        envDevelopmentPath: path.join(TEST_DIR, '.env.development'),
      });

      expect(result.success).toBe(true);
      expect(result.actual.isCI).toBe(true);
    });

    it('returns success when env matches expectations for e2e', async () => {
      const content = `VITE_API_URL=http://localhost:8787
VITE_E2E=true
`;
      await writeFile(path.join(TEST_DIR, '.env.development'), content);

      const result = await verifyFrontendEnv('e2e', {
        envDevelopmentPath: path.join(TEST_DIR, '.env.development'),
      });

      expect(result.success).toBe(true);
      expect(result.actual.isCI).toBe(false);
      expect(result.actual.isE2E).toBe(true);
    });

    it('returns failure when VITE_E2E is missing for e2e mode', async () => {
      const content = `VITE_API_URL=http://localhost:8787
`;
      await writeFile(path.join(TEST_DIR, '.env.development'), content);

      const result = await verifyFrontendEnv('e2e', {
        envDevelopmentPath: path.join(TEST_DIR, '.env.development'),
      });

      expect(result.success).toBe(false);
      expect(result.mismatches).toContainEqual({
        key: 'isE2E',
        expected: true,
        actual: false,
      });
    });

    it('returns success for production mode (no file needed)', async () => {
      // Production frontend doesn't read .env.development - just uses Vite MODE=production
      const result = await verifyFrontendEnv('production', {
        envDevelopmentPath: path.join(TEST_DIR, '.env.development'),
      });

      expect(result.success).toBe(true);
      expect(result.actual.isProduction).toBe(true);
    });

    it('returns failure when VITE_CI is missing for CI mode', async () => {
      const content = `VITE_API_URL=http://localhost:8787
`;
      await writeFile(path.join(TEST_DIR, '.env.development'), content);

      const result = await verifyFrontendEnv('ciVitest', {
        envDevelopmentPath: path.join(TEST_DIR, '.env.development'),
      });

      expect(result.success).toBe(false);
      expect(result.mismatches).toContainEqual({
        key: 'isCI',
        expected: true,
        actual: false,
      });
    });
  });

  describe('formatEnvUtilities', () => {
    it('formats EnvUtilities object as a string', () => {
      const env = {
        isDev: true,
        isLocalDev: false,
        isDevServer: false,
        isProduction: false,
        isCI: true,
        isE2E: false,
        requiresRealServices: true,
      };

      const result = formatEnvUtilities(env);

      expect(result).toBe(
        'isDev=true, isLocalDev=false, isDevServer=false, isProduction=false, isCI=true, isE2E=false, requiresRealServices=true'
      );
    });
  });

  describe('formatEnvContext', () => {
    it('formats EnvContext with all values', () => {
      const ctx = { NODE_ENV: 'development', CI: 'true', E2E: 'true' };

      const result = formatEnvContext(ctx);

      expect(result).toBe('NODE_ENV=development, CI=true, E2E=true');
    });

    it('formats EnvContext with undefined values', () => {
      const ctx = { NODE_ENV: 'production' };

      const result = formatEnvContext(ctx);

      expect(result).toBe('NODE_ENV=production, CI=undefined, E2E=undefined');
    });

    it('formats EnvContext with NODE_ENV missing', () => {
      const ctx = { CI: 'true' };

      const result = formatEnvContext(ctx);

      expect(result).toBe('NODE_ENV=undefined, CI=true, E2E=undefined');
    });
  });

  describe('parseCliArgs', () => {
    it('returns mode when valid --mode= argument is provided', () => {
      const result = parseCliArgs(['--mode=development']);

      expect(result).toEqual({ mode: 'development' });
    });

    it('returns mode for ciVitest', () => {
      const result = parseCliArgs(['--mode=ciVitest']);

      expect(result).toEqual({ mode: 'ciVitest' });
    });

    it('returns mode for e2e', () => {
      const result = parseCliArgs(['--mode=e2e']);

      expect(result).toEqual({ mode: 'e2e' });
    });

    it('returns mode for production', () => {
      const result = parseCliArgs(['--mode=production']);

      expect(result).toEqual({ mode: 'production' });
    });

    it('returns error when no --mode= argument is provided', () => {
      const result = parseCliArgs([]);

      expect(result).toEqual({
        error: 'Usage: pnpm verify:env --mode=<development|ciVitest|e2e|ciE2E|production>',
      });
    });

    it('returns error for invalid mode', () => {
      const result = parseCliArgs(['--mode=invalid']);

      expect(result).toEqual({
        error: 'Invalid mode: invalid. Valid modes: development, ciVitest, e2e, ciE2E, production',
      });
    });

    it('ignores other arguments and finds --mode=', () => {
      const result = parseCliArgs(['--verbose', '--mode=production', '--debug']);

      expect(result).toEqual({ mode: 'production' });
    });
  });

  describe('verifyAll', () => {
    it('returns success when both backend and frontend pass', async () => {
      const devVariablesContent = `NODE_ENV=development
`;
      const envDevContent = `VITE_API_URL=http://localhost:8787
`;
      await writeFile(path.join(TEST_DIR, '.dev.vars'), devVariablesContent);
      await writeFile(path.join(TEST_DIR, '.env.development'), envDevContent);

      const result = await verifyAll('development', {
        devVarsPath: path.join(TEST_DIR, '.dev.vars'),
        wranglerTomlPath: path.join(TEST_DIR, 'wrangler.toml'),
        envDevelopmentPath: path.join(TEST_DIR, '.env.development'),
      });

      expect(result.success).toBe(true);
      expect('error' in result.backend).toBe(false);
      expect('error' in result.frontend).toBe(false);
    });

    it('returns failure when backend fails', async () => {
      // Missing CI=true for ciVitest
      const devVariablesContent = `NODE_ENV=development
`;
      const envDevContent = `VITE_API_URL=http://localhost:8787
VITE_CI=true
`;
      await writeFile(path.join(TEST_DIR, '.dev.vars'), devVariablesContent);
      await writeFile(path.join(TEST_DIR, '.env.development'), envDevContent);

      const result = await verifyAll('ciVitest', {
        devVarsPath: path.join(TEST_DIR, '.dev.vars'),
        wranglerTomlPath: path.join(TEST_DIR, 'wrangler.toml'),
        envDevelopmentPath: path.join(TEST_DIR, '.env.development'),
      });

      expect(result.success).toBe(false);
    });

    it('returns error object when backend file is missing', async () => {
      const envDevContent = `VITE_API_URL=http://localhost:8787
`;
      await writeFile(path.join(TEST_DIR, '.env.development'), envDevContent);

      const result = await verifyAll('development', {
        devVarsPath: path.join(TEST_DIR, 'nonexistent.vars'),
        wranglerTomlPath: path.join(TEST_DIR, 'wrangler.toml'),
        envDevelopmentPath: path.join(TEST_DIR, '.env.development'),
      });

      expect(result.success).toBe(false);
      expect('error' in result.backend).toBe(true);
    });

    it('returns error object when frontend file is missing', async () => {
      const devVariablesContent = `NODE_ENV=development
`;
      await writeFile(path.join(TEST_DIR, '.dev.vars'), devVariablesContent);

      const result = await verifyAll('ciVitest', {
        devVarsPath: path.join(TEST_DIR, '.dev.vars'),
        wranglerTomlPath: path.join(TEST_DIR, 'wrangler.toml'),
        envDevelopmentPath: path.join(TEST_DIR, 'nonexistent.env'),
      });

      expect(result.success).toBe(false);
      expect('error' in result.frontend).toBe(true);
    });
  });

  describe('printVerificationResult', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('prints success message for successful verification', () => {
      const result = {
        success: true,
        actual: {
          isDev: true,
          isLocalDev: true,
          isDevServer: true,
          isProduction: false,
          isCI: false,
          isE2E: false,
          requiresRealServices: false,
        },
        expected: {
          isDev: true,
          isLocalDev: true,
          isDevServer: true,
          isProduction: false,
          isCI: false,
          isE2E: false,
          requiresRealServices: false,
        },
        mismatches: [],
        source: 'test/.dev.vars',
        input: { NODE_ENV: 'development' },
      };

      printVerificationResult('Backend', result);

      expect(console.log).toHaveBeenCalledWith('  ✓ Backend environment verification passed');
    });

    it('prints failure message for failed verification', () => {
      const result = {
        success: false,
        actual: {
          isDev: true,
          isLocalDev: true,
          isDevServer: true,
          isProduction: false,
          isCI: false,
          isE2E: false,
          requiresRealServices: false,
        },
        expected: {
          isDev: true,
          isLocalDev: false,
          isDevServer: false,
          isProduction: false,
          isCI: true,
          isE2E: false,
          requiresRealServices: true,
        },
        mismatches: [{ key: 'isCI' as const, expected: true, actual: false }],
        source: 'test/.dev.vars',
        input: { NODE_ENV: 'development' },
      };

      printVerificationResult('Backend', result);

      expect(console.error).toHaveBeenCalledWith('  ✗ Backend environment verification FAILED');
    });

    it('prints error message for error result', () => {
      const result = { error: 'File not found' };

      printVerificationResult('Frontend', result);

      expect(console.error).toHaveBeenCalledWith('  ✗ Frontend verification error: File not found');
    });
  });
});
