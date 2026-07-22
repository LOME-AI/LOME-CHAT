/* eslint-disable no-restricted-syntax -- mobile-test.ts is gated to Linux via assertLinux() and intentionally shells out to mkdir/curl/unzip/bash for one-shot SDK installation on the CI runner. */
import AdmZip from 'adm-zip';
import { execa } from 'execa';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isMainModule } from './lib/is-main.js';
import { bakeImage, detectKvmGid, runEmulatorContainer } from './lib/mobile-image.js';
import { MARKER_PREFIX, extractRelevantSlice } from './lib/extract-mobile-api-log.js';
import { wranglerLogPath } from './wrangler-dev.js';
import { SHARDS } from '../mobile-tests/config.js';

const APK_PATH = 'apps/web/android/app/build/outputs/apk/debug/app-debug.apk';
// Cold boot on budtmo/docker-android (no quick-boot snapshot baked in) takes
// 30-60 s on a quiet host. On the Blacksmith 4-vCPU runner with two emulator
// containers KVM-accelerating in parallel against a contended CPU, observed
// boots have reached ~5 minutes. 600 s = 10 min leaves enough headroom that
// the timeout fires on a genuinely-wedged emulator, not on a slow-but-healthy
// one. Drop back down once a snapshot-baking path is back in service.
const BOOT_TIMEOUT_POLLS = 300;
const BOOT_POLL_INTERVAL_MS = 2000;
const BOOT_DIAGNOSTIC_INTERVAL = 10;
const API_TIMEOUT_POLLS = 30;
const API_POLL_INTERVAL_MS = 1000;
const CONTAINER_NAME_PREFIX = 'hushbox-mobile-emulator-shard-';
const FLOW_DIR = 'mobile-tests/flows';
const OTA_FLOW = 'mobile-tests/flows/13-ota-update.yaml';
const RESULTS_DIR = 'maestro-results';

function baseAdbPort(): number {
  // Honor HB_EMULATOR_ADB_PORT (set by scripts/generate-env per worktree slot)
  // so multiple worktrees can run mobile tests on disjoint port ranges. Each
  // worktree's base + 2*shard then spaces shards within the worktree. It is
  // generator-supplied like HB_API_PORT, so an absent or invalid value means env
  // was never generated; fail fast naming the variable rather than silently
  // defaulting (CODE-RULES bans silent env fallbacks).
  const raw = requireEnv('HB_EMULATOR_ADB_PORT', WITH_ENV_HINT);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`HB_EMULATOR_ADB_PORT is not a valid port: "${raw}". ${WITH_ENV_HINT}`);
  }
  return parsed;
}

export function parseArgs(args: string[]): { smoke: boolean } {
  return { smoke: args.includes('--smoke') };
}

/**
 * Fail-fast env read — no fallback values. A missing variable means the
 * environment was never generated or the script ran outside its wrapper;
 * defaulting silently would mask that (CODE-RULES bans env fallbacks).
 */
export function requireEnv(name: string, hint?: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(hint === undefined ? `${name} not set.` : `${name} not set. ${hint}`);
  }
  return value;
}

const WITH_ENV_HINT = 'Ensure the script is run via with-env.';

function requireApiPort(): string {
  return requireEnv('HB_API_PORT', WITH_ENV_HINT);
}

/**
 * Each shard gets a distinct host ADB port. Emulators internally bind to
 * 5554 (console) and 5555 (adb); we map 5555 → 5555 + 2*shard so adjacent
 * shards don't collide and there's room for a per-shard console port if
 * needed in the future.
 */
export function adbPortForShard(shard: number): number {
  return baseAdbPort() + shard * 2;
}

export function containerNameForShard(shard: number): string {
  return `${CONTAINER_NAME_PREFIX}${String(shard)}`;
}

export function debugOutputForShard(shard: number): string {
  return path.join(RESULTS_DIR, `shard-${String(shard)}`);
}

/**
 * Mobile tests depend on KVM acceleration, Docker host networking, and
 * Linux-style filesystem paths used by the android-emulator service. Fail
 * fast on other platforms so the user gets a clear error instead of opaque
 * downstream failures.
 */
export function assertLinux(): void {
  if (process.platform !== 'linux') {
    throw new Error(
      `mobile-test is Linux-only (requires KVM and Docker host networking). Current platform: ${process.platform}.`
    );
  }
}

export async function checkPrerequisites(): Promise<void> {
  try {
    await execa('docker', ['info'], { stdio: 'ignore' });
  } catch {
    throw new Error('Docker is not running. Start Docker and try again.');
  }

  if (!existsSync('/dev/kvm')) {
    throw new Error('/dev/kvm not found. KVM is required for Android emulator acceleration.');
  }
}

export async function installMaestro(): Promise<void> {
  try {
    await execa('maestro', ['--version'], { stdio: 'ignore' });
    console.log('Maestro CLI found');
  } catch {
    console.log('Installing Maestro CLI...');
    await execa('bash', ['-c', 'curl -fsSL "https://get.maestro.mobile.dev" | bash'], {
      stdio: 'inherit',
    });
    const home = requireEnv('HOME');
    process.env['PATH'] = `${home}/.maestro/bin:${requireEnv('PATH')}`;
  }
}

function androidSdkRoot(): string {
  return `${requireEnv('HOME')}/Android/Sdk`;
}

const CMDLINE_TOOLS_URL =
  'https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip';
const REQUIRED_PLATFORM = 'android-36';

export async function installAndroidSdk(): Promise<void> {
  const androidHome = process.env['ANDROID_HOME'];
  let home: string;
  if (androidHome && existsSync(`${androidHome}/platforms/${REQUIRED_PLATFORM}`)) {
    home = androidHome;
    console.log('Android SDK found');
  } else {
    const sdkRoot = androidSdkRoot();
    if (existsSync(`${sdkRoot}/platforms/${REQUIRED_PLATFORM}`)) {
      console.log('Android SDK found');
    } else {
      console.log('Installing Android SDK command-line tools...');
      await execa('mkdir', ['-p', `${sdkRoot}/cmdline-tools`]);
      // eslint-disable-next-line sonarjs/publicly-writable-directories -- /tmp is standard for CI SDK downloads
      await execa('curl', ['-fsSL', '-o', '/tmp/cmdline-tools.zip', CMDLINE_TOOLS_URL], {
        stdio: 'inherit',
      });
      await execa(
        'unzip',
        // eslint-disable-next-line sonarjs/publicly-writable-directories -- /tmp is standard for CI SDK downloads
        ['-q', '-o', '/tmp/cmdline-tools.zip', '-d', `${sdkRoot}/cmdline-tools`],
        {
          stdio: 'inherit',
        }
      );
      await execa('mv', [
        `${sdkRoot}/cmdline-tools/cmdline-tools`,
        `${sdkRoot}/cmdline-tools/latest`,
      ]);

      const sdkmanager = `${sdkRoot}/cmdline-tools/latest/bin/sdkmanager`;

      console.log('Accepting Android SDK licenses...');
      await execa('bash', ['-c', `yes | ${sdkmanager} --licenses`], { stdio: 'pipe' });

      console.log(`Installing platforms;${REQUIRED_PLATFORM}...`);
      await execa(sdkmanager, [`platforms;${REQUIRED_PLATFORM}`, 'platform-tools'], {
        stdio: 'inherit',
      });
    }
    process.env['ANDROID_HOME'] = sdkRoot;
    home = sdkRoot;
  }

  process.env['PATH'] = `${home}/platform-tools:${requireEnv('PATH')}`;
}

function extractErrorDetail(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr ?? '';
  const shortMessage = (error as { shortMessage?: string }).shortMessage ?? '';
  return stderr || shortMessage || (error instanceof Error ? error.message : String(error));
}

async function disconnectStaleAdb(host: string): Promise<void> {
  await execa('adb', ['disconnect', host], { stdio: 'pipe' }).catch(() => {
    // Disconnect can fail if there's no entry to remove; that's fine.
  });
}

async function tryAdbConnect(host: string, index: number): Promise<boolean> {
  const connectResult = await execa('adb', ['connect', host], { stdio: 'pipe' });
  const connectOutput = connectResult.stdout.trim();
  // adb connect returns exit 0 even on failure with output like
  // "unable to connect", "failed to connect", or "device offline".
  // "device offline" happens when adb's local device table holds a stale
  // half-dead entry from a previous broken session — `adb disconnect`
  // clears it so the next iteration's connect attempt starts clean.
  const connectFailed =
    !connectOutput.includes('connected to') ||
    connectOutput.includes('unable') ||
    connectOutput.includes('offline');
  if (!connectFailed) {
    return true;
  }
  if (index % BOOT_DIAGNOSTIC_INTERVAL === 0) {
    console.log(`[poll ${String(index)}] adb connect ${host}: ${connectOutput}`);
  }
  if (connectOutput.includes('offline')) {
    await disconnectStaleAdb(host);
  }
  return false;
}

async function probeBootProperty(host: string, property: string, index: number): Promise<boolean> {
  const result = await execa('adb', ['-s', host, 'shell', 'getprop', property]);
  if (result.stdout.trim() === '1') return true;
  if (index % BOOT_DIAGNOSTIC_INTERVAL === 0) {
    console.log(`[poll ${String(index)}] ${host}: ${property} not yet '1'`);
  }
  return false;
}

async function checkBootCompleted(
  host: string,
  index: number
): Promise<{ connected: boolean; booted: boolean }> {
  try {
    // `sys.boot_completed=1` matches budtmo/docker-android's own
    // `wait_until_ready` (see budtmo's cli/src/device/emulator.py). Earlier
    // versions of this code also polled `service.bootanim.exit==1` but that
    // property is a transient signal: SurfaceFlinger writes it as `"1"` to
    // tell bootanimation to exit, then bootanimation immediately clears it
    // back to `"0"` on the way out (AOSP `BootAnimation.cpp` EXIT_PROP_NAME
    // + `SurfaceFlinger.cpp` bootFinished()). At a 2 s poll interval the
    // brief `"1"` window is missed deterministically, which is what wedged
    // both shards in CI run 26672463871. The residual WebView warm-up
    // window is absorbed at the flow level by the 45 s `extendedWaitUntil`
    // timeouts in `mobile-tests/flows/*.yaml`, mirroring the 15 s sleep +
    // `dumpsys window` follow-up that budtmo adds after `sys.boot_completed`.
    if (!(await probeBootProperty(host, 'sys.boot_completed', index))) {
      return { connected: true, booted: false };
    }
    return { connected: true, booted: true };
  } catch (error: unknown) {
    const detail = extractErrorDetail(error);
    if (detail.includes('offline') || detail.includes('not found')) {
      if (index % BOOT_DIAGNOSTIC_INTERVAL === 0) {
        console.log(`[poll ${String(index)}] readiness ${host}: ${detail}`);
      }
      await disconnectStaleAdb(host);
      return { connected: false, booted: false };
    }
    return { connected: true, booted: false };
  }
}

async function pollEmulatorBoot(
  host: string,
  connected: boolean,
  index: number
): Promise<{ connected: boolean; booted: boolean }> {
  if (!connected) {
    const ok = await tryAdbConnect(host, index);
    if (!ok) return { connected: false, booted: false };
    console.log(`Connected to ${host}`);
  }
  return checkBootCompleted(host, index);
}

async function setupAdbReverse(host: string): Promise<void> {
  const apiPort = requireApiPort();
  console.log(`Setting up adb reverse for API port ${apiPort} on ${host}...`);
  await execa('adb', ['-s', host, 'reverse', `tcp:${apiPort}`, `tcp:${apiPort}`]);
}

export async function startEmulator(
  shard: number,
  imageTag: string,
  kvmGid: string
): Promise<void> {
  const host = `localhost:${String(adbPortForShard(shard))}`;
  console.log(`Starting Android emulator (shard ${String(shard)}) on ${host}...`);
  await runEmulatorContainer({
    name: containerNameForShard(shard),
    hostAdbPort: adbPortForShard(shard),
    imageTag,
    kvmGid,
    // Enables noVNC at port 6080 inside the container for live emulator
    // viewing — useful for debugging a hung test interactively.
    includeVnc: true,
  });

  let connected = false;
  console.log(`Waiting for emulator on ${host} to boot...`);
  for (let index = 0; index < BOOT_TIMEOUT_POLLS; index++) {
    try {
      const poll = await pollEmulatorBoot(host, connected, index);
      connected = poll.connected;
      if (poll.booted) {
        console.log(`Emulator booted on ${host}`);
        await setupAdbReverse(host);
        return;
      }
    } catch (error: unknown) {
      if (index % BOOT_DIAGNOSTIC_INTERVAL === 0) {
        const detail = extractErrorDetail(error);
        console.log(`[poll ${String(index)}] ${host} error: ${detail}`);
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, BOOT_POLL_INTERVAL_MS);
    });
  }
  throw new Error(`Emulator on ${host} failed to boot within timeout`);
}

export async function startEmulators(n: number, imageTag: string): Promise<void> {
  const kvmGid = await detectKvmGid();
  await Promise.all(
    Array.from({ length: n }, (_, shard) => startEmulator(shard, imageTag, kvmGid))
  );
}

export async function stopEmulator(shard: number): Promise<void> {
  const name = containerNameForShard(shard);
  console.log(`Stopping emulator shard ${String(shard)} (${name})...`);
  try {
    await execa('docker', ['rm', '-f', name], { stdio: 'inherit' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to stop emulator ${name}: ${message}`);
  }
}

export async function stopEmulators(n: number): Promise<void> {
  await Promise.all(Array.from({ length: n }, (_, shard) => stopEmulator(shard)));
}

/**
 * Spawn a wrangler-dev subprocess to serve the API while mobile tests run.
 * The dev stack itself (containers + migrations + seed) is the responsibility
 * of `pnpm ensure-stack`, which runs before this script. We just need a live
 * API process to point the emulator at. The subprocess is killed on exit
 * (or rolled up by the idle-killer daemon if this process crashes).
 */
async function pollApiReady(apiPort: string): Promise<boolean> {
  try {
    await execa('curl', ['-sf', `http://localhost:${apiPort}/health`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export interface DevApiHandle {
  apiProcess: ReturnType<typeof execa> | null;
}

export async function startDevApi(): Promise<DevApiHandle> {
  const apiPort = requireApiPort();

  if (await pollApiReady(apiPort)) {
    console.log('API server already running — reusing existing process');
    return { apiProcess: null };
  }

  console.log('Starting API server...');
  const apiProcess = execa('pnpm', ['--filter', '@hushbox/api', 'dev'], {
    stdio: 'ignore',
    env: process.env,
  });
  // eslint-disable-next-line promise/prefer-await-to-then, @typescript-eslint/no-empty-function -- fire-and-forget subprocess; explicit kill happens via stopDevApi
  apiProcess.catch(() => {});
  apiProcess.unref();

  for (let index = 0; index < API_TIMEOUT_POLLS; index++) {
    if (await pollApiReady(apiPort)) {
      console.log('API server ready');
      return { apiProcess };
    }
    await new Promise((resolve) => {
      setTimeout(resolve, API_POLL_INTERVAL_MS);
    });
  }
  await stopDevApi({ apiProcess });
  throw new Error('API server failed to start within timeout');
}

// eslint-disable-next-line @typescript-eslint/require-await -- kept async to match call sites; the kill is synchronous but the API may grow async cleanup
export async function stopDevApi(handle: DevApiHandle): Promise<void> {
  if (!handle.apiProcess) return;
  console.log('Stopping API server we started...');
  try {
    handle.apiProcess.kill();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to stop API server: ${message}`);
  }
}

const GOOGLE_SERVICES_PATH = 'apps/web/android/app/google-services.json';
export const APK_APP_VERSION = 'local-mobile-test';
export const API_SLICE_PATH = path.join(RESULTS_DIR, 'api-during-mobile-test.log');
const FAILURE_TAIL_LINES = 200;

/**
 * Brackets a block of maestro work with START/END markers in the wrangler dev
 * log. scripts/lib/extract-mobile-api-log.ts uses those markers to slice out
 * the API request activity that belongs to *this* run. The structured
 * request-log carries no app-version field, so the START/END window is the
 * only per-run isolation — sibling-session traffic in the same window can no
 * longer be filtered out by APK build.
 */
export async function withMobileTestRun<T>(runId: string, body: () => Promise<T>): Promise<T> {
  const apiPort = requireApiPort();
  const logPath = wranglerLogPath(apiPort);
  appendFileSync(logPath, `${MARKER_PREFIX} ${runId} START ${new Date().toISOString()} =====\n`);
  try {
    return await body();
  } finally {
    appendFileSync(logPath, `${MARKER_PREFIX} ${runId} END ${new Date().toISOString()} =====\n`);
  }
}

/**
 * Reads the raw wrangler log, slices out the section belonging to `runId` (the
 * request-log lines and run markers inside the START/END window), and writes
 * the slice to maestro-results/api-during-mobile-test.log — the post-hoc debug
 * artifact. Wrangler's own banner/error lines stay in the unfiltered raw log.
 *
 * Assumes RESULTS_DIR exists; main() creates it before any work begins.
 */
export function writeApiSlice(runId: string): void {
  const apiPort = requireApiPort();
  const rawLog = readFileSync(wranglerLogPath(apiPort), 'utf8');
  const slice = extractRelevantSlice({
    rawLog,
    runId,
  });
  writeFileSync(API_SLICE_PATH, slice);
}

/**
 * Echoes the tail of the slice file to stdout on failure so CI step output
 * shows the API-side context without requiring the artifact download. Mirrors
 * the post-mortem logcat dump pattern used by runMaestroOta() for OTA flows.
 */
export function dumpApiLogTail(tailLines: number = FAILURE_TAIL_LINES): void {
  const content = readFileSync(API_SLICE_PATH, 'utf8');
  if (content.length === 0) {
    process.stdout.write('\n=== API log slice is empty ===\n');
    return;
  }
  const lines = content.split('\n');
  const tailStart = Math.max(0, lines.length - tailLines);
  const tail = lines.slice(tailStart).join('\n');
  const shown = lines.length - tailStart;
  process.stdout.write(`\n=== last ${String(shown)} lines of API log ===\n`);
  process.stdout.write(tail);
  process.stdout.write('\n=== end of API log tail ===\n');
}

export async function buildApk(): Promise<void> {
  const apiUrl = process.env['API_URL'];
  if (!apiUrl) throw new Error('API_URL not set. Ensure the script is run via with-env.');
  const frontendUrl = process.env['FRONTEND_URL'];
  if (!frontendUrl) throw new Error('FRONTEND_URL not set. Ensure the script is run via with-env.');

  if (!existsSync(GOOGLE_SERVICES_PATH)) {
    const googleServicesB64 = process.env['GOOGLE_SERVICES_JSON_BASE64'];
    if (!googleServicesB64) {
      throw new Error(
        'GOOGLE_SERVICES_JSON_BASE64 not set and google-services.json not found. Run pnpm generate:env.'
      );
    }
    console.log('Writing google-services.json from GOOGLE_SERVICES_JSON_BASE64...');
    writeFileSync(GOOGLE_SERVICES_PATH, Buffer.from(googleServicesB64, 'base64').toString('utf8'));
  }

  console.log('Building web for mobile...');
  await execa('pnpm', ['--filter', 'web', 'build'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      TURBO_FORCE: 'true',
      VITE_API_URL: apiUrl,
      VITE_PLATFORM: 'android-direct',
      VITE_APP_VERSION: APK_APP_VERSION,
      VITE_OPAQUE_SERVER_ID: new URL(frontendUrl).host,
    },
  });

  console.log('Syncing Capacitor...');
  await execa('npx', ['cap', 'sync', 'android'], {
    stdio: 'inherit',
    cwd: 'apps/web',
    env: process.env,
  });

  console.log('Building debug APK...');
  const gradlew = ['.', 'gradlew'].join('/');
  // `clean` is required: every run produces freshly content-hashed web assets, and AGP's
  // incremental mergeDebugAssets retains the prior build's now-deleted files. compressDebugAssets
  // then fails trying to overwrite their existing per-asset .jar ("already contains entry").
  await execa(gradlew, ['clean', 'assembleDebug'], {
    stdio: 'inherit',
    cwd: 'apps/web/android',
    env: {
      ...process.env,
      VERSION_CODE: '1',
      VERSION_NAME: 'local-mobile-test',
      ANDROID_KEYSTORE_PATH: 'debug.keystore',
      ANDROID_KEYSTORE_PASSWORD: 'debug',
      ANDROID_KEY_ALIAS: 'debug',
      ANDROID_KEY_PASSWORD: 'debug',
    },
  });
}

export async function installApk(shard: number): Promise<void> {
  const host = `localhost:${String(adbPortForShard(shard))}`;
  console.log(`Installing APK on ${host}...`);
  await execa('adb', ['-s', host, 'install', '-r', APK_PATH], { stdio: 'inherit' });
}

export async function installApks(n: number): Promise<void> {
  await Promise.all(Array.from({ length: n }, (_, shard) => installApk(shard)));
}

/**
 * Reset the dev API's in-memory version override to match the APK we built.
 * See setupOtaUpdate() — without this reset, a stale override from a prior
 * run causes every authenticated request from the freshly built APK to
 * fail with 426 Upgrade Required.
 */
export async function resetVersionOverride(): Promise<void> {
  const apiPort = requireApiPort();
  console.log(`Resetting dev version override to ${APK_APP_VERSION}...`);
  const res = await fetch(`http://localhost:${apiPort}/dev/set-version`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: APK_APP_VERSION }),
  });
  if (!res.ok) {
    throw new Error(`Failed to reset version override: HTTP ${String(res.status)}`);
  }
}

export async function configureAppLinks(shard: number): Promise<void> {
  const host = `localhost:${String(adbPortForShard(shard))}`;
  console.log(`Configuring app link verification on ${host}...`);
  await execa(
    'adb',
    [
      '-s',
      host,
      'shell',
      'pm',
      'set-app-links-allowed',
      '--package',
      'ai.hushbox.app',
      '--user',
      '0',
      'true',
    ],
    { stdio: 'inherit' }
  );
  console.log(`Disabling Chrome on ${host} so deep links route to app...`);
  await execa(
    'adb',
    ['-s', host, 'shell', 'pm', 'disable-user', '--user', '0', 'com.android.chrome'],
    { stdio: 'inherit' }
  );
}

export async function configureAllAppLinks(n: number): Promise<void> {
  await Promise.all(Array.from({ length: n }, (_, shard) => configureAppLinks(shard)));
}

/**
 * Per-character cost of an `inputText` step relative to one Maestro step.
 * Typing into the Capacitor WebView runs ~10s/char on docker-android (Maestro
 * #2718 — see 10-core-user-flow.yaml), so a typed character costs more wall-
 * clock than a typical step. This is the single global dial for how heavily
 * typing counts toward shard balance; it is not per-flow bookkeeping.
 */
export const INPUT_CHAR_WEIGHT = 2;

function stripQuotes(value: string): string {
  return value.replaceAll(/^['"]|['"]$/g, '');
}

/**
 * Resolve the typed length of an `inputText` value. `${VAR}` references resolve
 * against the flow's own declarations (e.g. `${TEST_USERNAME}` → "tmu") so the
 * count reflects what's actually typed, not the placeholder. An unresolved var
 * falls back to the token's own length.
 */
function resolveInputLength(raw: string, content: string): number {
  const variableName = /^\$\{(\w+)\}$/.exec(raw)?.[1];
  if (variableName !== undefined) {
    const decl = new RegExp(String.raw`^\s*${variableName}:\s*(.+)$`, 'm').exec(content);
    if (decl?.[1] !== undefined) return stripQuotes(decl[1].trim()).length;
    return raw.length;
  }
  return stripQuotes(raw).length;
}

/**
 * Approximate execution cost of a flow, derived entirely from its YAML: the
 * number of steps plus a per-character penalty for `inputText` typing. Adding
 * or editing a flow reweights it automatically — no maintained timing table.
 */
export function flowWeight(content: string): number {
  const separatorIndex = content.search(/^---\s*$/m);
  const body = separatorIndex === -1 ? '' : content.slice(separatorIndex);
  const stepCount = (body.match(/^-\s/gm) ?? []).length;

  let inputChars = 0;
  const inputRegex = /^-\s+inputText:\s*(.+)$/gm;
  let match = inputRegex.exec(body);
  while (match !== null) {
    if (match[1] !== undefined) inputChars += resolveInputLength(match[1].trim(), content);
    match = inputRegex.exec(body);
  }
  return stepCount + inputChars * INPUT_CHAR_WEIGHT;
}

/** Read each flow file and compute its weight. Pure I/O over flowWeight. */
function weighFlows(flows: string[]): Map<string, number> {
  const weights = new Map<string, number>();
  for (const flow of flows) {
    weights.set(flow, flowWeight(readFileSync(flow, 'utf8')));
  }
  return weights;
}

/** Index of the least-loaded shard that still has count capacity. */
function leastLoadedWithCapacity(buckets: string[][], loads: number[], caps: number[]): number {
  let target = -1;
  for (const [index, bucket] of buckets.entries()) {
    /* v8 ignore next 2 -- caps and loads are sized to the bucket count, so every index is in range */
    if (bucket.length >= (caps[index] ?? 0)) continue;
    if (target === -1 || (loads[index] ?? 0) < (loads[target] ?? 0)) target = index;
  }
  return target;
}

/**
 * Split flows across n shards so each shard runs a near-equal number of flows
 * (counts differ by at most 1) while keeping total weight per shard as even as
 * possible. Flows are placed heaviest-first onto the least-loaded shard that
 * still has count capacity (count-constrained Longest-Processing-Time). This
 * keeps wall-clock balanced when a few flows dominate; a plain round-robin by
 * filename could pile the two slowest flows onto one shard.
 */
export function partitionByWeight(
  flows: string[],
  n: number,
  weightOf: (flow: string) => number
): string[][] {
  const buckets: string[][] = Array.from({ length: n }, () => []);
  const loads = Array.from({ length: n }, () => 0);
  const caps = Array.from(
    { length: n },
    (_, index) => Math.floor(flows.length / n) + (index < flows.length % n ? 1 : 0)
  );
  const ordered = flows.toSorted((a, b) => weightOf(b) - weightOf(a) || a.localeCompare(b));
  for (const flow of ordered) {
    const target = leastLoadedWithCapacity(buckets, loads, caps);
    buckets[target]?.push(flow);
    /* v8 ignore next -- target is a valid bucket index, so loads[target] is always defined */
    loads[target] = (loads[target] ?? 0) + weightOf(flow);
  }
  return buckets;
}

export function smokeFlows(): string[] {
  return [
    `${FLOW_DIR}/01-app-launch.yaml`,
    `${FLOW_DIR}/02-splash-screen.yaml`,
    `${FLOW_DIR}/03-webview-renders.yaml`,
  ];
}

export function fullFlowsExcludingOta(): string[] {
  return readdirSync(FLOW_DIR)
    .filter((f) => f.endsWith('.yaml') && f !== path.basename(OTA_FLOW))
    .toSorted((a, b) => a.localeCompare(b))
    .map((f) => `${FLOW_DIR}/${f}`);
}

/* eslint-disable sonarjs/no-selector-parameter -- smoke is the user-facing CLI flag plumbed from parseArgs through main; splitting the caller would just move the same boolean selection one layer up */
export function listFlowsForRun(smoke: boolean): string[] {
  return smoke ? smokeFlows() : fullFlowsExcludingOta();
}
/* eslint-enable sonarjs/no-selector-parameter */

async function prepareAdbServer(n: number): Promise<void> {
  const apiPort = requireApiPort();
  // The adb server auto-discovers emulator ports (5554-5682) and creates
  // ghost "emulator-XXXX offline" entries that crash Maestro's dadb.
  // ADB_LOCAL_TRANSPORT_MAX_PORT=0 prevents the scan entirely.
  console.log('Restarting adb server without emulator port scanning...');
  await execa('adb', ['kill-server']).catch(() => {
    // Ignored: kill-server fails if adb is not running.
  });
  await execa('adb', ['start-server'], {
    env: { ...process.env, ADB_LOCAL_TRANSPORT_MAX_PORT: '0' },
  });
  for (let shard = 0; shard < n; shard++) {
    const host = `localhost:${String(adbPortForShard(shard))}`;
    await execa('adb', ['connect', host]);
    await execa('adb', ['-s', host, 'wait-for-device']);
    console.log(`Re-establishing adb reverse for API port ${apiPort} on ${host}...`);
    await execa('adb', ['-s', host, 'reverse', `tcp:${apiPort}`, `tcp:${apiPort}`]);
  }
}

export interface ShardResult {
  shard: number;
  exitCode: number;
  stdout: string;
}

async function runMaestroOnShard(shard: number, flows: string[]): Promise<ShardResult> {
  if (flows.length === 0) {
    return { shard, exitCode: 0, stdout: '' };
  }
  const host = `localhost:${String(adbPortForShard(shard))}`;
  const debugDir = debugOutputForShard(shard);
  mkdirSync(debugDir, { recursive: true });
  const args = [
    'test',
    '--device',
    host,
    '--debug-output',
    debugDir,
    '--flatten-debug-output',
    ...flows,
  ];
  console.log(`[shard ${String(shard)}] maestro test on ${host} (${String(flows.length)} flows)`);
  const result = await execa('maestro', args, {
    stdout: ['pipe', 'inherit'],
    stderr: 'inherit',
    reject: false,
  });
  return {
    shard,
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : 1,
    stdout: result.stdout,
  };
}

export async function runMaestroShards(smoke: boolean, n: number): Promise<void> {
  await prepareAdbServer(n);

  const flows = listFlowsForRun(smoke);
  const weights = weighFlows(flows);
  /* v8 ignore next -- weighFlows returns a weight for every flow, so the lookup never misses */
  const partitions = partitionByWeight(flows, n, (flow) => weights.get(flow) ?? 0);

  console.log(`Running Maestro tests${smoke ? ' (smoke)' : ''} across ${String(n)} shard(s)...`);
  const results = await Promise.all(
    partitions.map((part, shard) => runMaestroOnShard(shard, part))
  );

  const allPassed = results.every((r) => r.exitCode === 0);
  if (allPassed) return;

  // Collect failures across all shards. Each shard's stdout is parsed
  // independently; failed flow names map back to YAML paths the same way as
  // the single-shard implementation.
  const failedPaths = results.flatMap((r) => getFailedFlowPaths(r.stdout));
  if (failedPaths.length === 0) {
    // Some shard failed without identifying flows (e.g., maestro itself
    // crashed). Fail without retry rather than re-running everything.
    throw new Error('Maestro tests failed without identifiable flow failures');
  }

  console.log(`\nRetrying ${String(failedPaths.length)} failed flow(s) on shard 0...`);
  const retryHost = `localhost:${String(adbPortForShard(0))}`;
  // Per-shard maestro processes can disturb the host adb server's device
  // table on exit (maestro#2167 — multi-device + non-default-port mode),
  // surfacing as "Device localhost:PORT not connected" on retry. Re-attach
  // before invoking the retry; `adb connect` is idempotent on an already-
  // connected device, so this is safe in the happy path too.
  await execa('adb', ['connect', retryHost]);
  await execa('adb', ['-s', retryHost, 'wait-for-device']);
  await execa(
    'maestro',
    [
      'test',
      '--device',
      retryHost,
      '--debug-output',
      debugOutputForShard(0),
      '--flatten-debug-output',
      ...failedPaths,
    ],
    { stdio: 'inherit' }
  );
}

/** Parse `[Failed] Flow Name (Xs)` lines from maestro output. */
export function parseFailedFlowNames(output: string): string[] {
  const failed: string[] = [];
  const regex = /\[Failed\]\s+(.+?)\s+\([\dm\s]+s\)/g;
  let match = regex.exec(output);
  while (match !== null) {
    if (match[1] !== undefined) failed.push(match[1].trim());
    match = regex.exec(output);
  }
  return failed;
}

/** Map failed flow display names back to their YAML file paths. */
function getFailedFlowPaths(output: string): string[] {
  const failedNames = parseFailedFlowNames(output);
  if (failedNames.length === 0) return [];

  const nameToPath = new Map<string, string>();
  for (const file of readdirSync(FLOW_DIR).filter((f) => f.endsWith('.yaml'))) {
    const content = readFileSync(path.join(FLOW_DIR, file), 'utf8');
    const nameMatch = /^name:\s*(.+)$/m.exec(content);
    if (nameMatch?.[1]) {
      nameToPath.set(nameMatch[1].trim(), path.join(FLOW_DIR, file));
    }
  }

  return failedNames
    .map((name) => nameToPath.get(name))
    .filter((p): p is string => p !== undefined);
}

const OTA_VERSION = 'ota-v2';

/**
 * Builds an OTA bundle, uploads to local R2, and sets the version override.
 * Uses the same codepaths as production (wrangler R2, /dev/set-version).
 */
export async function setupOtaUpdate(): Promise<void> {
  const apiUrl = requireEnv('API_URL', WITH_ENV_HINT);
  const apiPort = requireApiPort();

  console.log('Building OTA bundle...');
  await execa('pnpm', ['exec', 'vite', 'build', '--outDir', 'dist-ota'], {
    cwd: 'apps/web',
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_APP_VERSION: OTA_VERSION,
      VITE_PLATFORM: 'android-direct',
      VITE_API_URL: apiUrl,
    },
  });

  console.log('Uploading OTA bundle to local R2...');
  // Zip the bundle in-process with adm-zip (pure JS) instead of shelling out to
  // a `zip` binary, which isn't guaranteed installed on a dev machine. Mirrors
  // `zip -r ota-bundle.zip .`: dist-ota's contents sit at the archive root.
  const otaDir = 'apps/web/dist-ota';
  const zipPath = 'ota-bundle.zip';
  const otaZip = new AdmZip();
  otaZip.addLocalFolder(otaDir, '', (filename) => !filename.endsWith(zipPath));
  otaZip.writeZip(path.join(otaDir, zipPath));
  await execa(
    'pnpm',
    [
      'exec',
      'wrangler',
      'r2',
      'object',
      'put',
      `hushbox-app-builds/builds/android-direct/${OTA_VERSION}.zip`,
      '--file',
      `../web/dist-ota/${zipPath}`,
    ],
    { cwd: 'apps/api', stdio: 'inherit' }
  );

  console.log('Setting version override...');
  const res = await fetch(`http://localhost:${apiPort}/dev/set-version`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: OTA_VERSION }),
  });
  if (!res.ok) {
    throw new Error('Failed to set version override');
  }
  console.log(`Version override set to ${OTA_VERSION}`);
}

export async function runMaestroOta(): Promise<void> {
  // Run OTA on shard 0; it mutates global server state, so single-device is
  // correct (no parallelism benefit, and concurrent runs would conflict).
  const host = `localhost:${String(adbPortForShard(0))}`;
  const debugDir = path.join(RESULTS_DIR, 'ota');
  mkdirSync(debugDir, { recursive: true });
  console.log(`Running OTA update Maestro flow on ${host}...`);
  try {
    await execa(
      'maestro',
      ['test', '--device', host, '--debug-output', debugDir, '--flatten-debug-output', OTA_FLOW],
      { stdio: 'inherit' }
    );
  } catch (error: unknown) {
    // Maestro's --debug-output captures the failure screenshot, UI hierarchy, and
    // logs — a far cleaner source of truth than a raw Capacitor/CapgoUpdater logcat dump.
    console.log(`\nOTA flow failed. Maestro debug artifacts (screenshot + hierarchy): ${debugDir}`);
    throw error;
  }
}

export async function main(): Promise<void> {
  assertLinux();
  const { smoke } = parseArgs(process.argv.slice(2));
  const n = SHARDS;

  await checkPrerequisites();
  await Promise.all([installMaestro(), installAndroidSdk()]);

  // Resolve the image tag up front so we have a single source of truth across
  // all shards. bakeImage resolves it via local-cache / registry-pull /
  // cold-build; in CI on main this image was already pushed by the
  // push-mobile-emulator-image job, so this is a pull. On PRs and local dev
  // it may be a cold build (one-time cost per Dockerfile change).
  const imageTag = await bakeImage({ push: false });

  // Containers, migrations, and seed are the caller's responsibility — locally
  // via `pnpm ensure-stack`, in CI via the workflow's db:up/db:migrate/db:seed
  // steps. Start a wrangler-dev API so the emulator has something to talk to.
  // The idle-killer daemon reaps containers later if this process crashes
  // without explicit teardown.
  const devApi = await startDevApi();
  mkdirSync(RESULTS_DIR, { recursive: true });
  const runId = randomUUID().slice(0, 8);
  try {
    await Promise.all([startEmulators(n, imageTag), buildApk()]);
    await installApks(n);
    await configureAllAppLinks(n);
    await resetVersionOverride();

    let maestroFailed = false;
    try {
      await withMobileTestRun(runId, async () => {
        await runMaestroShards(smoke, n);
        if (!smoke) {
          await setupOtaUpdate();
          await runMaestroOta();
        }
      });
    } catch (error) {
      maestroFailed = true;
      throw error;
    } finally {
      try {
        writeApiSlice(runId);
        if (maestroFailed) dumpApiLogTail();
      } catch (writeError: unknown) {
        const message = writeError instanceof Error ? writeError.message : String(writeError);
        console.error(`Failed to write API slice: ${message}`);
      }
    }

    console.log('Mobile tests complete!');
  } finally {
    await stopEmulators(n);
    await stopDevApi(devApi);
  }
}

/* v8 ignore start */
const isMain = isMainModule(import.meta.url);
if (isMain) {
  void (async () => {
    try {
      await main();
    } catch (error: unknown) {
      console.error('Mobile test failed:', error);
      process.exit(1);
    }
  })();
}
/* v8 ignore stop */
