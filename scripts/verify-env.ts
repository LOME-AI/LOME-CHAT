#!/usr/bin/env tsx
/**
 * Environment Verification Script
 *
 * Validates that generated env files produce correct createEnvUtilities() output.
 * Mirrors the real code paths used by backend (Cloudflare Workers) and frontend (Vite).
 *
 * Usage:
 *   pnpm verify:env --mode=development
 *   pnpm verify:env --mode=ciVitest
 *   pnpm verify:env --mode=e2e
 *   pnpm verify:env --mode=ciE2E
 *   pnpm verify:env --mode=production
 */
import { readFile } from 'node:fs/promises';
import {
  createEnvUtilities,
  envConfig,
  getModeValue,
  resolveRaw,
  type EnvContext,
  type EnvMode,
  type EnvUtilities,
  type VariableConfig,
} from '@hushbox/shared';
import { isMainModule } from './lib/is-main.js';
import { parseOrExit } from './lib/run-cli.js';

export type Mode = 'development' | 'ciVitest' | 'e2e' | 'ciE2E' | 'production';

interface FrontendEnvVariables {
  VITE_CI?: string | undefined;
  VITE_E2E?: string | undefined;
}

interface Mismatch {
  key: keyof EnvUtilities;
  expected: boolean;
  actual: boolean;
}

interface VerificationResult {
  success: boolean;
  actual: EnvUtilities;
  expected: EnvUtilities;
  mismatches: Mismatch[];
  source: string;
  input: EnvContext;
}

interface BackendPaths {
  devVarsPath: string;
  wranglerTomlPath: string;
}

interface FrontendPaths {
  envDevelopmentPath: string;
}

function stripQuotes(value: string): string {
  const isDoubleQuoted = value.startsWith('"') && value.endsWith('"');
  const isSingleQuoted = value.startsWith("'") && value.endsWith("'");
  return isDoubleQuoted || isSingleQuoted ? value.slice(1, -1) : value;
}

/**
 * Parse .dev.vars file to extract NODE_ENV, CI, E2E
 * Handles both quoted and unquoted values (e.g., NODE_ENV="development" or NODE_ENV=development)
 */
export async function parseDevVariables(filePath: string): Promise<EnvContext> {
  const content = await readFile(filePath, 'utf8');
  const lines = content.split('\n');
  const variables: Record<string, string> = {};

  for (const line of lines) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match?.[1] || match[2] === undefined) continue;
    variables[match[1]] = stripQuotes(match[2]);
  }

  return buildEnvContext(variables);
}

function buildEnvContext(variables: Record<string, string>): EnvContext {
  return {
    ...(variables['NODE_ENV'] !== undefined && { NODE_ENV: variables['NODE_ENV'] }),
    ...(variables['CI'] !== undefined && { CI: variables['CI'] }),
    ...(variables['E2E'] !== undefined && { E2E: variables['E2E'] }),
  };
}

/**
 * Parse wrangler.toml [vars] section to extract NODE_ENV
 */
export async function parseWranglerToml(filePath: string): Promise<EnvContext> {
  const content = await readFile(filePath, 'utf8');

  const variablesMatch = /\[vars\]([\s\S]*?)(?:\[|$)/.exec(content);
  if (!variablesMatch?.[1]) {
    return {};
  }

  const variablesSection = variablesMatch[1];
  const variables: Record<string, string> = {};

  const lineRegex = /^([A-Z_]+)\s*=\s*"([^"]*)"$/gm;
  let match;
  while ((match = lineRegex.exec(variablesSection)) !== null) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) {
      variables[key] = value;
    }
  }

  return buildEnvContext(variables);
}

/**
 * Parse .env.development file to extract VITE_CI
 */
export async function parseEnvDevelopment(filePath: string): Promise<FrontendEnvVariables> {
  const content = await readFile(filePath, 'utf8');
  const lines = content.split('\n');

  const variables: Record<string, string> = {};
  for (const line of lines) {
    const match = /^(VITE_[A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) {
      const key = match[1];
      const value = match[2];
      if (key !== undefined && value !== undefined) {
        variables[key] = value;
      }
    }
  }

  return {
    VITE_CI: variables['VITE_CI'],
    VITE_E2E: variables['VITE_E2E'],
  };
}

/**
 * Get expected EnvUtilities output for a given mode
 */
export function getExpectedEnvUtilities(mode: Mode): EnvUtilities {
  const expectations: Record<Mode, EnvUtilities> = {
    development: {
      isDev: true,
      isLocalDev: true,
      isDevServer: true,
      isProduction: false,
      isCI: false,
      isE2E: false,
      requiresRealServices: false,
    },
    ciVitest: {
      isDev: true,
      isLocalDev: false,
      isDevServer: false,
      isProduction: false,
      isCI: true,
      isE2E: false,
      requiresRealServices: true,
    },
    e2e: {
      isDev: true,
      isLocalDev: true,
      isDevServer: false,
      isProduction: false,
      isCI: false,
      isE2E: true,
      requiresRealServices: false,
    },
    ciE2E: {
      isDev: true,
      isLocalDev: false,
      isDevServer: false,
      isProduction: false,
      isCI: true,
      isE2E: true,
      requiresRealServices: true,
    },
    production: {
      isDev: false,
      isLocalDev: false,
      isDevServer: false,
      isProduction: true,
      isCI: false,
      isE2E: false,
      requiresRealServices: true,
    },
  };

  return expectations[mode];
}

/**
 * Compare actual vs expected EnvUtils and return mismatches
 */
function compareEnvUtilities(actual: EnvUtilities, expected: EnvUtilities): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const keys: (keyof EnvUtilities)[] = [
    'isDev',
    'isLocalDev',
    'isDevServer',
    'isProduction',
    'isCI',
    'isE2E',
    'requiresRealServices',
  ];

  for (const key of keys) {
    if (actual[key] !== expected[key]) {
      mismatches.push({
        key,
        expected: expected[key],
        actual: actual[key],
      });
    }
  }

  return mismatches;
}

/**
 * Build a VerificationResult from a resolved env context and source label.
 * Shared by verifyBackendEnv and verifyFrontendEnv to avoid duplicating
 * the createEnvUtilities → compare → return-result pattern.
 */
export function verifyEnvSource(
  mode: Mode,
  envContext: EnvContext,
  source: string
): VerificationResult {
  const actual = createEnvUtilities(envContext);
  const expected = getExpectedEnvUtilities(mode);
  const mismatches = compareEnvUtilities(actual, expected);

  return {
    success: mismatches.length === 0,
    actual,
    expected,
    mismatches,
    source,
    input: envContext,
  };
}

/**
 * Verify backend environment for a given mode
 */
export async function verifyBackendEnv(
  mode: Mode,
  paths: BackendPaths
): Promise<VerificationResult> {
  let envContext: EnvContext;
  let source: string;

  if (mode === 'production') {
    envContext = await parseWranglerToml(paths.wranglerTomlPath);
    source = paths.wranglerTomlPath;
  } else {
    envContext = await parseDevVariables(paths.devVarsPath);
    source = paths.devVarsPath;
  }

  return verifyEnvSource(mode, envContext, source);
}

/**
 * Verify frontend environment for a given mode
 */
export async function verifyFrontendEnv(
  mode: Mode,
  paths: FrontendPaths
): Promise<VerificationResult> {
  let envContext: EnvContext;
  let source: string;

  if (mode === 'production') {
    // Production frontend uses Vite MODE=production, no .env.development
    envContext = { NODE_ENV: 'production' };
    source = 'Vite MODE=production (no file)';
  } else {
    // Dev/CI modes use .env.development for VITE_CI
    const frontendVariables = await parseEnvDevelopment(paths.envDevelopmentPath);
    // Frontend uses import.meta.env.MODE which is 'development' in dev/CI builds
    envContext = {
      NODE_ENV: 'development',
      ...(frontendVariables.VITE_CI !== undefined && { CI: frontendVariables.VITE_CI }),
      ...(frontendVariables.VITE_E2E !== undefined && { E2E: frontendVariables.VITE_E2E }),
    };
    source = `${paths.envDevelopmentPath} + MODE=development`;
  }

  return verifyEnvSource(mode, envContext, source);
}

/**
 * Format EnvUtilities as a string for display
 */
export function formatEnvUtilities(env: EnvUtilities): string {
  return `isDev=${String(env.isDev)}, isLocalDev=${String(env.isLocalDev)}, isDevServer=${String(env.isDevServer)}, isProduction=${String(env.isProduction)}, isCI=${String(env.isCI)}, isE2E=${String(env.isE2E)}, requiresRealServices=${String(env.requiresRealServices)}`;
}

/**
 * Format EnvContext as a string for display
 */
export function formatEnvContext(ctx: EnvContext): string {
  return `NODE_ENV=${ctx.NODE_ENV ?? 'undefined'}, CI=${ctx.CI ?? 'undefined'}, E2E=${ctx.E2E ?? 'undefined'}`;
}

/**
 * Parse CLI arguments and return the mode
 */
export function parseCliArgs(args: string[]): { mode: Mode } | { error: string } {
  const modeArgument = args.find((argument) => argument.startsWith('--mode='));

  if (!modeArgument) {
    return { error: 'Usage: pnpm verify:env --mode=<development|ciVitest|e2e|ciE2E|production>' };
  }

  const mode = modeArgument.replace('--mode=', '');
  const validModes: Mode[] = ['development', 'ciVitest', 'e2e', 'ciE2E', 'production'];

  if (!validModes.includes(mode as Mode)) {
    return { error: `Invalid mode: ${mode}. Valid modes: ${validModes.join(', ')}` };
  }

  return { mode: mode as Mode };
}

export interface VerifyAllResult {
  backend: VerificationResult | { error: string };
  frontend: VerificationResult | { error: string };
  success: boolean;
}

/**
 * Run verification for both backend and frontend
 */
export async function verifyAll(
  mode: Mode,
  paths: BackendPaths & FrontendPaths
): Promise<VerifyAllResult> {
  let backend: VerificationResult | { error: string };
  let frontend: VerificationResult | { error: string };

  try {
    backend = await verifyBackendEnv(mode, paths);
  } catch (error) {
    backend = { error: (error as Error).message };
  }

  try {
    frontend = await verifyFrontendEnv(mode, paths);
  } catch (error) {
    frontend = { error: (error as Error).message };
  }

  const backendSuccess = !('error' in backend) && backend.success;
  const frontendSuccess = !('error' in frontend) && frontend.success;

  return {
    backend,
    frontend,
    success: backendSuccess && frontendSuccess,
  };
}

/**
 * A registry key that is declared for a mode but fails to resolve to a present
 * value for it (e.g. a `ref()` chain terminating in a mode that omits the key).
 */
export interface MissingKey {
  mode: EnvMode;
  key: string;
}

/**
 * The modes whose per-key completeness is asserted. `e2e` is intentionally
 * omitted here (a local-e2e convenience mode): the deployable modes plus the
 * two CI modes are the ones a missing key would silently break.
 */
export const VERIFIED_MODES: EnvMode[] = ['development', 'ciVitest', 'ciE2E', 'production'];

/**
 * Assert per-key presence per mode against the env registry. For each mode, a
 * key the registry DECLARES for that mode (`getModeValue` returns a value) must
 * also RESOLVE to a present value (`resolveRaw` returns a literal or a secret
 * directive, never `undefined`). A declared key that resolves to `undefined` —
 * a dangling `ref()` — is a missing required key. Derived-flag verification
 * cannot see this: it only checks the handful of NODE_ENV/CI/E2E keys the flags
 * derive from. The registry is the sole source of which keys each mode requires.
 */
export function findMissingKeys(
  registry: Record<string, VariableConfig>,
  modes: EnvMode[] = VERIFIED_MODES
): MissingKey[] {
  const missing: MissingKey[] = [];
  for (const mode of modes) {
    for (const [key, config] of Object.entries(registry)) {
      const declared = getModeValue(config, mode) !== undefined;
      if (!declared) continue;
      if (resolveRaw(config, mode) === undefined) {
        missing.push({ mode, key });
      }
    }
  }
  return missing;
}

/** Per-key failure message naming the specific missing key and its mode. */
export function missingKeyMessage(missing: MissingKey): string {
  return `  ✗ Missing required env key "${missing.key}" for mode "${missing.mode}"`;
}

/**
 * Verify per-key completeness of the env registry across {@link VERIFIED_MODES}
 * and print a per-key message for every missing key. Returns `true` when every
 * declared key resolves in every verified mode.
 */
export function verifyRegistryKeys(registry: Record<string, VariableConfig> = envConfig): boolean {
  const missing = findMissingKeys(registry);
  if (missing.length === 0) return true;
  console.error('\n  Env registry per-key completeness FAILED:');
  for (const entry of missing) {
    console.error(missingKeyMessage(entry));
  }
  return false;
}

/**
 * Print verification result for a target (backend/frontend)
 */
export function printVerificationResult(
  target: 'Backend' | 'Frontend',
  result: VerificationResult | { error: string }
): void {
  if ('error' in result) {
    console.error(`  ✗ ${target} verification error: ${result.error}`);
    return;
  }

  if (result.success) {
    console.log(`  ✓ ${target} environment verification passed`);
    console.log(`    Source: ${result.source}`);
    console.log(`    Input: ${formatEnvContext(result.input)}`);
    console.log(`    Output: ${formatEnvUtilities(result.actual)}`);
  } else {
    console.error(`  ✗ ${target} environment verification FAILED`);
    console.error(`    Source: ${result.source}`);
    console.error(`    Input: ${formatEnvContext(result.input)}`);
    for (const mismatch of result.mismatches) {
      console.error(`    Expected: ${mismatch.key}=${String(mismatch.expected)}`);
      console.error(`    Actual:   ${mismatch.key}=${String(mismatch.actual)}`);
    }
  }
}

/* v8 ignore start -- CLI entry point uses process.exit, tested via integration */
/**
 * Main CLI entry point
 */
async function main(): Promise<void> {
  const { mode } = parseOrExit(parseCliArgs);

  const paths = {
    devVarsPath: 'apps/api/.dev.vars',
    wranglerTomlPath: 'apps/api/wrangler.toml',
    envDevelopmentPath: '.env.development',
  };

  console.log(`\nVerifying environment for mode: ${mode}`);

  const result = await verifyAll(mode, paths);

  console.log('\nBackend:');
  printVerificationResult('Backend', result.backend);

  console.log('\nFrontend:');
  printVerificationResult('Frontend', result.frontend);

  console.log('\nRegistry per-key completeness:');
  const registryOk = verifyRegistryKeys();

  if (!result.success || !registryOk) {
    console.error('\nEnvironment verification failed. Check env.config.ts or generate-env.ts.');
    process.exit(1);
  }

  console.log('\n✓ All environment verifications passed');
}

if (isMainModule(import.meta.url)) {
  void (async () => {
    try {
      await main();
    } catch (error: unknown) {
      console.error('Unexpected error:', error);
      process.exit(1);
    }
  })();
}
/* v8 ignore stop */
