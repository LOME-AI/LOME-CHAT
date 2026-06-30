/**
 * Tiny CLI helpers shared by ops scripts.
 *
 * `parseOrExit` mirrors `scripts/lib/run-cli.ts` to keep ops self-contained —
 * avoids cross-workspace relative imports that confuse tsgo's type resolution.
 * The two copies are intentionally identical; if the contract changes,
 * promote it to a shared workspace package and import from both sides.
 */
import { appendFileSync } from 'node:fs';

export function parseOrExit<T>(
  parser: (args: string[]) => T | { error: string },
  args: string[] = process.argv.slice(2)
): T {
  const result = parser(args);
  if (typeof result === 'object' && result != null && 'error' in result) {
    console.error(result.error);
    process.exit(1);
  }
  return result;
}

/**
 * Read a required env var, exiting(1) with a clear message if it's absent or
 * empty. `env` is injectable for tests; production passes `process.env`.
 */
export function requireEnv(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const value = env[name];
  if (value === undefined || value === '') {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

/** Append a `key=value` line to a GitHub Actions `$GITHUB_OUTPUT` file. */
export function writeGithubOutput(githubOutputPath: string, key: string, value: string): void {
  appendFileSync(githubOutputPath, `${key}=${value}\n`);
}
