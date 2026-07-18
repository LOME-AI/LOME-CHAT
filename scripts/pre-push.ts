import { execa } from 'execa';
import { isMainModule } from './lib/is-main.js';
import { ensureGitleaks } from './lib/gitleaks.js';

export interface Task {
  name: string;
  command: string;
  args: readonly string[];
}

export interface PushRef {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

const ZERO_SHA = '0'.repeat(40);

export const PARALLEL_TASKS: readonly Task[] = [
  { name: 'lint:duplication', command: 'pnpm', args: ['lint:duplication'] },
  { name: 'lint:unused', command: 'pnpm', args: ['lint:unused'] },
  { name: 'lint', command: 'pnpm', args: ['lint'] },
  { name: 'typecheck', command: 'pnpm', args: ['typecheck'] },
  { name: 'arch:check', command: 'pnpm', args: ['arch:check'] },
];

export const TEST_TASK: Task = { name: 'test', command: 'pnpm', args: ['test'] };

type Subprocess = ReturnType<typeof execa>;

function killSiblings(subprocesses: readonly Subprocess[], except: Subprocess): void {
  for (const sp of subprocesses) {
    if (sp !== except && sp.exitCode === null && !sp.killed) {
      sp.kill('SIGTERM');
    }
  }
}

export async function runParallel(tasks: readonly Task[]): Promise<void> {
  const subprocesses: Subprocess[] = tasks.map((t) =>
    execa(t.command, [...t.args], { stdio: 'inherit', reject: true })
  );

  let firstError: Error | undefined;

  async function watch(sp: Subprocess): Promise<void> {
    try {
      await sp;
    } catch (error: unknown) {
      if (firstError !== undefined) return;
      firstError = error instanceof Error ? error : new Error(String(error));
      killSiblings(subprocesses, sp);
    }
  }

  await Promise.all(subprocesses.map((sp) => watch(sp)));

  if (firstError !== undefined) {
    throw firstError;
  }
}

export async function runSequential(task: Task): Promise<void> {
  await execa(task.command, [...task.args], { stdio: 'inherit', reject: true });
}

/**
 * Parses the ref lines git feeds a pre-push hook on stdin. Each line is
 * `<local ref> <local sha> <remote ref> <remote sha>`.
 */
export function parsePushReferences(stdin: string): PushRef[] {
  return stdin
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [localRef = '', localSha = '', remoteRef = '', remoteSha = ''] = line.split(/\s+/);
      return { localRef, localSha, remoteRef, remoteSha };
    });
}

/**
 * Builds the `git log` revision spec for gitleaks to scan only the commits
 * being pushed. Returns null when there is nothing to scan (deletions only).
 * A new branch (remote sha all-zeros) scans commits not already on any remote.
 */
export function computeLogOptionsString(references: readonly PushRef[]): string | null {
  const specs: string[] = [];
  for (const ref of references) {
    if (ref.localSha === ZERO_SHA) continue;
    specs.push(
      ref.remoteSha === ZERO_SHA
        ? `${ref.localSha} --not --remotes`
        : `${ref.remoteSha}..${ref.localSha}`
    );
  }
  // Joined specs share one `git log` argument list, so a trailing `--not
  // --remotes` (from a new-branch ref) also subtracts remote commits from any
  // preceding `a..b` range. That's a no-op in practice: the commits being
  // pushed aren't yet on a remote. Correct for the common single-ref push.
  return specs.length > 0 ? specs.join(' ') : null;
}

/**
 * Resolves the gitleaks scan task for this push, or null when there is nothing
 * to scan. Empty stdin (e.g. a manual `pnpm pre-push`) falls back to the last
 * commit, matching CI's `--log-opts=-1`.
 */
export async function buildGitleaksTask(stdin: string, isTty: boolean): Promise<Task | null> {
  let logOptions: string;
  if (isTty || stdin.trim() === '') {
    logOptions = '-1';
  } else {
    const computed = computeLogOptionsString(parsePushReferences(stdin));
    if (computed === null) return null;
    logOptions = computed;
  }
  const bin = await ensureGitleaks();
  return {
    name: 'gitleaks',
    command: bin,
    args: ['git', '--redact', '--no-banner', `--log-opts=${logOptions}`],
  };
}

export async function main(stdin: string, isTty: boolean): Promise<void> {
  const gitleaksTask = await buildGitleaksTask(stdin, isTty);
  const parallelTasks = gitleaksTask ? [...PARALLEL_TASKS, gitleaksTask] : PARALLEL_TASKS;
  console.log(`Running in parallel: ${parallelTasks.map((t) => t.name).join(', ')}`);
  await runParallel(parallelTasks);
  console.log('Static checks passed. Running tests...');
  await runSequential(TEST_TASK);
}

/* v8 ignore start -- CLI entry point uses process.exit, exercised via husky */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  void (async () => {
    try {
      const isTty = process.stdin.isTTY;
      const stdin = await readStdin();
      await main(stdin, isTty);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`pre-push failed: ${message}`);
      process.exit(1);
    }
  })();
}
/* v8 ignore stop */
