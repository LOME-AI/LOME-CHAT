/**
 * CLI entry point for `pnpm ensure-stack`. Composes the pure orchestrator in
 * ensure-stack.ts with real implementations of every dependency: docker, drizzle,
 * pnpm, filesystem, network. Nothing here is unit-tested directly — every
 * decision lives in the pure orchestrator. This file is the wiring.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { config as loadDotenv } from 'dotenv';
import { execa } from 'execa';
import { sql } from 'drizzle-orm';
import { createDb, LOCAL_NEON_DEV_CONFIG } from '@hushbox/db';
import { Mode, type EnvMode } from '@hushbox/shared';
import { fileFingerprint, treeFingerprint } from './lib/fingerprint.js';
import { installDevOnlyTracking, readMeta, markClean, type SqlExecutor } from './lib/stack-meta.js';
import { touchHeartbeat, ensureDaemonRunning } from './lib/idle-killer.js';
import { generateEnvFiles } from './generate-env.js';
import { cleanupOrphanedProjects } from './docker-cleanup.js';
import { killPorts, resolvePorts } from './kill-ports.js';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';
import { ensureStack, type EnsureStackDeps, type EnsureStackOptions } from './ensure-stack.js';
import { ensureMediaBucketReady, MEDIA_BUCKET } from './lib/minio-bucket-ready.js';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const DAEMON_SCRIPT = path.join(SCRIPTS_DIR, 'lib', 'idle-killer-daemon-entry.ts');

/**
 * Tables whose writes flip the `__stack_meta` dirty flag. Intentionally empty:
 * seeding uses an idempotent-mint-always model — `pnpm db:seed` re-mints every
 * persona and fixture on every run (see scripts/seed.ts), so there is no dirty
 * seed state to detect and no conditional re-seed to trigger. The stack-meta
 * dirty-tracking machinery stays parameterized but tracks nothing.
 */
const TRACKED_TABLES: readonly string[] = [];

const DOCKER_SERVICES = ['postgres', 'neon-proxy', 'redis', 'serverless-redis-http', 'minio'];

const DEFAULT_IDLE_TTL_MS = 60 * 60 * 1000;

/* v8 ignore start -- real-IO wiring; logic lives in tested pure helpers */

interface ComposeServiceLine {
  Service: string;
  Health?: string;
  State?: string;
}

async function allContainersHealthy(
  repoRoot: string,
  services: readonly string[]
): Promise<boolean> {
  const result = await execa('docker', ['compose', 'ps', '--format', 'json'], {
    cwd: repoRoot,
    env: process.env,
    reject: false,
  });
  if (result.exitCode !== 0) return false;
  const stdout = result.stdout.trim();
  if (!stdout) return false;
  // `docker compose ps --format json` outputs newline-delimited JSON, one
  // service per line. (Recent versions also support `--format=json` array form
  // — handle both.)
  let rows: ComposeServiceLine[];
  if (stdout.startsWith('[')) {
    rows = JSON.parse(stdout) as ComposeServiceLine[];
  } else {
    rows = stdout.split('\n').map((line) => JSON.parse(line) as ComposeServiceLine);
  }
  const healthyServices = new Set(
    rows
      // Services with a healthcheck must report Health: "healthy" (postgres,
      // redis, minio). Services without one (neon-proxy, serverless-redis-http
      // in older compose versions) report Health: "" — accept State: "running"
      // as the liveness signal in that case.
      .filter((r) => {
        if (r.Health === 'healthy') return true;
        if ((r.Health ?? '') === '' && r.State === 'running') return true;
        return false;
      })
      .map((r) => r.Service)
  );
  return services.every((s) => healthyServices.has(s));
}

function readArgument(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value;
}

export function parseCliArgs(argv: readonly string[]): {
  pristine: boolean;
  wipe: boolean;
  quiet: boolean;
  envMode: EnvMode;
} {
  const envModeArgument = readArgument(argv, '--env-mode');
  const envMode: EnvMode =
    envModeArgument === undefined ? Mode.Development : (envModeArgument as EnvMode);
  return {
    pristine: argv.includes('--pristine'),
    wipe: argv.includes('--wipe'),
    quiet: argv.includes('--quiet'),
    envMode,
  };
}

/** Hosts a dev-credential provisioning statement may ever run against. */
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

/**
 * Refuses to run the well-known-password `ALTER ROLE admin_sql_panel LOGIN`
 * against anything but a loopback database: with a production DATABASE_URL
 * in the environment, provisioning must fail instead of installing a
 * guessable login on the real database.
 */
export function assertLocalSqlProvisionTarget(databaseUrl: string): void {
  const host = new URL(databaseUrl).hostname;
  if (!LOCAL_DB_HOSTS.has(host)) {
    throw new Error(
      `ensure-stack: refusing to provision the admin_sql_panel LOGIN against non-local ` +
        `database host "${host}" — this dev-credential statement only runs on a local stack.`
    );
  }
}

function buildDeps(envMode: EnvMode): EnsureStackDeps {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL is required (run pnpm generate:env)');
  const db = createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });

  const executor: SqlExecutor = {
    async exec(query) {
      await db.execute(sql.raw(query));
    },
    async query<T>(query: string): Promise<T[]> {
      const result = await db.execute(sql.raw(query));
      return result.rows as T[];
    },
  };

  return {
    touchHeartbeat,
    generateEnvFiles: (repoRoot: string) => {
      generateEnvFiles(repoRoot, envMode);
    },
    installDeps: async (repoRoot) => {
      // No --frozen-lockfile: a developer editing pnpm-lock.yaml locally
      // should not have ensureStack reject the install. CI's setup-action
      // does run --frozen-lockfile separately for reproducibility.
      await execa('pnpm', ['install'], { cwd: repoRoot, stdio: 'inherit' });
    },
    cleanupOrphans: async () => {
      await cleanupOrphanedProjects({ dryRun: false }).catch((error: unknown) => {
        console.warn('docker-cleanup failed (non-fatal):', error);
      });
    },
    ensureContainersHealthy: async (repoRoot) => {
      // Fast-path probe: `docker compose ps --format json --status running`
      // returns the running service set in ~50ms. If every required service
      // is already up and healthy, skip the ~3-4s `compose up --wait` startup.
      if (!(await allContainersHealthy(repoRoot, DOCKER_SERVICES))) {
        await execa('docker', ['compose', 'up', '-d', '--wait', ...DOCKER_SERVICES], {
          cwd: repoRoot,
          stdio: 'inherit',
          env: process.env,
        });
      }
      // Storage readiness gates EVERY path, fast path included: healthy
      // containers do not imply the media bucket exists (cold volume, crash
      // between MinIO start and setup, volume wiped under warm containers).
      // Probe is ~100ms; the awaited `compose run` fires only when the
      // bucket is missing (`mc mb -p` is idempotent) and propagates mc's
      // exit code — unlike the old fire-and-forget `up -d minio-setup`,
      // which let the API serve `storage.put` before the bucket existed.
      await ensureMediaBucketReady({
        probeBucket: async () => {
          // Anonymous HEAD-bucket can't distinguish existence (MinIO answers
          // 403 either way) and signed S3 calls would need a new script dep,
          // so probe the storage truth directly: MinIO's single-drive layout
          // keeps each bucket as a top-level directory under /data.
          const probe = await execa(
            'docker',
            ['compose', 'exec', '-T', 'minio', 'sh', '-c', `test -d /data/${MEDIA_BUCKET}`],
            { cwd: repoRoot, env: process.env, reject: false }
          );
          return probe.exitCode === 0;
        },
        runBucketSetup: async () => {
          await execa('docker', ['compose', 'run', '--rm', 'minio-setup'], {
            cwd: repoRoot,
            stdio: 'inherit',
            env: process.env,
          });
        },
      });
    },
    runMigrations: async (repoRoot) => {
      await execa('pnpm', ['--filter', '@hushbox/db', 'db:migrate'], {
        cwd: repoRoot,
        stdio: 'inherit',
        env: process.env,
      });
    },
    installDevTracking: (executorArgument) =>
      installDevOnlyTracking(executorArgument, TRACKED_TABLES),
    // Local-only LOGIN for the SELECT-only SQL-panel role (matches the env
    // registry's Development ADMIN_SQL_PANEL_DATABASE_URL credentials). The
    // target guard makes "cannot run against production" a code property.
    provisionAdminSqlPanelRole: (executorArgument) => {
      assertLocalSqlProvisionTarget(databaseUrl);
      return executorArgument.exec("ALTER ROLE admin_sql_panel LOGIN PASSWORD 'admin_sql_panel'");
    },
    readMeta,
    markClean,
    composeDown: async (repoRoot, options) => {
      const args = ['compose', 'down', ...(options.volumes ? ['-v'] : [])];
      await execa('docker', args, {
        cwd: repoRoot,
        stdio: 'inherit',
        env: process.env,
      });
    },
    ensureDaemonRunning,
    readDepsHash: async (cacheDir) => {
      try {
        const contents = await readFile(path.join(cacheDir, 'deps.hash'), 'utf8');
        return contents.trim();
      } catch {
        return null;
      }
    },
    writeDepsHash: async (cacheDir, hash) => {
      await writeFile(path.join(cacheDir, 'deps.hash'), `${hash}\n`);
    },
    computeDepsFingerprint: (repoRoot) => fileFingerprint(path.join(repoRoot, 'pnpm-lock.yaml')),
    computeMigrationFingerprint: (repoRoot) =>
      treeFingerprint(path.join(repoRoot, 'packages', 'db', 'drizzle')),
    sqlExecutor: executor,
  };
}

// An absent HB_STACK_SLOT designates the main checkout, which worktree.ts
// assigns slot 0 (worktrees get 1..199). generate-env writes HB_STACK_SLOT=0
// for the main checkout, so absence only occurs when env was never generated —
// defaulting to 0 reproduces the main-checkout slot rather than failing. A
// present-but-invalid value (empty, non-integer, or negative) is a
// misconfiguration and fails fast.
function parseStackSlot(slotRaw: string | undefined): number {
  const slot = slotRaw === undefined ? 0 : Number(slotRaw);
  if (slotRaw?.trim() === '' || !Number.isInteger(slot) || slot < 0) {
    throw new Error(`ensure-stack: invalid HB_STACK_SLOT="${String(slotRaw)}"`);
  }
  return slot;
}

export function buildOptions(args: { pristine: boolean; wipe: boolean }): EnsureStackOptions {
  // `--pristine` is accepted as an explicit no-op — every ensureStack run is
  // pristine by design. Reference args.pristine so the unused-param check
  // doesn't fire when callers omit the flag.
  if (args.pristine) {
    /* explicit no-op */
  }
  const slot = parseStackSlot(process.env['HB_STACK_SLOT']);
  const idleDaemonPortRaw = process.env['HB_IDLE_DAEMON_PORT'];
  if (idleDaemonPortRaw === undefined) {
    throw new Error('ensure-stack: HB_IDLE_DAEMON_PORT not set (run pnpm generate:env)');
  }
  const idleDaemonPort = Number(idleDaemonPortRaw);
  if (!Number.isFinite(idleDaemonPort) || idleDaemonPort <= 0) {
    throw new Error(`ensure-stack: invalid HB_IDLE_DAEMON_PORT="${idleDaemonPortRaw}"`);
  }
  const ttlOverride = process.env['HB_STACK_IDLE_TTL_MS'];
  const idleTtlMs = ttlOverride === undefined ? DEFAULT_IDLE_TTL_MS : Number(ttlOverride);
  return {
    repoRoot: REPO_ROOT,
    slot,
    daemonScriptPath: DAEMON_SCRIPT,
    idleTtlMs,
    idleDaemonPort,
    wipe: args.wipe,
  };
}

/**
 * Playwright serves the E2E webServers (HB_PREVIEW_PORT, HB_API_PORT) and
 * spawns each detached in its own process group, reaping them only on a clean
 * shutdown. An interrupted run (Ctrl+C, a killed session) orphans them to init
 * still bound to their ports; because playwright.config sets
 * reuseExistingServer:false, the next run then aborts at "port already in use"
 * before a single test executes. Reclaiming the ports here lets an interrupted
 * run self-heal on the next invocation. E2E-only: dev/test share the same
 * ensure-stack entry but must not have servers torn out from under them.
 */
const E2E_WEBSERVER_PORT_ENVS = ['HB_PREVIEW_PORT', 'HB_API_PORT'] as const;

async function reclaimE2eWebserverPorts(): Promise<void> {
  await killPorts(resolvePorts(E2E_WEBSERVER_PORT_ENVS));
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  // CI is a no-op. CI workflows generate env files in a CI-specific mode
  // (with GitHub-secret bindings) before invoking any consumer; regenerating
  // here would overwrite those with Mode.Development values and drop the
  // secrets the tests depend on. Database lifecycle is likewise owned by the
  // workflow steps in CI.
  if (process.env['CI']) {
    if (!args.quiet) console.log('Stack ready (CI no-op).');
    return;
  }

  // Generate env first so HB_STACK_SLOT etc. are available, then load it.
  // Otherwise we'd need worktree detection in two places.
  generateEnvFiles(REPO_ROOT, args.envMode);
  loadDotenv({ path: path.join(REPO_ROOT, '.env.development'), override: true });
  loadDotenv({ path: path.join(REPO_ROOT, '.env.scripts'), override: true });

  if ((args.envMode as Mode) === Mode.E2E) {
    await reclaimE2eWebserverPorts();
  }

  const options = buildOptions(args);
  const deps = buildDeps(args.envMode);
  await ensureStack(options, deps);
  if (!args.quiet) console.log('Stack ready.');
}

if (
  isMainModule(import.meta.url) ||
  pathToFileURL(process.argv[1] ?? '').href === import.meta.url
) {
  await runMain(main);
}
/* v8 ignore stop */
