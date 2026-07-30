import path from 'node:path';
import os from 'node:os';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';
import { discoverWorkspaces } from './workspaces.js';

/**
 * Invocation-aware, duration-weighted worker budget for `vitest run`.
 *
 * A full monorepo run (`pnpm test`, `HB_TEST_SCOPE=full`) launches every
 * package's vitest as a separate turbo process; left uncapped they collectively
 * oversubscribe the box. This wrapper gives each package a slice of an
 * oversubscribed budget proportional to its historical test-work, so heavy
 * packages get more workers and the aggregate fork count stays bounded. A solo
 * run gets one worker per core (100%): the wrapper always runs under coverage,
 * whose CPU-bound workload oversubscribes above 100%.
 *
 * Weight = Σ per-test-file duration for the package (worker-invariant, unlike
 * wall time). Captured on full runs via vitest's json reporter and written to a
 * per-package cache file (per-package, never one shared file — turbo runs each
 * package concurrently, so a shared file would race).
 */

const OVERSUB_FULL = 1.5;
// The wrapper always runs vitest under `--coverage`, whose workload is CPU-bound
// (v8 JIT-off inflates heavy files like OPAQUE crypto), so >100% oversubscribes
// the box — the CPU-bound poles inflate and slow tests cross testTimeout. 100%
// gives each fork a full core with no oversubscription.
const OVERSUB_SOLO = 1;

export type TestScope = 'full' | 'solo';

export interface AllocationInput {
  readonly scope: TestScope;
  readonly cores: number;
  readonly pkg: string;
  readonly weightsByPkg: Readonly<Record<string, number>>;
  readonly packagesInRun: readonly string[];
}

export interface Allocation {
  readonly maxWorkers: number;
  readonly shareLabel: string;
}

function sum(nums: readonly number[]): number {
  let total = 0;
  for (const n of nums) {
    total += n;
  }
  return total;
}

/** Median of a non-empty list; throws on empty (callers guarantee non-empty). */
export function median(nums: readonly number[]): number {
  const sorted = nums.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid];
  if (hi === undefined) {
    throw new Error('median requires a non-empty list');
  }
  if (sorted.length % 2 !== 0) {
    return hi;
  }
  return sum(sorted.slice(mid - 1, mid + 1)) / 2;
}

/**
 * The core budget formula. Pure so the fallbacks (even split, median) are
 * unit-tested without touching the filesystem.
 *
 * - solo → one worker per core (100%; coverage is CPU-bound, so no oversub).
 * - full, no weights yet → even split across the packages in the run.
 * - full, weights present → share proportional to this package's work; a
 *   package absent from a populated cache borrows the median known weight.
 */
export function computeMaxWorkers(input: AllocationInput): Allocation {
  const { scope, cores, pkg, weightsByPkg, packagesInRun } = input;
  if (scope === 'solo') {
    return { maxWorkers: Math.max(1, Math.round(cores * OVERSUB_SOLO)), shareLabel: 'solo' };
  }
  const budget = Math.round(cores * OVERSUB_FULL);
  const knownWeights = Object.values(weightsByPkg);
  if (knownWeights.length === 0) {
    const n = Math.max(1, packagesInRun.length);
    return { maxWorkers: Math.max(1, Math.round(budget / n)), shareLabel: 'even' };
  }
  const med = median(knownWeights);
  const workFor = (p: string): number => weightsByPkg[p] ?? med;
  const totalWork = sum(packagesInRun.map((p) => workFor(p)));
  const share = totalWork > 0 ? workFor(pkg) / totalWork : 1 / Math.max(1, packagesInRun.length);
  return {
    maxWorkers: Math.max(1, Math.round(budget * share)),
    shareLabel: `${String(Math.round(share * 100))}%`,
  };
}

export interface VitestJsonReport {
  readonly testResults?: readonly {
    readonly startTime?: number;
    readonly endTime?: number;
    readonly name?: string;
  }[];
}

/**
 * Total test-work for a package = Σ per-file (endTime − startTime) from vitest's
 * jest-shaped json report. Entries missing finite timestamps are skipped rather
 * than crashing the run (weights are advisory).
 */
export function sumWorkFromJsonReport(report: VitestJsonReport): number {
  let total = 0;
  for (const { startTime, endTime } of report.testResults ?? []) {
    if (
      typeof startTime !== 'number' ||
      typeof endTime !== 'number' ||
      !Number.isFinite(startTime) ||
      !Number.isFinite(endTime)
    ) {
      continue;
    }
    total += endTime - startTime;
  }
  return total;
}

// A "pole" is a single test file whose wall time single-handedly extends its
// package's test wall-clock (≈ max(longestFile, totalWork/workers)); the only
// fix is to split the file. The threshold is a strict majority of the package's
// total test-work plus an absolute floor, so a huge-but-balanced package trips
// nothing while a package dominated by one heavy file trips.
export const POLE_MIN_MS = 15_000;
export const POLE_MAJORITY_SHARE = 0.5;

export interface Pole {
  readonly file: string;
  readonly wallMs: number;
  readonly share: number;
}

export interface PoleThresholds {
  readonly minMs: number;
  readonly majorityShare: number;
}

type TestResultEntry = NonNullable<VitestJsonReport['testResults']>[number];

/**
 * A test-result entry reduced to `{ file, wallMs }`, or `undefined` when it has
 * missing/non-finite timestamps, a missing name, or non-positive wall time —
 * the same guarding as `sumWorkFromJsonReport`.
 */
function toWallEntry(
  entry: TestResultEntry
): { readonly file: string; readonly wallMs: number } | undefined {
  const { startTime, endTime, name } = entry;
  if (
    typeof startTime !== 'number' ||
    typeof endTime !== 'number' ||
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    typeof name !== 'string'
  ) {
    return undefined;
  }
  const wallMs = endTime - startTime;
  return wallMs > 0 ? { file: name, wallMs } : undefined;
}

/** Sum wall time by file path — a file run under multiple vitest projects appears once per project. */
function aggregateWallByFile(report: VitestJsonReport): Map<string, number> {
  const wallByFile = new Map<string, number>();
  for (const entry of report.testResults ?? []) {
    const parsed = toWallEntry(entry);
    if (parsed !== undefined) {
      wallByFile.set(parsed.file, (wallByFile.get(parsed.file) ?? 0) + parsed.wallMs);
    }
  }
  return wallByFile;
}

/**
 * Pole test files in a package's vitest json report. Wall time is aggregated by
 * file path first, then a file is a pole iff its total wall time is at least
 * `minMs` (the floor) AND a strict majority (`> majorityShare`) of the package's
 * total test-work. Returned sorted by wall time descending.
 */
export function detectPoles(report: VitestJsonReport, thresholds: PoleThresholds): readonly Pole[] {
  const wallByFile = aggregateWallByFile(report);
  let total = 0;
  for (const wallMs of wallByFile.values()) {
    total += wallMs;
  }
  if (total <= 0) {
    return [];
  }

  const poles: Pole[] = [];
  for (const [file, wallMs] of wallByFile) {
    if (wallMs >= thresholds.minMs && wallMs / total > thresholds.majorityShare) {
      poles.push({ file, wallMs, share: wallMs / total });
    }
  }
  return poles.toSorted((a, b) => b.wallMs - a.wallMs);
}

/** `@hushbox/ops` → `ops`; an unscoped name is returned unchanged. */
export function deriveShortName(fullName: string): string {
  const slash = fullName.lastIndexOf('/');
  return slash === -1 ? fullName : fullName.slice(slash + 1);
}

export interface WeightFsRead {
  readonly readdir: (dir: string) => readonly string[];
  readonly readFile: (file: string) => string;
}

/**
 * Load every `<pkg>.json` weight file in `dir` into a `pkg → totalWorkMs` map.
 * A missing directory (cold cache) yields an empty map; a corrupt or
 * non-conforming file is skipped so one bad advisory file can't fail the run —
 * it self-heals on the next full run's write.
 */
export function readWeights(dir: string, fs: WeightFsRead): Record<string, number> {
  let entries: readonly string[];
  try {
    entries = fs.readdir(dir);
  } catch {
    return {};
  }
  const weights: Record<string, number> = {};
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    const packageName = entry.slice(0, -'.json'.length);
    try {
      const parsed = JSON.parse(fs.readFile(path.join(dir, entry))) as { totalWorkMs?: unknown };
      if (typeof parsed.totalWorkMs === 'number' && Number.isFinite(parsed.totalWorkMs)) {
        weights[packageName] = parsed.totalWorkMs;
      }
    } catch {
      continue;
    }
  }
  return weights;
}

export interface WeightFsWrite {
  readonly mkdir: (dir: string) => void;
  readonly writeFile: (file: string, content: string) => void;
}

/** Write `dir/<pkg>.json = { totalWorkMs }`, creating the dir if needed. */
export function writeWeight(
  dir: string,
  packageName: string,
  totalWorkMs: number,
  fs: WeightFsWrite
): void {
  fs.mkdir(dir);
  fs.writeFile(path.join(dir, `${packageName}.json`), JSON.stringify({ totalWorkMs }));
}

const REPORTS_DIRECTORY_FLAG = '--coverage.reportsDirectory';
const COVERAGE_INCLUDE_FLAG = '--coverage.include';
const ARGUMENT_SEPARATOR = '--';

/**
 * Coverage output directory for one wrapper process, under the package's
 * conventional `coverage/` tree so the repo's gitignore and turbo `outputs`
 * globs keep covering it.
 *
 * Vitest keeps its per-worker raw coverage in `<reportsDirectory>/.tmp` and
 * deletes that directory when it finishes, so two runs sharing a reports
 * directory delete each other's `.tmp`: the losing run dies on
 * `Something removed the coverage directory` with every test passed and no
 * `FAIL` line, which reads as a healthy run. Keying the directory to the pid
 * removes the shared resource instead of arbitrating access to it.
 */
export function processCoverageDirectory(packageDir: string, pid: number): string {
  return path.join(packageDir, 'coverage', `run-${String(pid)}`);
}

/** Whether the caller already pinned the reports directory, in either CLI form. */
function suppliesReportsDirectory(args: readonly string[]): boolean {
  return args.some(
    (argument) =>
      argument === REPORTS_DIRECTORY_FLAG || argument.startsWith(`${REPORTS_DIRECTORY_FLAG}=`)
  );
}

/** A flag's value in either CLI form (`--flag=value`, `--flag value`); first occurrence wins. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  for (const [index, argument] of args.entries()) {
    if (argument.startsWith(`${flag}=`)) {
      return argument.slice(flag.length + 1);
    }
    if (argument === flag) {
      return args[index + 1];
    }
  }
  return undefined;
}

/**
 * Drop every bare separator a package manager puts among forwarded arguments.
 * vitest 4.1.8 discards every argument after a bare `--` (verified: the
 * positional file filter is dropped and the whole package is collected), so an
 * unstripped separator silently voids the rest of the passthrough *and* this
 * wrapper's own appended defaults — the coverage override lands nowhere and the
 * run still exits 0. Position cannot be used to tell a harmful separator from a
 * meaningful one, because there is no meaningful one: `pnpm run <script> -- <args>`
 * re-inserts a separator of its own on top of the one it consumed, so `-- --`
 * arrives as two, and a `test` script carrying its own arguments makes them land
 * mid-list. A `--`-prefixed token longer than the separator is an ordinary flag
 * and is untouched.
 */
function dropSeparators(args: readonly string[]): readonly string[] {
  return args.filter((argument) => argument !== ARGUMENT_SEPARATOR);
}

export interface RunDeps {
  readonly cores: number;
  readonly weightsDir: string;
  readonly cwdPackageName: string;
  /** Used only when the caller passes no `--coverage.reportsDirectory` of its own. */
  readonly defaultReportsDirectory: string;
  readonly passthroughArgs: readonly string[];
  /**
   * The authoritative set of packages a full run spans — every workspace package
   * with a `test` script. This, not the weight files, fixes N: a cold cache has
   * no weight files, so deriving N from them would collapse to N=1 and hand each
   * concurrently-running package the whole oversubscribed budget (box OOM). The
   * weight files supply only the shares.
   */
  readonly listTestPackages: () => readonly string[];
  readonly readWeights: (dir: string) => Record<string, number>;
  readonly writeWeight: (dir: string, packageName: string, totalWorkMs: number) => void;
  readonly readReport: (file: string) => VitestJsonReport | undefined;
  /**
   * The run's coverage map (`coverage-final.json`) from the reports directory in
   * force, or `undefined` when the run wrote none — a file that is absent means
   * no coverage data exists to judge, which is not the same as a map that is
   * present and empty.
   */
  readonly readCoverageMap: (
    reportsDirectory: string
  ) => Readonly<Record<string, unknown>> | undefined;
  readonly makeTmpFile: () => string;
  readonly exec: (vitestArgs: readonly string[], childEnv: NodeJS.ProcessEnv) => Promise<number>;
  readonly log: (line: string) => void;
  readonly warn: (line: string) => void;
}

/**
 * `1` when a supplied `--coverage.include` measured nothing at all (warning as
 * it goes), `0` otherwise. An include that matches at least one file puts that
 * file in the coverage map even if no test exercised it (verified on vitest
 * 4.1.8: zero tests collected still yields the file at 0%), so an empty map
 * isolates the one vacuous case — a glob matching no file, which vitest reports
 * as a clean 0/0 run and exits 0 on. The glob's shape is not the discriminator:
 * a wildcard-free include measures the named file, and a wildcard-bearing one
 * can still match nothing.
 */
function vacuousScopeExitCode(
  packageName: string,
  args: readonly string[],
  deps: Pick<RunDeps, 'readCoverageMap' | 'warn' | 'defaultReportsDirectory'>
): number {
  const include = flagValue(args, COVERAGE_INCLUDE_FLAG);
  if (include === undefined) {
    return 0;
  }
  // A missing map is a run that produced no coverage data to judge, not a
  // vacuous scope; only a map that exists and is empty proves the include void.
  const coverageMap = deps.readCoverageMap(
    flagValue(args, REPORTS_DIRECTORY_FLAG) ?? deps.defaultReportsDirectory
  );
  if (coverageMap === undefined || Object.keys(coverageMap).length > 0) {
    return 0;
  }
  deps.warn(
    `[${packageName}] EMPTY COVERAGE SCOPE — ${COVERAGE_INCLUDE_FLAG}=${include} matched no file, so this run measured nothing; fix the glob (it is relative to the package directory) or drop the flag.`
  );
  return 1;
}

/**
 * Orchestrate one package's test run: compute the budget, print the allocation
 * line, exec `vitest run --coverage --maxWorkers=<n>`, and (full runs only)
 * capture this package's weight from the json report. Returns vitest's exit
 * code so CI fails on test failure.
 */
export async function runPackageTests(env: NodeJS.ProcessEnv, deps: RunDeps): Promise<number> {
  const scope: TestScope = env['HB_TEST_SCOPE'] === 'full' ? 'full' : 'solo';
  const envPackage = env['HB_PKG_NAME'];
  const packageName =
    envPackage && envPackage.length > 0 ? envPackage : deriveShortName(deps.cwdPackageName);

  const weightsByPackage = deps.readWeights(deps.weightsDir);
  // N is authoritative from the workspace, never from the weight files: a cold
  // cache has no weight files, so weights ∪ self would give N=1 and hand this
  // package the whole oversubscribed budget while every sibling does the same.
  // A solo run is the whole box regardless, so it needs no enumeration.
  const packagesInRun =
    scope === 'full' ? [...new Set([...deps.listTestPackages(), packageName])] : [packageName];
  const { maxWorkers, shareLabel } = computeMaxWorkers({
    scope,
    cores: deps.cores,
    pkg: packageName,
    weightsByPkg: weightsByPackage,
    packagesInRun,
  });

  deps.log(
    `[${packageName}] scope=${scope} · work-share=${shareLabel} · workers=${String(maxWorkers)}`
  );

  const passthroughArgs = dropSeparators(deps.passthroughArgs);
  const vitestArgs = [
    'run',
    '--coverage',
    `--maxWorkers=${String(maxWorkers)}`,
    ...passthroughArgs,
  ];
  if (!suppliesReportsDirectory(passthroughArgs)) {
    vitestArgs.push(`${REPORTS_DIRECTORY_FLAG}=${deps.defaultReportsDirectory}`);
    // The default is no longer vitest's `<pkg>/coverage`, so say where it went.
    deps.log(`[${packageName}] coverage report → ${deps.defaultReportsDirectory}`);
  }
  // The json report is captured on every scope: weight capture needs it on full
  // runs, the pole gate needs it on every run. Keep the default console reporter
  // so failures still show; json purely captures per-file durations.
  const temporaryFile = deps.makeTmpFile();
  vitestArgs.push('--reporter=default', '--reporter=json', `--outputFile.json=${temporaryFile}`);

  const vitestExitCode = await deps.exec(vitestArgs, env);
  const exitCode = Math.max(
    vitestExitCode,
    vacuousScopeExitCode(packageName, passthroughArgs, deps)
  );

  const report = deps.readReport(temporaryFile);
  if (report === undefined) {
    // Absence of data is not a pole and not a weight; pass vitest's code through.
    deps.warn(
      `[${packageName}] no json report at ${temporaryFile}: weight capture and pole gate skipped`
    );
    return exitCode;
  }

  // Weight capture stays full-only — solo runs read no shares and write none.
  if (scope === 'full') {
    deps.writeWeight(deps.weightsDir, packageName, sumWorkFromJsonReport(report));
  }

  const poles = detectPoles(report, { minMs: POLE_MIN_MS, majorityShare: POLE_MAJORITY_SHARE });
  if (poles.length === 0) {
    return exitCode;
  }
  deps.warn(
    `[${packageName}] POLE TEST FILE — a single file dominates this package's test wall-clock; split it into smaller test files:`
  );
  for (const pole of poles) {
    const seconds = (pole.wallMs / 1000).toFixed(1);
    const percent = (pole.share * 100).toFixed(0);
    deps.warn(`[${packageName}]   ${pole.file} — ${seconds}s (${percent}% of package test-work)`);
  }
  // Fail the package even when vitest exited 0; a real failure still wins.
  return Math.max(exitCode, 1);
}

/* v8 ignore start -- CLI entry point exercised via the per-package test scripts */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const weightsDir = path.join(scriptDir, '.cache', 'test-weights');
    const repoRoot = path.dirname(scriptDir);
    const cwd = process.cwd();
    const cwdPackageName = (
      JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { name: string }
    ).name;

    return runPackageTests(process.env, {
      cores: os.availableParallelism(),
      weightsDir,
      cwdPackageName,
      defaultReportsDirectory: processCoverageDirectory(cwd, process.pid),
      passthroughArgs: process.argv.slice(2),
      listTestPackages: () =>
        discoverWorkspaces(repoRoot)
          .filter((workspace) => {
            const manifest = JSON.parse(
              readFileSync(path.join(repoRoot, workspace.path, 'package.json'), 'utf8')
            ) as { scripts?: Record<string, string> };
            return typeof manifest.scripts?.['test'] === 'string';
          })
          .map((workspace) => workspace.name),
      readWeights: (dir) =>
        readWeights(dir, {
          readdir: (d) => readdirSync(d),
          readFile: (file) => readFileSync(file, 'utf8'),
        }),
      writeWeight: (dir, packageName, totalWorkMs) => {
        writeWeight(dir, packageName, totalWorkMs, {
          mkdir: (d) => {
            mkdirSync(d, { recursive: true });
          },
          writeFile: (file, content) => {
            writeFileSync(file, content);
          },
        });
      },
      readReport: (file) => {
        if (!existsSync(file)) {
          return;
        }
        return JSON.parse(readFileSync(file, 'utf8')) as VitestJsonReport;
      },
      readCoverageMap: (reportsDirectory) => {
        // An explicitly supplied reports directory may be relative, and vitest
        // resolves it against the package directory this wrapper runs in.
        const file = path.resolve(cwd, reportsDirectory, 'coverage-final.json');
        if (!existsSync(file)) {
          return;
        }
        return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      },
      makeTmpFile: () =>
        path.join(os.tmpdir(), `hb-test-weights-${String(process.pid)}-${String(Date.now())}.json`),
      exec: async (vitestArgs, childEnv) => {
        const result = await execa('vitest', [...vitestArgs], {
          stdio: 'inherit',
          reject: false,
          preferLocal: true,
          cwd,
          env: childEnv,
        });
        return typeof result.exitCode === 'number' ? result.exitCode : 1;
      },
      log: (line) => {
        console.log(line);
      },
      warn: (line) => {
        console.warn(line);
      },
    });
  });
}
/* v8 ignore stop */
