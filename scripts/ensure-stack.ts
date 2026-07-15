/**
 * Single orchestrator for "the stack is ready to be used."
 *
 * Every local consumer (pnpm dev / test / e2e / mobile:test / db:reset)
 * calls `ensureStack` first. The orchestrator owns:
 *
 *   - heartbeat tick (FIRST, before any check that depends on stack liveness —
 *     prevents the idle daemon from tearing down between our check and our
 *     subsequent work)
 *   - env file regeneration (cheap, always runs)
 *   - `pnpm install` when pnpm-lock.yaml changes
 *   - orphaned-compose cleanup (cheap when none exist)
 *   - container bring-up (compose up --wait, idempotent)
 *   - schema migration (skip when schema fingerprint hasn't changed)
 *   - dev-only tracking install (idempotent DDL)
 *   - idle daemon spawn (skip when already alive)
 *
 * There is no seed phase: seed data for the redesigned schema is not yet
 * defined (`pnpm db:seed` fails fast with the same message).
 *
 * The orchestrator assumes it has been invoked. The CI no-op decision lives
 * one layer up in `ensure-stack-cli.ts`, because in CI we must not even
 * regenerate env files — the workflow has already written CI-mode values
 * and any regen here would clobber them.
 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { StackMeta, SqlExecutor } from './lib/stack-meta.js';
import type { EnsureDaemonOptions } from './lib/idle-killer.js';

export interface EnsureStackOptions {
  repoRoot: string;
  slot: number;
  daemonScriptPath: string;
  idleTtlMs: number;
  idleDaemonPort: number;
  /** Force a docker volume wipe before bring-up. Used by `pnpm db:reset`. */
  wipe?: boolean;
}

export interface EnsureStackDeps {
  touchHeartbeat: (heartbeatPath: string) => Promise<void>;
  generateEnvFiles: (repoRoot: string) => void;
  installDeps: (repoRoot: string) => Promise<void>;
  cleanupOrphans: () => Promise<void>;
  ensureContainersHealthy: (repoRoot: string) => Promise<void>;
  runMigrations: (repoRoot: string) => Promise<void>;
  installDevTracking: (executor: SqlExecutor) => Promise<void>;
  /**
   * Dev-only: grants LOGIN to the migration-created `admin_sql_panel` role
   * (migrations create it NOLOGIN; the production password is minted
   * out-of-band, never in a migration). Idempotent, runs on every ensure so
   * a DB migrated by another path still gets it. Never a migration.
   */
  provisionAdminSqlPanelRole: (executor: SqlExecutor) => Promise<void>;
  readMeta: (executor: SqlExecutor) => Promise<StackMeta>;
  markClean: (executor: SqlExecutor, seedHash: string) => Promise<void>;
  composeDown: (repoRoot: string, options: { volumes: boolean }) => Promise<void>;
  ensureDaemonRunning: (options: EnsureDaemonOptions) => Promise<void>;
  readDepsHash: (cacheDir: string) => Promise<string | null>;
  writeDepsHash: (cacheDir: string, hash: string) => Promise<void>;
  computeDepsFingerprint: (repoRoot: string) => Promise<string>;
  computeMigrationFingerprint: (repoRoot: string) => Promise<string>;
  /** SQL executor — supplied by the CLI entry point, stubbed in tests. */
  sqlExecutor: SqlExecutor;
}

export function cacheDirFor(repoRoot: string, slot: number): string {
  return path.join(repoRoot, 'scripts', '.cache', 'local', String(slot));
}

export function heartbeatPathFor(cacheDir: string): string {
  return path.join(cacheDir, 'heartbeat');
}

/**
 * Extract the migration portion of a stored seed_hash; '' if malformed.
 * Pre-redesign local DBs store a composed "<migrationFp>:<seedFp>" value
 * (the retired seed phase wrote it); current code stores the bare migration
 * fingerprint. Splitting on ':' reads both.
 */
export function storedMigrationFp(seedHash: string): string {
  return seedHash.split(':')[0] ?? '';
}

async function tryReadMeta(
  deps: EnsureStackDeps,
  executor: SqlExecutor
): Promise<StackMeta | null> {
  try {
    return await deps.readMeta(executor);
  } catch (error) {
    // Two reasons this can throw:
    //   1. First-ever run — __stack_meta doesn't exist yet. Expected.
    //   2. Real DB error (connection refused, permission denied, etc.).
    // In both cases we fall through to migrate, which is the right recovery
    // for case 1 and surfaces the real failure mode for case 2. Log so the
    // original error isn't lost when migrate fails next.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`ensure-stack: optimistic readMeta failed (${message}); will run migrations.`);
    return null;
  }
}

async function ensureDepsInstalled(
  deps: EnsureStackDeps,
  options: EnsureStackOptions,
  cacheDir: string
): Promise<void> {
  const currentDepsFp = await deps.computeDepsFingerprint(options.repoRoot);
  const cachedDepsFp = await deps.readDepsHash(cacheDir);
  if (currentDepsFp !== cachedDepsFp) {
    await deps.installDeps(options.repoRoot);
    await deps.writeDepsHash(cacheDir, currentDepsFp);
  }
}

async function ensureSchemaReady(
  deps: EnsureStackDeps,
  options: EnsureStackOptions,
  migrationFp: string
): Promise<void> {
  // Optimistic skip: if the meta row already records this migration fingerprint
  // the schema is in sync — we can skip the ~5s drizzle-kit startup. The
  // optimistic read tolerates "table doesn't exist" (fresh DB).
  const optimisticMeta = options.wipe ? null : await tryReadMeta(deps, deps.sqlExecutor);
  const canSkipMigration =
    optimisticMeta !== null &&
    optimisticMeta.seededAt !== null &&
    storedMigrationFp(optimisticMeta.seedHash) === migrationFp;
  if (canSkipMigration) return;
  await deps.runMigrations(options.repoRoot);
  await deps.installDevTracking(deps.sqlExecutor);
  await deps.markClean(deps.sqlExecutor, migrationFp);
}

export async function ensureStack(
  options: EnsureStackOptions,
  deps: EnsureStackDeps
): Promise<void> {
  const cacheDir = cacheDirFor(options.repoRoot, options.slot);
  await mkdir(cacheDir, { recursive: true });

  // Heartbeat first — covers the race where the idle daemon polls between
  // our checks and our subsequent work.
  await deps.touchHeartbeat(heartbeatPathFor(cacheDir));

  if (options.wipe) {
    await deps.composeDown(options.repoRoot, { volumes: true });
  }

  deps.generateEnvFiles(options.repoRoot);
  await ensureDepsInstalled(deps, options, cacheDir);
  await deps.cleanupOrphans();
  await deps.ensureContainersHealthy(options.repoRoot);

  const migrationFp = await deps.computeMigrationFingerprint(options.repoRoot);
  await ensureSchemaReady(deps, options, migrationFp);
  await deps.provisionAdminSqlPanelRole(deps.sqlExecutor);

  await deps.ensureDaemonRunning({
    port: options.idleDaemonPort,
    cacheDir,
    daemonScriptPath: options.daemonScriptPath,
    slot: options.slot,
    ttlMs: options.idleTtlMs,
  });
}
