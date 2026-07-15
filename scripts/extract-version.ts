import { appendFileSync } from 'node:fs';

const SEMVER_REGEX = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;

/**
 * Converts a semver string to an integer version code, radix-1000.
 * Formula: major * 1_000_000 + minor * 1_000 + patch
 *
 * Radix-1000 (not the old radix-100) so a patch or minor of 100–999 can never
 * carry into the next component: `semverToCode('1.0.100')` (1_000_100) stays
 * strictly below `semverToCode('1.1.0')` (1_001_000). Codes are monotonic in
 * (major, minor, patch) and any major ≥ 1 yields a code ≥ 1_000_000 — above
 * every code the old radix-100 scheme could produce for a comparable version,
 * so the sequence never regresses across the switch. Fits an Android int32
 * versionCode for major up to ~2147.
 *
 * Examples: 1.0.0 → 1_000_000, 1.2.3 → 1_002_003, 2.15.1 → 2_015_001
 */
export function semverToCode(version: string): number {
  const match = SEMVER_REGEX.exec(version);
  if (!match) {
    throw new Error(`Invalid semver: "${version}" (expected X.Y.Z)`);
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  return major * 1_000_000 + minor * 1000 + patch;
}

interface VersionEnv {
  INPUT_VERSION?: string;
}

interface VersionResult {
  versionName: string;
  versionCode: number;
  version: string;
}

/**
 * Writes each entry to `$GITHUB_OUTPUT` (when set) and mirrors them to
 * stdout via `console.log`. Used by release-workflow scripts so callers
 * share one source of truth for the dual file+stdout output protocol.
 */
export function writeGithubOutput(lines: readonly string[]): void {
  const outputFile = process.env['GITHUB_OUTPUT'];
  if (outputFile) {
    for (const line of lines) {
      appendFileSync(outputFile, `${line}\n`);
    }
  }
  for (const line of lines) {
    console.log(line);
  }
}

/**
 * Extracts version info from INPUT_VERSION environment variable.
 * Used by release workflows to parse a git tag into version components.
 */
export function extractVersion(env: VersionEnv): VersionResult {
  const input = env.INPUT_VERSION;
  if (!input) {
    throw new Error('INPUT_VERSION is required');
  }

  const cleaned = input.startsWith('v') ? input.slice(1) : input;
  const versionCode = semverToCode(cleaned);

  return { versionName: cleaned, versionCode, version: cleaned };
}

/** CLI entrypoint — writes to $GITHUB_OUTPUT when run in Actions. */
export function main(): void {
  const result = extractVersion(process.env as VersionEnv);
  writeGithubOutput([
    `version_name=${result.versionName}`,
    `version_code=${String(result.versionCode)}`,
    `version=${result.version}`,
  ]);
}

/* v8 ignore start -- CLI wiring; main() is covered via unit tests */
const scriptPath = process.argv[1] ?? '';
const isDirectExecution =
  scriptPath.endsWith('extract-version.ts') || scriptPath.endsWith('extract-version.js');
if (isDirectExecution) {
  main();
}
/* v8 ignore stop */
