import { appendFileSync } from 'node:fs';

const SEMVER_REGEX = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;

/**
 * Converts a semver string to an integer version code.
 * Formula: major * 10000 + minor * 100 + patch
 *
 * Examples: 1.0.0 → 10000, 1.2.3 → 10203, 2.15.1 → 21501
 */
export function semverToCode(version: string): number {
  const match = SEMVER_REGEX.exec(version);
  if (!match) {
    throw new Error(`Invalid semver: "${version}" (expected X.Y.Z)`);
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  return major * 10_000 + minor * 100 + patch;
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
