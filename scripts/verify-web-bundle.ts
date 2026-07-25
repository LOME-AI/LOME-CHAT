/**
 * Build-time guards on the merged web bundle (`apps/web/dist`), run by
 * `buildWebBundle` right after the marketing merge so prod, e2e, and the
 * preview build all pay them.
 *
 * Three classes of problem it turns into a build failure:
 *   - onnxruntime-web bloat: the TTS worker must reference only the
 *     self-hosted `/ort/` runtime. A bundler-emitted copy (or a built chunk
 *     still pointing at one) means the wasm ships two or three times — tens of
 *     megabytes in every Pages deploy, APK, and OTA zip.
 *   - onnxruntime version skew: which onnxruntime-common copy ends up in the
 *     worker is decided by pnpm's hoist selection, so a dependency bump can
 *     silently swap it, or split the chunk across two versions.
 *   - Cloudflare Pages hard limits: exceeding either one fails the deploy, and
 *     a routine transformers bump is enough to push the ORT wasm past the
 *     per-file cap. Failing here surfaces it at build time instead.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ORT_DIR, resolveOrtAssets, type OrtAsset } from './lib/ort-assets-plugin.js';

// Cloudflare Pages hard limits: 25 MiB per file, 20,000 files per deployment.
export const PAGES_MAX_FILE_BYTES = 26_214_400;
export const PAGES_MAX_FILE_COUNT = 20_000;

/**
 * `packages/ui` declares onnxruntime-common purely to decide which copy pnpm
 * hoists: `@huggingface/transformers` imports it as a bare external but does
 * not depend on it, so the shipped `Tensor` is whatever the hoist dir happens
 * to hold. That makes the shipped ORT version a resolution outcome rather than
 * a decision. Reading the pin from here — never copying its value — is what
 * turns it into a build-time invariant.
 */
const UI_PACKAGE_JSON = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../packages/ui/package.json'
);

/** A range would let the shipped copy drift while still satisfying the pin. */
const EXACT_VERSION = /^\d+\.\d+\.\d+[\w+.-]*$/u;

/**
 * The version every ORT copy in the bundle must report.
 *
 * @param uiPackageJson manifest carrying the pin; the default is the real one.
 */
export async function declaredOrtCommonVersion(
  uiPackageJson: string = UI_PACKAGE_JSON
): Promise<string> {
  const manifest = JSON.parse(await fs.readFile(uiPackageJson, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const declared = manifest.dependencies?.['onnxruntime-common'];
  if (declared === undefined || !EXACT_VERSION.test(declared)) {
    throw new Error(
      `${uiPackageJson} must pin onnxruntime-common to an exact version ` +
        `(found ${declared ?? 'no declaration'}) — that pin decides which ORT ` +
        `copy pnpm hoists into the shipped TTS worker.`
    );
  }
  return declared;
}

/** onnxruntime-web runtime artifacts, wherever a bundler emitted them. */
const ORT_RUNTIME_FILE = /^ort-wasm.*\.(?:wasm|mjs)$/u;

/**
 * Bundler-emitted asset paths for the ORT wasm — the reference the extern-wasm
 * import condition exists to remove. A built chunk containing one means the
 * fat variant resolved again.
 */
const BUNDLED_ORT_REFERENCES = ['/assets/ort-', '/_astro/ort-'];

export interface BundleFile {
  /** Slash-separated, relative to the dist root. */
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly bytes: number;
}

export interface VerifyWebBundleOptions {
  readonly distributionDir: string;
  /**
   * Defaults to the ORT runtime of the installed transformers — the same
   * resolution `ortAssetsPlugin` emits from, so the check compares the bundle
   * against exactly what the build was supposed to copy.
   */
  readonly ortAssets?: readonly OrtAsset[];
}

async function listBundleFiles(directory: string, prefix = ''): Promise<BundleFile[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: BundleFile[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listBundleFiles(absolutePath, relativePath)));
      continue;
    }
    const stats = await fs.stat(absolutePath);
    files.push({ relativePath, absolutePath, bytes: stats.size });
  }
  return files;
}

async function sha256(filePath: string): Promise<string | null> {
  const bytes = await fs.readFile(filePath).catch(() => null);
  return bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
}

/**
 * The self-hosted runtime under `dist/ort/` must exist and be byte-identical to
 * the installed package — a stale or partial copy is a runtime 404 or a version
 * skew the browser only discovers on a user's first Listen.
 */
async function checkSelfHostedRuntime(
  distributionDir: string,
  assets: readonly OrtAsset[]
): Promise<string[]> {
  const violations: string[] = [];
  for (const asset of assets) {
    const relativePath = `${ORT_DIR}/${asset.fileName}`;
    const expected = await sha256(asset.absPath);
    const actual = await sha256(path.join(distributionDir, ORT_DIR, asset.fileName));
    if (actual === null) {
      violations.push(`missing self-hosted ORT runtime file: ${relativePath}`);
    } else if (actual !== expected) {
      violations.push(
        `self-hosted ORT runtime file does not match the installed package: ` +
          `${relativePath} (sha256 ${actual}, expected ${String(expected)})`
      );
    }
  }
  return violations;
}

function checkStrayRuntimeCopies(files: readonly BundleFile[]): string[] {
  return files
    .filter(
      (file) =>
        ORT_RUNTIME_FILE.test(path.posix.basename(file.relativePath)) &&
        !file.relativePath.startsWith(`${ORT_DIR}/`)
    )
    .map(
      (file) =>
        `redundant ORT runtime copy outside ${ORT_DIR}/: ` +
        `${file.relativePath} (${String(file.bytes)} B)`
    );
}

/**
 * Only `.js` is scanned: source maps legitimately name the bundler-emitted
 * asset in their `sources`, and flagging those would be a false positive.
 */
async function checkBundledRuntimeReferences(files: readonly BundleFile[]): Promise<string[]> {
  const violations: string[] = [];
  for (const file of files.filter((candidate) => candidate.relativePath.endsWith('.js'))) {
    const source = await fs.readFile(file.absolutePath, 'utf8');
    const reference = BUNDLED_ORT_REFERENCES.find((candidate) => source.includes(candidate));
    if (reference !== undefined) {
      violations.push(
        `built script references the bundler-emitted ORT asset "${reference}…": ` +
          `${file.relativePath} — the ORT runtime must load from ${ORT_DIR}/ only`
      );
    }
  }
  return violations;
}

/**
 * A quoted version literal. The backtick alternative is spelled out rather than
 * escaped: `\`` is an invalid identity escape under the `u` flag.
 */
const QUOTED_VERSION = '(?:`[^`]*`|\'[^\']*\'|"[^"]*")';

/**
 * onnxruntime reports its version through `versions: { common: … }` on its env
 * object, and a chunk carries one such site per ORT copy it embeds — the
 * externally-resolved `onnxruntime-common` module, plus the copy onnxruntime
 * inlines into its own pre-bundled `ort.min.mjs`. Sites that disagree mean two
 * onnxruntime versions shipped side by side.
 *
 * Minifiers hoist the literal into a local, so the bound value is either a
 * quoted string or an identifier to resolve in the same chunk. Lookbehind
 * rather than a capture group, so the match is `match[0]` — always present,
 * with no unreachable "group did not participate" branch to leave uncovered.
 */
const ORT_VERSION_SITE = new RegExp(
  String.raw`(?<=versions\s*:\s*\{\s*common\s*:\s*)` +
    String.raw`(?:${QUOTED_VERSION}|[A-Za-z_$][\w$]*)`,
  'gu'
);

const QUOTE = /^[`'"]/u;

/** Identifiers match `[A-Za-z_$][\w$]*`, so `$` is the only regex-special char. */
function assignmentsTo(identifier: string): RegExp {
  const escaped = identifier.replaceAll('$', () => String.raw`\$`);
  return new RegExp(String.raw`(?<=(?<![\w$])${escaped}\s*=\s*)` + QUOTED_VERSION, 'gu');
}

/** The version a `versions.common` site reports, or null if it cannot be read. */
function resolveVersion(source: string, bound: string): string | null {
  if (QUOTE.test(bound)) {
    return bound.slice(1, -1);
  }
  const distinct = [
    ...new Set([...source.matchAll(assignmentsTo(bound))].map((match) => match[0].slice(1, -1))),
  ];
  // A minifier binds the literal exactly once; anything else means the local
  // being read is not the one holding the version.
  const [only] = distinct.length === 1 ? distinct : [];
  return only ?? null;
}

async function checkOrtCommonVersion(
  files: readonly BundleFile[],
  expected: string
): Promise<string[]> {
  const violations: string[] = [];
  let sites = 0;
  for (const file of files.filter((candidate) => candidate.relativePath.endsWith('.js'))) {
    const source = await fs.readFile(file.absolutePath, 'utf8');
    for (const site of source.matchAll(ORT_VERSION_SITE)) {
      sites += 1;
      const found = resolveVersion(source, site[0]);
      if (found === null) {
        violations.push(
          `cannot read the onnxruntime version bound at versions.common in ` +
            `${file.relativePath} (bound to \`${site[0]}\`) — the built output no ` +
            `longer has the shape this check reads, so it must not be trusted`
        );
      } else if (found !== expected) {
        violations.push(
          `shipped onnxruntime-common version is ${found}, expected ${expected}: ` +
            `${file.relativePath} — pnpm hoisted a copy other than the one ` +
            `packages/ui pins (a dependency bump or a hoist-order change does this ` +
            `silently)`
        );
      }
    }
  }
  if (sites === 0) {
    violations.push(
      `no onnxruntime version site (versions.common) in any built script — ` +
        `either the bundle stopped shipping onnxruntime or this check no longer ` +
        `recognizes the built output, and it must not pass vacuously`
    );
  }
  return violations;
}

export function checkPagesLimits(files: readonly BundleFile[]): string[] {
  const violations = files
    .filter((file) => file.bytes > PAGES_MAX_FILE_BYTES)
    .map(
      (file) =>
        `over Cloudflare Pages' per-file cap: ${file.relativePath} ` +
        `(${String(file.bytes)} B, cap ${String(PAGES_MAX_FILE_BYTES)} B)`
    );
  if (files.length > PAGES_MAX_FILE_COUNT) {
    violations.push(
      `over Cloudflare Pages' per-deployment file cap: ${String(files.length)} files ` +
        `(cap ${String(PAGES_MAX_FILE_COUNT)})`
    );
  }
  return violations;
}

export async function collectWebBundleViolations(
  options: VerifyWebBundleOptions
): Promise<string[]> {
  const assets = options.ortAssets ?? resolveOrtAssets();
  const files = await listBundleFiles(options.distributionDir);
  return [
    ...(await checkSelfHostedRuntime(options.distributionDir, assets)),
    ...checkStrayRuntimeCopies(files),
    ...(await checkBundledRuntimeReferences(files)),
    ...(await checkOrtCommonVersion(files, await declaredOrtCommonVersion())),
    ...checkPagesLimits(files),
  ];
}

export async function verifyWebBundle(options: VerifyWebBundleOptions): Promise<void> {
  const violations = await collectWebBundleViolations(options);
  if (violations.length > 0) {
    throw new Error(
      `Web bundle verification failed (${options.distributionDir}):\n` +
        violations.map((violation) => `  - ${violation}`).join('\n')
    );
  }
}
