/**
 * Detached-process entry point for the idle-killer daemon. Spawned by
 * scripts/lib/idle-killer.ts via `child_process.spawn(node, [this-file, ...])`.
 * All logic lives in idle-killer-daemon.ts; this file is only the runtime
 * wiring (env reading, real network/fs/exec) and the `daemonLoop` invocation.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import {
  parseDaemonArgs,
  daemonLoop,
  bindSingleton,
  readHeartbeatMtime,
  portsHaveListeners,
  composeDown,
  sleep,
} from './idle-killer-daemon.js';
import { isMainModule } from './is-main.js';

/**
 * Read a required numeric env var, failing fast when it is absent, empty, or
 * non-numeric. `Number(undefined)` is NaN and `Number('')` is 0 — either would
 * silently feed a broken port into the daemon loop; naming the variable in the
 * throw surfaces the misconfiguration (CODE-RULES bans silent env fallbacks).
 */
export function requireNumericEnv(name: string): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    throw new TypeError(`${name} is not set or is empty`);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`${name} is not a valid number: ${raw}`);
  }
  return parsed;
}

/* v8 ignore start -- detached-subprocess entry; tested via idle-killer-daemon.test.ts */
async function main(): Promise<void> {
  const args = parseDaemonArgs(process.argv.slice(2));

  // Load env so we know which ports to monitor and which compose project we own.
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..', '..');
  loadDotenv({ path: path.join(repoRoot, '.env.scripts'), override: true });

  const apiPort = requireNumericEnv('HB_API_PORT');
  const vitePort = requireNumericEnv('HB_VITE_PORT');
  const previewPort = requireNumericEnv('HB_PREVIEW_PORT');
  // generate-env writes COMPOSE_PROJECT_NAME to .env.scripts in every mode
  // that spawns this daemon (ensure-stack regenerates env before spawning),
  // so absence means the environment was never generated — fail fast.
  const composeProject = process.env['COMPOSE_PROJECT_NAME'];
  if (!composeProject) {
    throw new Error('COMPOSE_PROJECT_NAME is not set — run pnpm generate:env first');
  }

  await daemonLoop(
    {
      port: args.port,
      slot: args.slot,
      cacheDir: args.cacheDir,
      ttlMs: args.ttlMs,
      pollMs: 60_000,
      composeProject,
      repoRoot,
      apiPort,
      vitePort,
      previewPort,
    },
    {
      bindSingleton,
      readHeartbeatMtime,
      portsHaveListeners,
      composeDown,
      sleep,
      now: () => Date.now(),
      log: (m) => {
        process.stdout.write(`${new Date().toISOString()} ${m}\n`);
      },
    }
  );
}

// Guard self-execution so tests can import this module's helpers without
// spawning the daemon (the spawned subprocess runs as the main module).
if (isMainModule(import.meta.url)) {
  void (async () => {
    try {
      await main();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`idle-killer-daemon error: ${message}\n`);
      process.exit(1);
    }
  })();
}
/* v8 ignore stop */
