import { execaSync } from 'execa';
import { isCountedPath } from './lines-of-code.js';

/**
 * Rewrite git's rename numstat syntax to the post-rename path so filtering
 * judges the file where it lives now. Git emits either a braced shared-prefix
 * form (`src/{old => new}/a.ts`, where a side may be empty) or a bare
 * whole-path form (`old.ts => new/name.ts`).
 */
export function resolveNumstatPath(rawPath: string): string {
  if (rawPath.includes('{')) {
    return rawPath.replaceAll(/\{[^}]*? => ([^}]*?)\}/g, '$1').replaceAll('//', '/');
  }
  const arrowIndex = rawPath.indexOf(' => ');
  if (arrowIndex === -1) return rawPath;
  return rawPath.slice(arrowIndex + ' => '.length);
}

/**
 * Total lines added + deleted from `git log --numstat --format=` output,
 * counting only human-authored source files (the README line-count rules).
 * Binary files report `-` counts and are skipped.
 */
export function sumNumstatChurn(numstatOutput: string): number {
  let total = 0;
  for (const line of numstatOutput.split('\n')) {
    const parts = line.split('\t');
    // Fewer than three fields: the blank separator lines between commits, or
    // a row that is not numstat output at all.
    if (parts.length < 3) continue;
    const [added, deleted] = parts;
    if (added === '-' || deleted === '-') continue;
    if (!isCountedPath(resolveNumstatPath(parts.slice(2).join('\t')))) continue;
    total += Number(added) + Number(deleted);
  }
  return total;
}

/**
 * Total source lines ever added or deleted across the repository's history
 * (HEAD's ancestry, merge commits excluded — git's numstat default). Computed
 * from the local clone alone: no API, no credentials, so it runs for any
 * contributor. `--find-renames` keeps a pure rename at ~zero churn instead of
 * a full delete + re-add.
 */
export function countLinesChurned(rootDir: string): number {
  const shallowProbe = execaSync('git', ['-C', rootDir, 'rev-parse', '--is-shallow-repository'], {
    reject: false,
  });
  if (shallowProbe.exitCode !== 0) {
    throw new Error(
      `Cannot count churned lines: ${rootDir} is not a git repository (${shallowProbe.stderr.trim()})`
    );
  }
  if (shallowProbe.stdout.trim() === 'true') {
    throw new Error(
      'Cannot count churned lines: this clone is shallow, so history is incomplete. Run `git fetch --unshallow` first.'
    );
  }

  const headProbe = execaSync('git', ['-C', rootDir, 'rev-parse', '--verify', '--quiet', 'HEAD'], {
    reject: false,
  });
  // No commits yet: zero churn is the true value, not a fallback.
  if (headProbe.exitCode !== 0) return 0;

  const log = execaSync('git', ['-C', rootDir, 'log', '--numstat', '--format=', '--find-renames']);
  return sumNumstatChurn(log.stdout);
}
