import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  envConfig,
  Destination,
  Mode,
  isSecret,
  isProductionSecret,
  getDestinations,
  resolveValue,
  resolveRaw,
  type EnvMode,
  type VariableConfig,
} from '../packages/shared/src/env.config.js';
import { getWorktreeConfig, BASE_PORTS, type WorktreeConfig, type PortKey } from './worktree.js';
import { isMainModule } from './lib/is-main.js';

/**
 * Build variants for release workflows.
 * Each variant overrides specific frontend env vars in the generated build-env section.
 * Keys not in the overrides map use the default envConfig production values.
 */
const BUILD_VARIANTS: Record<string, Record<string, string>> = {
  'build-env': {
    VITE_APP_VERSION: '${{ needs.version.outputs.version }}',
  },
  'build-env-web-release': {
    VITE_PLATFORM: 'web',
    VITE_APP_VERSION: '${{ needs.prepare-version.outputs.version }}',
  },
  'build-env-android': {
    VITE_PLATFORM: '${{ inputs.vite-platform }}',
    VITE_APP_VERSION: '${{ inputs.version }}',
  },
  'build-env-mobile-test': {
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- Android emulator loopback; HTTPS not applicable
    VITE_API_URL: 'http://10.0.2.2:8787',
    VITE_PLATFORM: 'android-direct',
    VITE_APP_VERSION: 'ci-mobile-test',
  },
};

/**
 * Deploy secret overrides.
 * Keys here use the specified value instead of `${{ secrets.X }}` in
 * the generated deploy-secrets section. Used to source APP_VERSION
 * from the version job output rather than a GitHub secret.
 */
const DEPLOY_SECRET_OVERRIDES: Record<string, string> = {
  APP_VERSION: '${{ needs.version.outputs.version }}',
};

/**
 * Keys excluded from the manual ops runner's env block. APP_VERSION is computed
 * by the deploy pipeline's `version` job, which the standalone dispatch workflow
 * (`run-ops-script.yml`) has no access to — emitting its `needs.version`
 * reference there would be a dangling expression.
 */
const OPS_DISPATCH_OMIT_KEYS: ReadonlySet<string> = new Set(['APP_VERSION']);

const WORKFLOW_FILES = [
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  '.github/workflows/build-android.yml',
  '.github/workflows/run-ops-script.yml',
];

/**
 * Escape a value for dotenv format.
 * Always double-quote and escape internal double-quotes and backslashes.
 */
export function escapeEnvValue(value: string): string {
  // Escape backslashes first, then double quotes
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', String.raw`\"`);
  return `"${escaped}"`;
}

/**
 * Apply worktree port offsets to a resolved env value.
 * Replaces localhost:BASE_PORT with localhost:COMPUTED_PORT.
 */
export function applyWorktreePorts(value: string, worktree: WorktreeConfig): string {
  let result = value;
  for (const [key, base] of Object.entries(BASE_PORTS)) {
    const computed = worktree.ports[key as keyof typeof BASE_PORTS];
    result = result.replaceAll(`localhost:${String(base)}`, `localhost:${String(computed)}`);
  }
  return result;
}

/**
 * Generate port env lines for .env.scripts.
 * Always writes the HB_*_PORT vars (base ports for CI, worktree-offset ports for
 * dev) and HB_STACK_SLOT (0 for the main checkout, 1..199 for worktrees).
 * COMPOSE_PROJECT_NAME is written whenever a worktree config was resolved
 * (development and e2e modes) — the main checkout is not exempt; it receives the
 * slot-0 config with projectName "hushbox". Only CI/production modes (null
 * worktree) omit it. The idle-killer daemon fail-fasts on a missing
 * COMPOSE_PROJECT_NAME, which is sound only because every mode that spawns it
 * writes the variable — including the main checkout.
 */
function generatePortLines(
  ports: Record<PortKey, number>,
  worktree: WorktreeConfig | null
): string[] {
  const lines = ['', worktree ? '# Worktree configuration' : '# Port configuration'];
  if (worktree) {
    lines.push(`COMPOSE_PROJECT_NAME=${escapeEnvValue(worktree.projectName)}`);
  }
  // HB_STACK_SLOT is the worktree slot (0 for main, 1..199 for worktrees).
  // ensure-stack.ts and its helpers use it to scope per-slot cache/heartbeat
  // paths and the idle-daemon TCP sentinel.
  lines.push(
    `HB_STACK_SLOT=${escapeEnvValue(String(worktree?.slot ?? 0))}`,
    `HB_VITE_PORT=${escapeEnvValue(String(ports.vite))}`,
    `HB_PREVIEW_PORT=${escapeEnvValue(String(ports.preview))}`,
    `HB_API_PORT=${escapeEnvValue(String(ports.api))}`,
    `HB_POSTGRES_PORT=${escapeEnvValue(String(ports.postgres))}`,
    `HB_NEON_PORT=${escapeEnvValue(String(ports.neon))}`,
    `HB_REDIS_PORT=${escapeEnvValue(String(ports.redis))}`,
    `HB_REDIS_HTTP_PORT=${escapeEnvValue(String(ports.redisHttp))}`,
    `HB_ASTRO_PORT=${escapeEnvValue(String(ports.astro))}`,
    `HB_EMULATOR_ADB_PORT=${escapeEnvValue(String(ports.emulatorAdb))}`,
    `HB_EMULATOR_VNC_PORT=${escapeEnvValue(String(ports.emulatorVnc))}`,
    `HB_README_PREVIEW_PORT=${escapeEnvValue(String(ports.readmePreview))}`,
    `HB_MINIO_API_PORT=${escapeEnvValue(String(ports.minioApi))}`,
    `HB_MINIO_CONSOLE_PORT=${escapeEnvValue(String(ports.minioConsole))}`,
    `HB_STUDIO_PORT=${escapeEnvValue(String(ports.studio))}`,
    `HB_IDLE_DAEMON_PORT=${escapeEnvValue(String(ports.idleDaemon))}`
  );
  return lines;
}

/**
 * Generate all environment files from the single source of truth (env.config.ts).
 *
 * Destinations:
 * - Dest.Backend  → .dev.vars (local) / wrangler.toml + secrets (prod)
 * - Dest.Frontend → .env.development (Vite, VITE_* vars only)
 * - Dest.Scripts  → .env.scripts (migrations, seed, etc.)
 *
 * Modes:
 * - development (default): Generate files with development values
 * - ciVitest: Generate files for CI unit tests
 * - e2e: Local E2E tests (no secrets, adds VITE_E2E=true)
 * - ciE2E: CI E2E tests (inherits e2e + Helcim secrets from process.env)
 * - production: Ensure wrangler.toml has production values
 *
 * In development mode, worktree detection applies port offsets so
 * multiple worktrees can run simultaneously without collisions.
 */
function resolveWorktree(rootDir: string, mode: EnvMode): WorktreeConfig | null {
  const needsWorktree = (mode as Mode) === Mode.Development || (mode as Mode) === Mode.E2E;
  return needsWorktree ? getWorktreeConfig(rootDir) : null;
}

function writeBackendEnv(rootDir: string, backendLines: string[]): void {
  const devVariablesContent =
    ['# Auto-generated - do not edit', '', ...backendLines].join('\n') + '\n';
  writeFileSync(path.resolve(rootDir, 'apps/api/.dev.vars'), devVariablesContent);
  console.log('  Generated apps/api/.dev.vars');
  updateWranglerToml(rootDir);
  updateWorkflows(rootDir);
}

export function generateEnvFiles(
  rootDir: string,
  mode: EnvMode = Mode.Development,
  options: { skipBackend?: boolean } = {}
): void {
  // skipBackend generates only what a web bundle consumes (.env.development +
  // .env.scripts), skipping .dev.vars, wrangler, and the workflow rewrite. The
  // backend secrets are never referenced, so they are not required — used by
  // `build:e2e`, which builds the frontend and never reads the backend env.
  const { skipBackend = false } = options;
  const missing: string[] = [];
  const worktree = resolveWorktree(rootDir, mode);

  const getSecret = (name: string): string => {
    const val = process.env[name];
    if (!val) {
      missing.push(name);
      return ''; // Placeholder, will throw after collecting all missing
    }
    return val;
  };

  const generateLines = (destination: Destination): string[] =>
    Object.entries(envConfig)
      .filter(([, config]) => getDestinations(config as VariableConfig, mode).includes(destination))
      .map(([key, config]) => {
        let val = resolveValue(config as VariableConfig, mode, getSecret);
        /* istanbul ignore next -- @preserve defensive check */
        if (val === null) return null;
        if (worktree) {
          val = applyWorktreePorts(val, worktree);
        }
        return `${key}=${escapeEnvValue(val)}`;
      })
      .filter((line): line is string => line !== null);

  const backendLines = skipBackend ? [] : generateLines(Destination.Backend);
  const frontendLines = generateLines(Destination.Frontend);
  const scriptsLines = generateLines(Destination.Scripts);

  if (missing.length > 0) {
    throw new Error(`Missing required secrets in process.env: ${missing.join(', ')}`);
  }

  const envDevContent =
    [
      '# Auto-generated from packages/shared/src/env.config.ts',
      '# Do not edit directly - run: pnpm generate:env',
      '',
      ...frontendLines,
    ].join('\n') + '\n';
  writeFileSync(path.resolve(rootDir, '.env.development'), envDevContent);
  console.log('  Generated .env.development');

  const ports = worktree?.ports ?? BASE_PORTS;
  const portLines = generatePortLines(ports, worktree);
  const envScriptsContent =
    ['# Auto-generated - do not edit', '', ...scriptsLines, ...portLines].join('\n') + '\n';
  writeFileSync(path.resolve(rootDir, '.env.scripts'), envScriptsContent);
  console.log('  Generated .env.scripts');

  if (!skipBackend) {
    writeBackendEnv(rootDir, backendLines);
  }

  console.log('✓ All environment files generated');
}

/**
 * Update wrangler.toml with [vars] section containing production non-secret values.
 */
function updateWranglerToml(rootDir: string): void {
  const tomlPath = path.resolve(rootDir, 'apps/api/wrangler.toml');
  let content = readFileSync(tomlPath, 'utf8');

  content = content.replace(/\n?\[vars\][\s\S]*?(?=\n\[[^\]]+\]|$)/, '');

  // Build new [vars] section with production non-secret values from backend
  const variablesLines: string[] = ['', '[vars]'];
  for (const [key, config] of Object.entries(envConfig)) {
    const destinations = getDestinations(config as VariableConfig, Mode.Production);
    if (!destinations.includes(Destination.Backend)) continue;

    const raw = resolveRaw(config as VariableConfig, Mode.Production);
    // Only include literal production values (not secrets)
    if (raw && typeof raw === 'string') {
      variablesLines.push(`${key} = "${raw}"`);
    }
  }

  const secretKeys = getBackendSecretKeys();
  /* istanbul ignore next -- @preserve always true with current config */
  if (secretKeys.length > 0) {
    variablesLines.push('', '# Secrets deployed via CI (GitHub Secrets → wrangler secret put):');
    for (const key of secretKeys) {
      variablesLines.push(`# - ${key}`);
    }
  }

  writeFileSync(tomlPath, content.trimEnd() + variablesLines.join('\n') + '\n');
  console.log('  Updated apps/api/wrangler.toml [vars]');
}

/**
 * Get the list of backend keys that are secrets (for wrangler secret put).
 */
function getBackendSecretKeys(): string[] {
  return Object.entries(envConfig)
    .filter(([, config]) => {
      const destinations = getDestinations(config as VariableConfig, Mode.Production);
      return (
        destinations.includes(Destination.Backend) && isProductionSecret(config as VariableConfig)
      );
    })
    .map(([key]) => key);
}

/**
 * Replace a marked section in the CI workflow file.
 * Detects indentation from the BEGIN marker and applies it to generated content.
 */
function replaceSection(content: string, marker: string, newContent: string): string {
  const regex = new RegExp(
    String.raw`([ ]*)# BEGIN GENERATED: ${marker}\n[\s\S]*?# END GENERATED: ${marker}`,
    'g'
  );

  return content.replace(regex, (_, indent: string) => {
    const indentedContent = newContent
      .split('\n')
      .map((line) => (line ? indent + line : line))
      .join('\n');
    return `${indent}# BEGIN GENERATED: ${marker}\n${indentedContent}${indent}# END GENERATED: ${marker}`;
  });
}

/**
 * Generate a secrets env section for a given mode.
 * Uses the secret name for BOTH the env var name AND GitHub secret reference.
 */
function generateSecretsEnv(mode: EnvMode, destinations?: readonly Destination[]): string {
  const lines: string[] = ['env:'];

  for (const [, config] of Object.entries(envConfig)) {
    if (
      destinations &&
      !getDestinations(config as VariableConfig, mode).some((d) => destinations.includes(d))
    ) {
      continue;
    }
    const raw = resolveRaw(config as VariableConfig, mode);
    if (raw && isSecret(raw)) {
      lines.push(`  ${raw.name}: \${{ secrets.${raw.name} }}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Generate the ops-env section: a job-level env block exposing all
 * production backend secrets to the deploy job, keyed by their canonical
 * Worker-env-var name (the env.config.ts key) — not the GitHub secret name.
 *
 * Ops scripts (in `ops/`) read these via `process.env.<canonical>`. The
 * runner-env aliasing means a script reading `R2_S3_ENDPOINT` and
 * `AI_GATEWAY_API_KEY` works identically locally and in CI.
 *
 * Reuses {@link DEPLOY_SECRET_OVERRIDES} so APP_VERSION (computed by the
 * version job) resolves to the workflow output rather than a missing
 * GitHub secret.
 */
function generateOpsEnv(omitKeys: ReadonlySet<string> = new Set()): string {
  const lines: string[] = ['env:'];

  const entries = Object.entries(envConfig).filter(([key]) => !omitKeys.has(key));
  for (const [key, config] of entries) {
    const destinations = getDestinations(config as VariableConfig, Mode.Production);
    // Backend secrets the runtime Worker also gets, plus Ops-only secrets
    // (bucket-admin R2 creds) the runner needs but the Worker must never hold.
    if (!destinations.includes(Destination.Backend) && !destinations.includes(Destination.Ops)) {
      continue;
    }

    const raw = resolveRaw(config as VariableConfig, Mode.Production);
    if (!raw) continue;

    if (key in DEPLOY_SECRET_OVERRIDES) {
      // Override: e.g. APP_VERSION uses needs.version.outputs.version, not secrets.APP_VERSION
      lines.push(`  ${key}: ${DEPLOY_SECRET_OVERRIDES[key] ?? ''}`);
    } else if (isSecret(raw)) {
      // Backend secret — canonical worker key on LHS, GitHub secret name on RHS
      lines.push(`  ${key}: \${{ secrets.${raw.name} }}`);
    } else if (typeof raw === 'string') {
      // Backend literal (e.g. R2_BUCKET_MEDIA = "hushbox-media") — ops scripts
      // running on the runner need these in process.env alongside the secrets.
      lines.push(`  ${key}: ${raw}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Generate the build-env section (production frontend values).
 * Overrides replace envConfig values for specific keys (e.g., VITE_PLATFORM, VITE_APP_VERSION).
 */
function generateBuildEnv(overrides: Record<string, string> = {}): string {
  const lines: string[] = ['env:'];

  for (const [key, config] of Object.entries(envConfig)) {
    const destinations = getDestinations(config as VariableConfig, Mode.Production);
    if (!destinations.includes(Destination.Frontend)) continue;

    if (key in overrides) {
      lines.push(`  ${key}: ${overrides[key] ?? ''}`);
      continue;
    }

    const raw = resolveRaw(config as VariableConfig, Mode.Production);
    // All frontend vars have production values
    /* istanbul ignore next -- @preserve defensive check */
    if (!raw) continue;

    if (isSecret(raw)) {
      lines.push(`  ${key}: \${{ secrets.${raw.name} }}`);
      /* istanbul ignore next -- @preserve frontend prod is always secret or literal */
    } else if (typeof raw === 'string') {
      lines.push(`  ${key}: ${raw}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Generate the deploy-secrets section (wrangler secret put commands).
 */
function generateDeploySecrets(): string {
  const lines: string[] = [];

  for (const [key, config] of Object.entries(envConfig)) {
    const destinations = getDestinations(config as VariableConfig, Mode.Production);
    if (!destinations.includes(Destination.Backend)) continue;

    const raw = resolveRaw(config as VariableConfig, Mode.Production);
    if (raw && isSecret(raw)) {
      if (key in DEPLOY_SECRET_OVERRIDES) {
        const override = DEPLOY_SECRET_OVERRIDES[key] ?? '';
        lines.push(`echo "${override}" | pnpm exec wrangler secret put ${key}`);
      } else {
        lines.push(`echo "\${{ secrets.${raw.name} }}" | pnpm exec wrangler secret put ${key}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Generate the verify-secrets section (for loop of secret names).
 */
function generateVerifySecrets(): string {
  const secretKeys = getBackendSecretKeys();
  return `for secret in ${secretKeys.join(' ')}; do\n`;
}

/**
 * Generate the decode-google-services section (base64 decode command for workflow).
 */
function generateGoogleServicesDecode(): string {
  const config = envConfig.GOOGLE_SERVICES_JSON_BASE64;
  const raw = resolveRaw(config as VariableConfig, Mode.Production);
  /* istanbul ignore next -- @preserve defensive check */
  if (!raw || !isSecret(raw)) return '';

  const lines = [
    `run: echo "$GOOGLE_SERVICES_JSON_BASE64" | base64 -d > apps/web/android/app/google-services.json`,
    `env:`,
    `  GOOGLE_SERVICES_JSON_BASE64: \${{ secrets.${raw.name} }}`,
  ];
  return lines.join('\n') + '\n';
}

/**
 * Update workflow files with generated env sections.
 * Processes all known workflow files, applying all known markers.
 * replaceSection is a no-op when a marker doesn't exist in a file.
 */
export function updateWorkflows(rootDir: string): void {
  const sections: Record<string, string> = {
    'vitest-env': generateSecretsEnv(Mode.CiVitest),
    'e2e-env': generateSecretsEnv(Mode.CiE2E),
    'e2e-build-env': generateSecretsEnv(Mode.CiE2E, [Destination.Frontend, Destination.Scripts]),
    'ops-env': generateOpsEnv(),
    'ops-dispatch-env': generateOpsEnv(OPS_DISPATCH_OMIT_KEYS),
    'deploy-secrets': generateDeploySecrets(),
    'verify-secrets': generateVerifySecrets(),
    'decode-google-services': generateGoogleServicesDecode(),
  };

  for (const [marker, overrides] of Object.entries(BUILD_VARIANTS)) {
    sections[marker] = generateBuildEnv(overrides);
  }

  for (const relativePath of WORKFLOW_FILES) {
    const fullPath = path.resolve(rootDir, relativePath);
    if (!existsSync(fullPath)) continue;

    let content = readFileSync(fullPath, 'utf8');
    for (const [marker, generated] of Object.entries(sections)) {
      content = replaceSection(content, marker, generated);
    }
    writeFileSync(fullPath, content);
    console.log(`  Updated ${relativePath}`);
  }
}

export function parseArgs(args: string[]): EnvMode {
  const modeArgument = args.find((argument) => argument.startsWith('--mode='));
  if (modeArgument) {
    const parts = modeArgument.split('=');
    const mode = parts[1] ?? '';
    const validModes = Object.values(Mode);
    if (validModes.includes(mode as Mode)) {
      return mode as EnvMode;
    }
    throw new Error(`Invalid mode: ${mode}. Valid modes: ${validModes.join(', ')}`);
  }
  return Mode.Development;
}

/* v8 ignore start */
const isMain = isMainModule(import.meta.url);
if (isMain) {
  const mode = parseArgs(process.argv.slice(2));
  generateEnvFiles(process.cwd(), mode);
}
/* v8 ignore stop */
