/**
 * Vitest setup file — ticks the per-slot heartbeat once per test process so
 * the idle-killer daemon doesn't tear the stack down mid-run, and installs a
 * network-block guard so a test can't make an unexpected real external call.
 * Imported via the shared vitest config in packages/config/vitest.config.ts.
 *
 * No imports from outside scripts/ — this file is loaded by every Vitest
 * worker and should stay dependency-light.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { touchHeartbeat } from './idle-killer.js';

/* v8 ignore start -- runs as a side-effect on import; behavior validated via integration */
async function tickHeartbeatBestEffort(): Promise<void> {
  const slot = process.env['HB_STACK_SLOT'];
  if (slot === undefined) return;
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptsDir, '..', '..');
  const heartbeatPath = path.join(repoRoot, 'scripts', '.cache', 'local', slot, 'heartbeat');
  try {
    await touchHeartbeat(heartbeatPath);
  } catch {
    /* best-effort — ignore */
  }
}

void tickHeartbeatBestEffort();
/* v8 ignore stop */

/*
 * Network-block guard (audit F59).
 *
 * Tests hit real LOCAL infra over HTTP — neon-proxy (:4444), Serverless-Redis-
 * HTTP (:8079), MinIO (:9000), Wrangler (:8787) — but must never make an
 * unexpected REAL external call: CI's doctrine is 100% cassette hits for AI
 * calls (a miss is a failure, not a recording). This wraps `globalThis.fetch`
 * so loopback hosts delegate to the real fetch and any other host throws.
 *
 * Inert in CI. The intentional real-API / `verify:evidence` tests are gated on
 * `process.env.CI` (mirroring @hushbox/shared's `isCI = Boolean(env.CI)`) and
 * deliberately reach external hosts; CI's AI-call net is the cassette
 * replay-only layer (`cassetteModeFor` throws `CassetteMissError`), not this
 * coarse stub. So the stub's home is local vitest, where a stray uninjected
 * fetch would otherwise silently hit the network during `pnpm test`.
 *
 * Inert in the workerd pool too: those projects (`vitest.workers.config.ts`)
 * are standalone configs that never load this setup file, so nothing here runs
 * under `@cloudflare/vitest-pool-workers`.
 *
 * `process.env` is read directly (not `createEnvUtilities`) because this file
 * must stay dependency-light — it cannot import `@hushbox/shared` — and already
 * reads `process.env` for the heartbeat slot above.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/** Resolve the target hostname from any fetch input; relative URLs → localhost. */
export function resolveTargetHost(input: string | URL | Request): string | undefined {
  let raw: string;
  if (typeof input === 'string') {
    raw = input;
  } else if (input instanceof URL) {
    raw = input.href;
  } else {
    raw = input.url;
  }
  try {
    // Base makes relative URLs resolve to localhost (a local target); data:/
    // blob: URLs resolve to an empty host (no network).
    return new URL(raw, 'http://localhost').hostname;
  } catch {
    return undefined;
  }
}

/** Loopback, the reserved `.localhost` TLD, and the empty host all count as local. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.replaceAll(/^\[|\]$/g, '').toLowerCase();
  return host === '' || host.endsWith('.localhost') || LOOPBACK_HOSTS.has(host);
}

/** Enabled everywhere except CI (where real-API tests intentionally hit external hosts). */
export function networkGuardEnabled(env: NodeJS.ProcessEnv): boolean {
  return !env['CI'];
}

/** Wrap a fetch so external hosts throw and local hosts pass through. */
export function createNetworkGuard(realFetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return function guardedFetch(input, init) {
    const host = resolveTargetHost(input as string | URL | Request);
    if (host === undefined || isLocalHost(host)) {
      return realFetch(input, init);
    }
    throw new Error(
      `network access blocked in tests: fetch to "${host}" — use a cassette or a ` +
        'scripted/mock fetch (see docs/CODE-RULES.md: the CI hot path is 100% cassette hits).'
    );
  };
}

/* v8 ignore start -- global install runs once on import; the guard logic above is unit-tested */
if (networkGuardEnabled(process.env)) {
  globalThis.fetch = createNetworkGuard(globalThis.fetch.bind(globalThis));
}
/* v8 ignore stop */
