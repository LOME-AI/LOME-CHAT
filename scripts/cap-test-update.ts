import path from 'node:path';
import { createWriteStream } from 'node:fs';
import archiver from 'archiver';
import { $ } from 'execa';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';
import type { MobilePlatform } from '@hushbox/shared';

const API_BASE_URL = 'http://localhost:8788';

let versionCounter = 0;

/** Generates a unique version string for testing OTA updates. */
export function generateVersionString(): string {
  versionCounter += 1;
  return `dev-update-${String(Date.now())}-${String(versionCounter)}`;
}

/** Returns the path to the web dist directory. */
export function getDistributionZipPath(rootDir: string): string {
  return path.join(rootDir, 'apps', 'web', 'dist');
}

/** Returns the local API base URL. */
export function getApiBaseUrl(): string {
  return API_BASE_URL;
}

/** Returns the URL for GET /api/updates/current. */
export function getUpdatesCurrentUrl(): string {
  return `${API_BASE_URL}/api/updates/current`;
}

/** Returns the URL for POST /api/dev/set-version. */
export function getSetVersionUrl(): string {
  return `${API_BASE_URL}/api/dev/set-version`;
}

/** Returns the R2 object key for a given platform and version. */
export function getR2ObjectKey(platform: MobilePlatform, version: string): string {
  return `hushbox-app-builds/builds/${platform}/${version}.zip`;
}

/**
 * Pack the contents of a directory into a zip file. Mirrors `cd <source> && zip -r <dest> .`:
 * entries are stored relative to the source directory root, not the source directory itself.
 */
export function zipDirectory(source: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(destination);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => {
      resolve();
    });
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(source, false);
    void archive.finalize();
  });
}

/**
 * Automated local live update testing script.
 *
 * Flow:
 * 1. Query GET /api/updates/current for the current version
 * 2. Generate a new version string
 * 3. Run vite build with the new version and platform env vars
 * 4. Zip apps/web/dist/
 * 5. Upload zip to local R2 via wrangler (platform-specific key)
 * 6. Call POST /api/dev/set-version
 * 7. Log instructions
 *
 * Requires: pnpm dev running (Vite + Wrangler).
 */
export async function runCapTestUpdate(
  rootDir: string,
  platform: MobilePlatform = 'android-direct'
): Promise<void> {
  console.log('Querying current server version...');
  const res = await fetch(getUpdatesCurrentUrl());
  if (!res.ok) {
    throw new Error(`Failed to query current version: ${String(res.status)}`);
  }
  const { version: currentVersion } = (await res.json()) as { version: string };
  console.log(`  Current version: ${currentVersion}`);

  const newVersion = generateVersionString();
  console.log(`  New version: ${newVersion}`);

  console.log('Building web with new version...');
  const webDir = path.join(rootDir, 'apps', 'web');
  await $({
    cwd: webDir,
    stdio: 'inherit',
    env: { ...process.env, VITE_APP_VERSION: newVersion, VITE_PLATFORM: platform },
  })`pnpm exec vite build`;

  const distributionDir = getDistributionZipPath(rootDir);
  const zipPath = path.join(rootDir, 'web-dist.zip');
  console.log('Zipping dist...');
  await zipDirectory(distributionDir, zipPath);

  const r2Key = getR2ObjectKey(platform, newVersion);
  console.log(`Uploading to R2: ${r2Key}`);
  const apiDir = path.join(rootDir, 'apps', 'api');
  await $({
    cwd: apiDir,
    stdio: 'inherit',
  })`pnpm exec wrangler r2 object put ${r2Key} --file ${zipPath}`;

  console.log('Setting version override...');
  const setRes = await fetch(getSetVersionUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: newVersion }),
  });
  if (!setRes.ok) {
    throw new Error(`Failed to set version: ${String(setRes.status)}`);
  }

  console.log('');
  console.log('Version updated successfully!');
  console.log(`  Old: ${currentVersion}`);
  console.log(`  New: ${newVersion}`);
  console.log('');
  console.log('Next API call from the emulator will trigger a Capgo update.');
}

/** Parses --platform from CLI args. Returns undefined if not provided. */
export function parsePlatformArgument(args: string[]): MobilePlatform | undefined {
  const index = args.indexOf('--platform');
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1] as MobilePlatform;
}

/* v8 ignore start -- CLI entry point exercised via cap:test-update script */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const platform = parsePlatformArgument(process.argv.slice(2));
    await runCapTestUpdate(process.cwd(), platform);
  });
}
/* v8 ignore stop */
