/**
 * Playwright global setup: a hard storage-readiness precondition, plus a
 * once-per-run GPU-renderer diagnostic.
 *
 * The GPU probe is purely informational — no assertions, no gating. It answers
 * "are the browsers actually using the GPU, or silently falling back to
 * software?" without any OS-specific tool (no vulkaninfo/glxinfo): it asks the
 * browser itself via WebGL's UNMASKED_RENDERER_WEBGL, so it works identically
 * on any platform. Runs once (≤3 engine launches), never per-test.
 *
 * The media-bucket gate DOES block the run. Container health is not storage
 * readiness: MinIO can be healthy while `hushbox-media-dev` does not exist
 * (cold volume, a volume wiped under warm containers, or a crash between MinIO
 * start and setup), and without the bucket every media `storage.put` becomes
 * `NoSuchBucket` → UNAVAILABLE mid-run. Binding the gate here — not only to the
 * stack bring-up in ensure-stack/`db:up` — guarantees the bucket for THIS
 * `playwright test` invocation however the stack was started. It reuses the
 * single readiness mechanism (`ensureMediaBucketReady`), never a second one.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from '@playwright/test';
import { execa } from 'execa';
import { touchHeartbeat } from '../scripts/lib/idle-killer.js';
import { ensureMediaBucketReady } from '../scripts/lib/minio-bucket-ready.js';
import { createDockerBucketReadyDeps } from '../scripts/lib/minio-bucket-ready-docker.js';
import type { BrowserType } from '@playwright/test';

const ENGINES: readonly { name: string; type: BrowserType }[] = [
  { name: 'chromium', type: chromium },
  { name: 'firefox', type: firefox },
  { name: 'webkit', type: webkit },
];

function classify(renderer: string): 'hardware' | 'software' {
  return /swiftshader|llvmpipe|software|\bwarp\b/i.test(renderer) ? 'software' : 'hardware';
}

async function readRenderer(type: BrowserType): Promise<string> {
  const browser = await type.launch();
  try {
    const page = await browser.newPage();
    return await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const gl = (canvas.getContext('webgl') ??
        canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
      if (!gl) return 'no WebGL';
      const extension = gl.getExtension('WEBGL_debug_renderer_info');
      const value: unknown = extension
        ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER);
      return typeof value === 'string' && value.length > 0 ? value : 'unknown';
    });
  } finally {
    await browser.close();
  }
}

/**
 * Clear billing admission state (holds + snapshots) once for this run so a
 * previous run's stale hold on a reused worker wallet cannot bleed a false
 * INSUFFICIENT_ADMISSION into the first tests. Per-test cleanup deliberately no
 * longer touches admission state (a global wipe races parallel workers), so
 * this once-per-run clear is the clean baseline; during the run, per-worker
 * wallet isolation plus the hold/snapshot TTLs keep it healthy.
 *
 * Best-effort: Playwright spawns the webServer in parallel with globalSetup, so
 * the Worker may not yet answer here. A miss is harmless — the admission TTLs
 * self-heal — but it is logged, never silently swallowed.
 */
async function clearAdmissionState(): Promise<void> {
  const apiUrl = process.env['VITE_API_URL'];
  if (apiUrl === undefined || apiUrl === '') {
    throw new Error('VITE_API_URL must be set for E2E global setup');
  }
  try {
    const response = await fetch(`${apiUrl}/dev/admission-state`, { method: 'DELETE' });
    if (!response.ok) {
      console.warn(
        `[global-setup] admission-state clear returned ${String(response.status)} (baseline relies on TTLs)`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[global-setup] admission-state clear unreachable: ${message} (baseline relies on TTLs)`
    );
  }
}

async function tickStackHeartbeat(): Promise<void> {
  const slot = process.env['HB_STACK_SLOT'];
  if (slot === undefined) return;
  const e2eDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(e2eDir, '..');
  const heartbeatPath = path.join(repoRoot, 'scripts', '.cache', 'local', slot, 'heartbeat');
  try {
    await touchHeartbeat(heartbeatPath);
  } catch {
    /* best-effort */
  }
}

async function ensureMediaBucket(): Promise<void> {
  const e2eDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(e2eDir, '..');
  const deps = createDockerBucketReadyDeps(async (args, options) => {
    const result = await execa('docker', [...args], {
      cwd: repoRoot,
      stdio: options.inheritStdio ? 'inherit' : 'pipe',
      env: process.env,
      reject: false,
    });
    return { exitCode: result.exitCode ?? 1 };
  });
  await ensureMediaBucketReady(deps);
}

export default async function globalSetup(): Promise<void> {
  // Hard precondition first: a missing media bucket must abort the run before
  // any browser launches, not surface later as a mid-run UNAVAILABLE.
  await ensureMediaBucket();

  await tickStackHeartbeat();

  await clearAdmissionState();

  // Probe engines concurrently (independent browsers); mapped in ENGINES order.
  const probes = await Promise.all(
    ENGINES.map(async ({ name, type }) => {
      try {
        const renderer = await readRenderer(type);
        return `  ${name.padEnd(9)} ${renderer}  [${classify(renderer)}]`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `  ${name.padEnd(9)} (probe skipped: ${message})`;
      }
    })
  );
  const lines = ['', 'GPU renderers (this run):', ...probes];
  // eslint-disable-next-line no-console -- informational once-per-run diagnostic
  console.log(lines.join('\n'));
}
