import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveOrtAssets, type OrtAsset } from './lib/ort-assets-plugin.js';
import {
  PAGES_MAX_FILE_BYTES,
  appBundleOptions,
  PAGES_MAX_FILE_COUNT,
  checkPagesLimits,
  collectWebBundleViolations,
  declaredOrtCommonVersion,
  verifyWebBundle,
  type BundleFile,
} from './verify-web-bundle.js';

let distributionDir: string;
let runtimeDir: string;

/** Stand-in for the installed onnxruntime-web runtime, so the fixtures stay
 * kilobytes instead of copying the real 21 MB wasm. */
async function fakeRuntime(): Promise<OrtAsset[]> {
  const names = ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs'];
  const assets: OrtAsset[] = [];
  for (const fileName of names) {
    const absPath = path.join(runtimeDir, fileName);
    await fs.writeFile(absPath, `runtime bytes for ${fileName}`);
    assets.push({ fileName, absPath });
  }
  return assets;
}

async function selfHost(assets: readonly OrtAsset[]): Promise<void> {
  await fs.mkdir(path.join(distributionDir, 'ort'), { recursive: true });
  for (const asset of assets) {
    await fs.copyFile(asset.absPath, path.join(distributionDir, 'ort', asset.fileName));
  }
}

async function writeDistributionFile(relativePath: string, content: string): Promise<void> {
  const absolute = path.join(distributionDir, relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
}

/**
 * A dist with no ORT version site at all is itself a violation, so every
 * fixture bundle starts with one compliant chunk. The version is derived, never
 * written down twice.
 */
const ORT_VERSION_CHUNK = 'assets/ort-env-baseline.js';

/** Same reason: a dist emitting no TTS worker chunk is itself a violation. */
const WORKER_CHUNK = 'assets/tts.worker-baseline.js';

beforeEach(async () => {
  distributionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-bundle-dist-'));
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-bundle-runtime-'));
  await writeDistributionFile(
    ORT_VERSION_CHUNK,
    `const env={versions:{common:\`${await declaredOrtCommonVersion()}\`}};`
  );
  await writeDistributionFile(WORKER_CHUNK, 'self.onmessage=()=>{};');
});

afterEach(async () => {
  await fs.rm(distributionDir, { recursive: true, force: true });
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

describe('collectWebBundleViolations', () => {
  it('reports nothing for a bundle that self-hosts the runtime and ships no copies', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'const p="/ort/";');

    expect(
      await collectWebBundleViolations({ distributionDir, shipsTts: true, ortAssets: assets })
    ).toEqual([]);
  });

  it('reports a self-hosted runtime file the build never emitted', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await fs.rm(path.join(distributionDir, 'ort/ort-wasm-simd-threaded.jsep.wasm'));

    const violations = await collectWebBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toEqual([
      expect.stringContaining('ort/ort-wasm-simd-threaded.jsep.wasm') as unknown as string,
    ]);
    expect(violations[0]).toMatch(/missing/i);
  });

  it('reports a self-hosted runtime file whose bytes differ from the installed runtime', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile(
      'ort/ort-wasm-simd-threaded.jsep.mjs',
      'stale bytes from another version'
    );

    const violations = await collectWebBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/ort-wasm-simd-threaded\.jsep\.mjs/);
    expect(violations[0]).toMatch(/sha256|match/i);
  });

  it('reports every ORT runtime copy emitted outside the self-hosted directory', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/ort-wasm-simd-threaded.jsep-B0T3yYHD.wasm', 'copy');
    await writeDistributionFile('_astro/ort-wasm-simd-threaded.jsep-B0T3yYHD.mjs', 'copy');

    const violations = await collectWebBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(2);
    expect(violations.join('\n')).toContain('assets/ort-wasm-simd-threaded.jsep-B0T3yYHD.wasm');
    expect(violations.join('\n')).toContain('_astro/ort-wasm-simd-threaded.jsep-B0T3yYHD.mjs');
  });

  it('reports a built script that still references the bundler-emitted /assets/ort- asset', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'new URL("/assets/ort-wasm.wasm",x)');

    const violations = await collectWebBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/tts.worker-abc.js');
  });

  it('reports a built script that still references the bundler-emitted /_astro/ort- asset', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('_astro/tts.worker-abc.js', 'new URL("/_astro/ort-wasm.wasm",x)');

    const violations = await collectWebBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('_astro/tts.worker-abc.js');
  });

  it('ignores source maps, which legitimately name the bundler-emitted asset', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile(
      'assets/tts.worker-abc.js.map',
      '{"sources":["/assets/ort-wasm.wasm"]}'
    );

    expect(
      await collectWebBundleViolations({ distributionDir, shipsTts: true, ortAssets: assets })
    ).toEqual([]);
  });

  it('reports a file over the Cloudflare Pages per-file size cap', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    const oversized = path.join(distributionDir, 'assets/oversized.bin');
    await fs.mkdir(path.dirname(oversized), { recursive: true });
    // Sparse: the guard reads sizes from stat, never the bytes.
    const handle = await fs.open(oversized, 'w');
    await handle.truncate(PAGES_MAX_FILE_BYTES + 1);
    await handle.close();

    const violations = await collectWebBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/oversized.bin');
    expect(violations[0]).toContain(String(PAGES_MAX_FILE_BYTES));
  });

  it('accepts a chunk whose ORT version reaches `versions.common` through a local', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    const pinned = await declaredOrtCommonVersion();
    await writeDistributionFile(
      'assets/tts.worker-abc.js',
      `const version$1 = "${pinned}";\nconst env = {\n\tversions: { common: version$1 }\n};`
    );

    expect(
      await collectWebBundleViolations({ distributionDir, shipsTts: true, ortAssets: assets })
    ).toEqual([]);
  });

  it('reports a chunk carrying an onnxruntime-common version other than the pin', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile(
      'assets/tts.worker-abc.js',
      'const env={versions:{common:"0.0.0-hoisted"}};'
    );

    const violations = await collectWebBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/tts.worker-abc.js');
    expect(violations[0]).toContain('0.0.0-hoisted');
    expect(violations[0]).toContain(await declaredOrtCommonVersion());
  });

  it('reports a chunk carrying two different onnxruntime-common versions', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile(
      'assets/tts.worker-abc.js',
      `const inlined=\`${await declaredOrtCommonVersion()}\`;` +
        'const runtime={versions:{common:inlined}};' +
        'const external={versions:{common:`1.26.0`}};'
    );

    const violations = await collectWebBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('1.26.0');
  });

  it('reports a bundle in which no ORT version site was found at all', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await fs.rm(path.join(distributionDir, ORT_VERSION_CHUNK));

    const violations = await collectWebBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/no onnxruntime version/i);
  });

  it('reports a version bound to a local it cannot resolve', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'const env={versions:{common:unset}};');

    const violations = await collectWebBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('unset');
    expect(violations[0]).toContain('assets/tts.worker-abc.js');
  });

  it('accepts a worker chunk that reads the bundler import.meta stand-in normally', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile(
      'assets/tts.worker-abc.js',
      'var _vite_importMeta = { url: self.location.href };\n' +
        'const _import_meta_url = Object(_vite_importMeta).url;'
    );

    expect(
      await collectWebBundleViolations({ distributionDir, shipsTts: true, ortAssets: assets })
    ).toEqual([]);
  });

  it('reports a worker chunk whose new.target was rewritten to the import.meta stand-in', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile(
      'assets/tts.worker-abc.js',
      'var _vite_importMeta = { url: self.location.href };\n' +
        'return Object.setPrototypeOf(closure, _vite_importMeta.prototype);'
    );

    const violations = await collectWebBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/tts.worker-abc.js');
    expect(violations[0]).toContain('_vite_importMeta');
    expect(violations[0]).toContain('new.target');
  });

  it('reports a minified worker chunk whose import.meta stand-in was renamed', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile(
      'assets/tts.worker-abc.js',
      'var df={url:self.location.href},ff={};' +
        'class y{constructor(){return Object.setPrototypeOf(e,df.prototype)}}'
    );

    const violations = await collectWebBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/tts.worker-abc.js');
    expect(violations[0]).toContain('df');
  });

  it('reports a bundle that emitted no TTS worker chunk at all', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await fs.rm(path.join(distributionDir, WORKER_CHUNK));

    const violations = await collectWebBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/tts\.worker/);
    expect(violations[0]).toMatch(/vacuously/i);
  });

  it('resolves the runtime from the installed package when no assets are supplied', async () => {
    const violations = await collectWebBundleViolations({ distributionDir, shipsTts: true });

    const installed = resolveOrtAssets();
    expect(violations).toHaveLength(installed.length);
    for (const asset of installed) {
      expect(violations.join('\n')).toContain(`ort/${asset.fileName}`);
    }
  });
});

describe('collectWebBundleViolations for a dist that must not ship TTS', () => {
  let appDir: string;
  let ttsFreeDistribution: string;

  beforeEach(async () => {
    appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-bundle-app-'));
    ttsFreeDistribution = path.join(appDir, 'dist');
    await fs.mkdir(ttsFreeDistribution, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(appDir, { recursive: true, force: true });
  });

  async function writeAppFile(relativePath: string, content: string): Promise<void> {
    const absolute = path.join(appDir, relativePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  }

  it('reports the worker chunk and the ORT runtime file it must not contain', async () => {
    await writeAppFile('dist/assets/tts.worker-abc.js', 'self.onmessage=()=>{};');
    await writeAppFile('dist/assets/ort-wasm-simd-threaded.jsep-xyz.wasm', 'runtime bytes');

    const violations = await collectWebBundleViolations({
      distributionDir: ttsFreeDistribution,
      shipsTts: false,
    });

    expect(violations).toHaveLength(2);
    expect(violations.join('\n')).toContain('assets/tts.worker-abc.js');
    expect(violations.join('\n')).toContain('assets/ort-wasm-simd-threaded.jsep-xyz.wasm');
  });

  it('accepts a dist carrying neither a worker chunk nor an ORT runtime file', async () => {
    await writeAppFile('dist/assets/index-abc.js', 'console.info("app");');

    const violations = await collectWebBundleViolations({
      distributionDir: ttsFreeDistribution,
      shipsTts: false,
    });

    expect(violations).toEqual([]);
  });

  it('still reports a file over the Cloudflare Pages per-file size cap', async () => {
    const oversized = path.join(ttsFreeDistribution, 'oversized.bin');
    const handle = await fs.open(oversized, 'w');
    await handle.truncate(PAGES_MAX_FILE_BYTES + 1);
    await handle.close();

    const violations = await collectWebBundleViolations({
      distributionDir: ttsFreeDistribution,
      shipsTts: false,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('oversized.bin');
  });

  it('does not walk the checked-in native copy of the built app beside dist', async () => {
    await writeAppFile(
      'android/app/src/main/assets/public/assets/tts.worker-abc.js',
      'self.onmessage=()=>{};'
    );
    await writeAppFile(
      'android/app/src/main/assets/public/ort/ort-wasm-simd-threaded.jsep.wasm',
      'runtime bytes'
    );

    const violations = await collectWebBundleViolations({
      distributionDir: ttsFreeDistribution,
      shipsTts: false,
    });

    expect(violations).toEqual([]);
  });
});

describe('appBundleOptions', () => {
  it('expects TTS in the merged web bundle', () => {
    expect(appBundleOptions('/repo', 'apps/web')).toEqual({
      distributionDir: path.join('/repo', 'apps/web/dist'),
      shipsTts: true,
    });
  });

  it('expects no TTS in the admin bundle', () => {
    expect(appBundleOptions('/repo', 'apps/admin')).toEqual({
      distributionDir: path.join('/repo', 'apps/admin/dist'),
      shipsTts: false,
    });
  });

  it('expects no TTS in the crawler-view bundle, which has no build script yet', () => {
    expect(appBundleOptions('/repo', 'apps/crawler-view').shipsTts).toBe(false);
  });

  it('throws for an app that never declared a TTS expectation', () => {
    expect(() => appBundleOptions('/repo', 'apps/sandbox')).toThrow(/declared TTS expectation/);
  });
});

describe('checkPagesLimits', () => {
  const file = (relativePath: string, bytes: number): BundleFile => ({
    relativePath,
    absolutePath: `/dist/${relativePath}`,
    bytes,
  });

  it('reports nothing when the bundle is within both caps', () => {
    expect(checkPagesLimits([file('a.js', 10)])).toEqual([]);
  });

  it('reports the total when the bundle exceeds the Pages file-count cap', () => {
    const files = Array.from({ length: PAGES_MAX_FILE_COUNT + 1 }, (_, index) =>
      file(`chunk-${String(index)}.js`, 1)
    );

    const violations = checkPagesLimits(files);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(String(PAGES_MAX_FILE_COUNT + 1));
    expect(violations[0]).toContain(String(PAGES_MAX_FILE_COUNT));
  });
});

describe('verifyWebBundle', () => {
  it('resolves for a compliant bundle', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);

    await expect(
      verifyWebBundle({ distributionDir, shipsTts: true, ortAssets: assets })
    ).resolves.toBeUndefined();
  });

  it('throws naming every violation it found', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/ort-wasm-simd-threaded.jsep-B0T3yYHD.wasm', 'copy');
    await writeDistributionFile('assets/tts.worker-abc.js', 'new URL("/assets/ort-wasm.wasm",x)');

    await expect(
      verifyWebBundle({ distributionDir, shipsTts: true, ortAssets: assets })
    ).rejects.toThrow(/ort-wasm-simd-threaded\.jsep-B0T3yYHD\.wasm[\S\s]*tts\.worker-abc\.js/);
  });

  it('hashes the real self-hosted runtime bytes rather than trusting the file name', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    const wasm = path.join(distributionDir, 'ort/ort-wasm-simd-threaded.jsep.wasm');
    const digest = createHash('sha256')
      .update(await fs.readFile(wasm))
      .digest('hex');
    await fs.writeFile(wasm, 'tampered');

    await expect(
      verifyWebBundle({ distributionDir, shipsTts: true, ortAssets: assets })
    ).rejects.toThrow(new RegExp(digest.slice(0, 12)));
  });
});

describe('declaredOrtCommonVersion', () => {
  async function writeManifest(manifest: unknown): Promise<string> {
    const manifestPath = path.join(runtimeDir, 'package.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    return manifestPath;
  }

  it('reads the exact onnxruntime-common pin packages/ui declares', async () => {
    const uiManifest = path.resolve(import.meta.dirname, '../packages/ui/package.json');
    const declared = (
      JSON.parse(await fs.readFile(uiManifest, 'utf8')) as {
        dependencies: Record<string, string>;
      }
    ).dependencies['onnxruntime-common'];

    expect(await declaredOrtCommonVersion()).toBe(declared);
  });

  it('rejects a manifest that declares no onnxruntime-common pin', async () => {
    const manifestPath = await writeManifest({ dependencies: { 'kokoro-js': '1.2.3' } });

    await expect(declaredOrtCommonVersion(manifestPath)).rejects.toThrow(/onnxruntime-common/);
  });

  it('rejects a range where an exact onnxruntime-common pin is required', async () => {
    const manifestPath = await writeManifest({
      dependencies: { 'onnxruntime-common': '^1.22.0' },
    });

    await expect(declaredOrtCommonVersion(manifestPath)).rejects.toThrow(/\^1\.22\.0/);
  });
});
