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
 * run oversubscribes lightly (125% of cores).
 *
 * Weight = Σ per-test-file duration for the package (worker-invariant, unlike
 * wall time). Captured on full runs via vitest's json reporter and written to a
 * per-package cache file (per-package, never one shared file — turbo runs each
 * package concurrently, so a shared file would race).
 */

const OVERSUB_FULL = 1.5;
// A solo run oversubscribes lightly: an I/O-bound suite (observed solo test:api
// ~70% CPU) leaves cores idle, so 125% of them soaks up the slack without the
// full-run box-sharing math.
const OVERSUB_SOLO = 1.25;

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
 * - solo → 125% of the box (light oversubscription for I/O-bound suites).
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

export interface RunDeps {
  readonly cores: number;
  readonly weightsDir: string;
  readonly cwdPackageName: string;
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
  readonly makeTmpFile: () => string;
  readonly exec: (vitestArgs: readonly string[], childEnv: NodeJS.ProcessEnv) => Promise<number>;
  readonly log: (line: string) => void;
  readonly warn: (line: string) => void;
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

  const vitestArgs = [
    'run',
    '--coverage',
    `--maxWorkers=${String(maxWorkers)}`,
    ...deps.passthroughArgs,
  ];
  let temporaryFile: string | undefined;
  if (scope === 'full') {
    temporaryFile = deps.makeTmpFile();
    // Keep the default console reporter so a full run still shows failures;
    // add json purely to capture per-file durations into the temp file.
    vitestArgs.push('--reporter=default', '--reporter=json', `--outputFile.json=${temporaryFile}`);
  }

  const exitCode = await deps.exec(vitestArgs, env);

  if (scope === 'full' && temporaryFile !== undefined) {
    const report = deps.readReport(temporaryFile);
    if (report === undefined) {
      deps.warn(`[${packageName}] weight capture skipped: no json report at ${temporaryFile}`);
    } else {
      deps.writeWeight(deps.weightsDir, packageName, sumWorkFromJsonReport(report));
    }
  }

  return exitCode;
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
