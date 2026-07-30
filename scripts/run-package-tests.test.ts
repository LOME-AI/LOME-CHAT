import { describe, it, expect, vi } from 'vitest';
import {
  computeMaxWorkers,
  median,
  sumWorkFromJsonReport,
  deriveShortName,
  readWeights,
  writeWeight,
  runPackageTests,
  detectPoles,
  processCoverageDirectory,
  POLE_MIN_MS,
  POLE_MAJORITY_SHARE,
  type RunDeps,
  type WeightFsRead,
} from './run-package-tests.js';

describe('median', () => {
  it('returns the middle of an odd-length list', () => {
    expect(median([600, 100, 200])).toBe(200);
  });

  it('averages the two middle values of an even-length list', () => {
    expect(median([300, 100])).toBe(200);
  });

  it('throws on an empty list', () => {
    expect(() => median([])).toThrow('non-empty');
  });
});

describe('computeMaxWorkers', () => {
  it('gives a solo run one worker per core so coverage does not oversubscribe', () => {
    const result = computeMaxWorkers({
      scope: 'solo',
      cores: 16,
      pkg: 'ops',
      weightsByPkg: {},
      packagesInRun: ['ops'],
    });
    // round(16 × 1.0) = 16.
    expect(result.maxWorkers).toBe(16);
    expect(result.shareLabel).toBe('solo');
  });

  it('splits a full run proportionally to each package work-share', () => {
    const weightsByPackage = { api: 900, web: 300 };
    const packagesInRun = ['api', 'web'];
    // cores 8 → budget round(8×1.5)=12; api share .75 → 9, web share .25 → 3.
    expect(
      computeMaxWorkers({
        scope: 'full',
        cores: 8,
        pkg: 'api',
        weightsByPkg: weightsByPackage,
        packagesInRun,
      }).maxWorkers
    ).toBe(9);
    const web = computeMaxWorkers({
      scope: 'full',
      cores: 8,
      pkg: 'web',
      weightsByPkg: weightsByPackage,
      packagesInRun,
    });
    expect(web.maxWorkers).toBe(3);
    expect(web.shareLabel).toBe('25%');
  });

  it('floors a tiny-share package at 1 worker', () => {
    const result = computeMaxWorkers({
      scope: 'full',
      cores: 4,
      pkg: 'tiny',
      weightsByPkg: { tiny: 1, huge: 1000 },
      packagesInRun: ['tiny', 'huge'],
    });
    expect(result.maxWorkers).toBe(1);
  });

  it('splits evenly when the weights cache is empty', () => {
    const result = computeMaxWorkers({
      scope: 'full',
      cores: 8,
      pkg: 'a',
      weightsByPkg: {},
      packagesInRun: ['a', 'b', 'c', 'd'],
    });
    // budget 12 / 4 packages = 3.
    expect(result.maxWorkers).toBe(3);
    expect(result.shareLabel).toBe('even');
  });

  it('uses the median known weight for a package missing from a populated cache (even count)', () => {
    const result = computeMaxWorkers({
      scope: 'full',
      cores: 8,
      pkg: 'c',
      weightsByPkg: { a: 100, b: 300 }, // median (100+300)/2 = 200
      packagesInRun: ['a', 'b', 'c'],
    });
    // work c = 200; total = 100+300+200 = 600; share .333 → round(12×.333)=4.
    expect(result.maxWorkers).toBe(4);
  });

  it('uses the median known weight for a package missing from a populated cache (odd count)', () => {
    const result = computeMaxWorkers({
      scope: 'full',
      cores: 8,
      pkg: 'd',
      weightsByPkg: { a: 100, b: 200, c: 600 }, // median = 200
      packagesInRun: ['a', 'b', 'c', 'd'],
    });
    // work d = 200; total = 900+200 = 1100; share .1818 → round(12×.1818)=2.
    expect(result.maxWorkers).toBe(2);
  });

  it('falls back to an even share when known weights are all zero', () => {
    const result = computeMaxWorkers({
      scope: 'full',
      cores: 8,
      pkg: 'a',
      weightsByPkg: { a: 0, b: 0 },
      packagesInRun: ['a', 'b'],
    });
    // total work 0 → share 1/2; budget 12 → 6.
    expect(result.maxWorkers).toBe(6);
    expect(result.shareLabel).toBe('50%');
  });
});

describe('sumWorkFromJsonReport', () => {
  it('sums per-file (endTime − startTime) across test results', () => {
    const report = {
      testResults: [
        { startTime: 0, endTime: 100 },
        { startTime: 100, endTime: 250 },
      ],
    };
    expect(sumWorkFromJsonReport(report)).toBe(250);
  });

  it('skips entries missing a finite timestamp', () => {
    const report = {
      testResults: [{ startTime: 0, endTime: 100 }, { startTime: 5 }],
    };
    expect(sumWorkFromJsonReport(report)).toBe(100);
  });

  it('returns 0 for a report with no test results', () => {
    expect(sumWorkFromJsonReport({})).toBe(0);
    expect(sumWorkFromJsonReport({ testResults: [] })).toBe(0);
  });
});

describe('detectPoles', () => {
  const thresholds = { minMs: POLE_MIN_MS, majorityShare: POLE_MAJORITY_SHARE };

  it('returns no poles for an empty report or a report with no test results', () => {
    expect(detectPoles({}, thresholds)).toEqual([]);
    expect(detectPoles({ testResults: [] }, thresholds)).toEqual([]);
  });

  it('flags a single file over the floor as a 100%-share pole', () => {
    const report = { testResults: [{ startTime: 0, endTime: 20_000, name: '/a.test.ts' }] };
    expect(detectPoles(report, thresholds)).toEqual([
      { file: '/a.test.ts', wallMs: 20_000, share: 1 },
    ]);
  });

  it('flags exactly the strict-majority file over the floor among siblings', () => {
    const report = {
      testResults: [
        { startTime: 0, endTime: 20_000, name: '/big.test.ts' },
        { startTime: 0, endTime: 5000, name: '/small-a.test.ts' },
        { startTime: 0, endTime: 4000, name: '/small-b.test.ts' },
      ],
    };
    const poles = detectPoles(report, thresholds);
    expect(poles).toHaveLength(1);
    expect(poles[0]?.file).toBe('/big.test.ts');
    expect(poles[0]?.wallMs).toBe(20_000);
    expect(poles[0]?.share).toBeCloseTo(20_000 / 29_000, 10);
  });

  it('does not flag a strict-majority file that is under the floor', () => {
    // /big is 80% of the work but only 8s — below the 15s floor.
    const report = {
      testResults: [
        { startTime: 0, endTime: 8000, name: '/big.test.ts' },
        { startTime: 0, endTime: 2000, name: '/small.test.ts' },
      ],
    };
    expect(detectPoles(report, thresholds)).toEqual([]);
  });

  it('does not flag a file over the floor whose share is not a strict majority', () => {
    const report = {
      testResults: [
        { startTime: 0, endTime: 20_000, name: '/a.test.ts' },
        { startTime: 0, endTime: 20_000, name: '/b.test.ts' },
        { startTime: 0, endTime: 5000, name: '/c.test.ts' },
      ],
    };
    expect(detectPoles(report, thresholds)).toEqual([]);
  });

  it('does not flag either file at the exact 50% boundary (two equal files)', () => {
    const report = {
      testResults: [
        { startTime: 0, endTime: 20_000, name: '/a.test.ts' },
        { startTime: 0, endTime: 20_000, name: '/b.test.ts' },
      ],
    };
    expect(detectPoles(report, thresholds)).toEqual([]);
  });

  it('skips entries with missing/non-finite timestamps, missing name, or non-positive wall time', () => {
    const report = {
      testResults: [
        { endTime: 20_000, name: '/no-start.test.ts' },
        { startTime: 0, name: '/no-end.test.ts' },
        { startTime: Number.NaN, endTime: 20_000, name: '/nan-start.test.ts' },
        { startTime: 0, endTime: Number.POSITIVE_INFINITY, name: '/inf-end.test.ts' },
        { startTime: 0, endTime: 20_000 },
        { startTime: 100, endTime: 100, name: '/zero-wall.test.ts' },
        { startTime: 200, endTime: 100, name: '/negative-wall.test.ts' },
        { startTime: 0, endTime: 20_000, name: '/real.test.ts' },
      ],
    };
    expect(detectPoles(report, thresholds)).toEqual([
      { file: '/real.test.ts', wallMs: 20_000, share: 1 },
    ]);
  });

  it('sums wall time across entries that share a file path before thresholding', () => {
    // Same file under two vitest projects: 9s + 8s = 17s > 15s floor and a
    // strict majority; neither run alone clears the floor.
    const report = {
      testResults: [
        { startTime: 0, endTime: 9000, name: '/multi.test.ts' },
        { startTime: 0, endTime: 8000, name: '/multi.test.ts' },
        { startTime: 0, endTime: 5000, name: '/other.test.ts' },
      ],
    };
    const poles = detectPoles(report, thresholds);
    expect(poles).toHaveLength(1);
    expect(poles[0]?.file).toBe('/multi.test.ts');
    expect(poles[0]?.wallMs).toBe(17_000);
  });

  it('returns multiple qualifying poles sorted by wall time descending', () => {
    // A zero majority threshold lets several files qualify so the sort is exercised.
    const report = {
      testResults: [
        { startTime: 0, endTime: 16_000, name: '/mid.test.ts' },
        { startTime: 0, endTime: 30_000, name: '/big.test.ts' },
        { startTime: 0, endTime: 20_000, name: '/second.test.ts' },
      ],
    };
    const poles = detectPoles(report, { minMs: POLE_MIN_MS, majorityShare: 0 });
    expect(poles.map((p) => p.file)).toEqual(['/big.test.ts', '/second.test.ts', '/mid.test.ts']);
  });
});

describe('deriveShortName', () => {
  it('strips the scope from a scoped package name', () => {
    expect(deriveShortName('@hushbox/ops')).toBe('ops');
  });

  it('returns an unscoped name unchanged', () => {
    expect(deriveShortName('plainpkg')).toBe('plainpkg');
  });
});

describe('readWeights', () => {
  const makeFs = (files: Record<string, string>): WeightFsRead => ({
    readdir: () => Object.keys(files),
    readFile: (file) => {
      const name = file.slice(file.lastIndexOf('/') + 1);
      const content = files[name];
      if (content === undefined) throw new Error(`no such file ${file}`);
      return content;
    },
  });

  it('loads conforming weight files, skipping non-json, malformed, and non-numeric', () => {
    const fs = makeFs({
      'api.json': '{"totalWorkMs":900}',
      'web.json': '{"totalWorkMs":300}',
      'notes.txt': 'ignored',
      'broken.json': '{oops',
      'nan.json': '{"totalWorkMs":"nope"}',
    });
    expect(readWeights('/wd', fs)).toEqual({ api: 900, web: 300 });
  });

  it('returns an empty map when the directory is missing', () => {
    const fs: WeightFsRead = {
      readdir: () => {
        throw new Error('ENOENT');
      },
      readFile: () => '',
    };
    expect(readWeights('/wd', fs)).toEqual({});
  });
});

describe('writeWeight', () => {
  it('writes dir/<pkg>.json with the totalWorkMs, creating the dir', () => {
    const mkdir = vi.fn();
    const writeFile = vi.fn();
    writeWeight('/wd', 'api', 1234, { mkdir, writeFile });
    expect(mkdir).toHaveBeenCalledWith('/wd');
    expect(writeFile).toHaveBeenCalledWith('/wd/api.json', '{"totalWorkMs":1234}');
  });
});

describe('processCoverageDirectory', () => {
  it('keeps the default output under the package coverage directory', () => {
    expect(processCoverageDirectory('/repo/packages/shared', 4242)).toBe(
      '/repo/packages/shared/coverage/run-4242'
    );
  });

  it('gives two live processes non-overlapping directories', () => {
    expect(processCoverageDirectory('/pkg', 11)).not.toBe(processCoverageDirectory('/pkg', 12));
  });
});

describe('runPackageTests', () => {
  const baseDeps = (over: Partial<RunDeps> = {}): RunDeps => ({
    cores: 8,
    weightsDir: '/wd',
    cwdPackageName: '@hushbox/ops',
    defaultReportsDirectory: '/pkg/coverage/run-1',
    passthroughArgs: [],
    listTestPackages: vi.fn(() => ['ops']),
    readWeights: vi.fn(() => ({})),
    writeWeight: vi.fn(),
    readReport: vi.fn<RunDeps['readReport']>(() => {}),
    readCoverageMap: vi.fn<RunDeps['readCoverageMap']>(() => {}),
    makeTmpFile: vi.fn(() => '/weights-tmp/report.json'),
    exec: vi.fn(() => Promise.resolve(0)),
    log: vi.fn(),
    warn: vi.fn(),
    ...over,
  });

  it('runs solo at one worker per core, writes no weight, but still captures a report for the pole gate', async () => {
    const deps = baseDeps({
      readReport: vi.fn(() => ({
        testResults: [{ startTime: 0, endTime: 1000, name: '/a.test.ts' }],
      })),
    });
    const code = await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps);
    expect(code).toBe(0);
    expect(deps.exec).toHaveBeenCalledTimes(1);
    // round(8 × 1.0) = 8; the json reporter + temp file are requested on solo too.
    expect(deps.exec).toHaveBeenCalledWith(
      [
        'run',
        '--coverage',
        '--maxWorkers=8',
        '--coverage.reportsDirectory=/pkg/coverage/run-1',
        '--reporter=default',
        '--reporter=json',
        '--outputFile.json=/weights-tmp/report.json',
      ],
      expect.objectContaining({ HB_TEST_SCOPE: 'solo' })
    );
    expect(deps.readReport).toHaveBeenCalledWith('/weights-tmp/report.json');
    expect(deps.writeWeight).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('[ops] scope=solo · work-share=solo · workers=8');
  });

  it('forwards passthrough args to vitest', async () => {
    const deps = baseDeps();
    await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps);
    expect(deps.exec).toHaveBeenCalledWith(
      expect.arrayContaining(['run', '--coverage', '--maxWorkers=8']),
      expect.anything()
    );

    const deps2 = baseDeps({ passthroughArgs: ['--passWithNoTests'] });
    await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps2);
    expect(deps2.exec).toHaveBeenCalledWith(
      expect.arrayContaining(['--passWithNoTests']),
      expect.anything()
    );
  });

  it('forwards a two-argument flag value untouched', async () => {
    const deps = baseDeps({ passthroughArgs: ['--config', 'vitest.package.config.ts'] });
    await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps);
    const args = (deps.exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as readonly string[];
    expect(args.slice(args.indexOf('--config'), args.indexOf('--config') + 2)).toEqual([
      '--config',
      'vitest.package.config.ts',
    ]);
  });

  it('sends coverage output to the per-process directory when the caller supplies none', async () => {
    const deps = baseDeps();
    await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps);
    expect(deps.exec).toHaveBeenCalledWith(
      expect.arrayContaining(['--coverage.reportsDirectory=/pkg/coverage/run-1']),
      expect.anything()
    );
  });

  it('names the defaulted coverage directory in its output', async () => {
    const deps = baseDeps();
    await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps);
    expect(deps.log).toHaveBeenCalledWith('[ops] coverage report → /pkg/coverage/run-1');
  });

  it('leaves an explicitly supplied coverage directory in force', async () => {
    const deps = baseDeps({ passthroughArgs: ['--coverage.reportsDirectory=/explicit/cov'] });
    await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps);
    const args = (deps.exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as readonly string[];
    expect(args).toContain('--coverage.reportsDirectory=/explicit/cov');
    expect(args.filter((argument) => argument.includes('/pkg/coverage/run-1'))).toEqual([]);
  });

  it('leaves a coverage directory supplied as two arguments in force', async () => {
    const deps = baseDeps({
      passthroughArgs: ['--coverage.reportsDirectory', '/explicit/cov'],
    });
    await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps);
    const args = (deps.exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as readonly string[];
    expect(args.filter((argument) => argument.includes('/pkg/coverage/run-1'))).toEqual([]);
  });

  it('drops the bare separator a package-manager passthrough puts in front of the args', async () => {
    const deps = baseDeps({
      passthroughArgs: ['--', '--coverage.reportsDirectory=/explicit/cov'],
    });
    await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps);
    const args = (deps.exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as readonly string[];
    expect(args).not.toContain('--');
    expect(args).toContain('--coverage.reportsDirectory=/explicit/cov');
    expect(args.filter((argument) => argument.includes('/pkg/coverage/run-1'))).toEqual([]);
  });

  it('drops every separator stacked in front of the args, not just the first', async () => {
    // `pnpm run <script> -- <args>` re-inserts a separator of its own, so the
    // `-- --` form arrives here as two.
    const deps = baseDeps({
      passthroughArgs: ['--', '--', '--coverage.reportsDirectory=/explicit/cov'],
    });
    await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps);
    const args = (deps.exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as readonly string[];
    expect(args).not.toContain('--');
    expect(args).toContain('--coverage.reportsDirectory=/explicit/cov');
  });

  it('drops a separator sitting between a script own arguments and the forwarded ones', async () => {
    // A `test` script that carries its own arguments makes the passthrough
    // separators land after them, which is where most packages put them.
    const deps = baseDeps({ passthroughArgs: ['--passWithNoTests', '--', '--', 'some.test.ts'] });
    await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps);
    const args = (deps.exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as readonly string[];
    expect(args).not.toContain('--');
    const kept = args.indexOf('--passWithNoTests');
    expect(args.slice(kept, kept + 2)).toEqual(['--passWithNoTests', 'some.test.ts']);
  });

  it('leaves a flag whose own name begins with the separator intact', async () => {
    const deps = baseDeps({
      passthroughArgs: ['--', '--coverage.include=lib/**/*.ts', '--passWithNoTests'],
    });
    await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps);
    const args = (deps.exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as readonly string[];
    expect(args).toContain('--coverage.include=lib/**/*.ts');
    expect(args).toContain('--passWithNoTests');
    expect(args).not.toContain('--');
  });

  it('fails a run whose supplied coverage include matched no file', async () => {
    const deps = baseDeps({
      passthroughArgs: ['--coverage.include=src/nope/**/*.ts'],
      readCoverageMap: vi.fn(() => ({})),
    });
    const code = await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps);
    expect(code).toBe(1);
    const warnings = (deps.warn as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as string)
      .join('\n');
    expect(warnings).toContain('src/nope/**/*.ts');
    expect(warnings).toMatch(/measured nothing/i);
  });

  it('fails on an empty coverage map for an include supplied as two arguments', async () => {
    const deps = baseDeps({
      passthroughArgs: ['--coverage.include', 'src/nope/**/*.ts'],
      readCoverageMap: vi.fn(() => ({})),
    });
    const code = await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps);
    expect(code).toBe(1);
  });

  it('passes a run whose supplied coverage include measured at least one file', async () => {
    const deps = baseDeps({
      passthroughArgs: ['--coverage.include=src/*.ts'],
      readCoverageMap: vi.fn(() => ({ '/pkg/src/a.ts': {} })),
      readReport: vi.fn(() => ({
        testResults: [{ startTime: 0, endTime: 500, name: '/a.test.ts' }],
      })),
    });
    const code = await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps);
    expect(code).toBe(0);
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it('reads the coverage map from the reports directory actually in force', async () => {
    const withDefault = baseDeps({ passthroughArgs: ['--coverage.include=src/*.ts'] });
    await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, withDefault);
    expect(withDefault.readCoverageMap).toHaveBeenCalledWith('/pkg/coverage/run-1');

    const withExplicit = baseDeps({
      passthroughArgs: [
        '--coverage.include=src/*.ts',
        '--coverage.reportsDirectory',
        '/explicit/cov',
      ],
    });
    await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, withExplicit);
    expect(withExplicit.readCoverageMap).toHaveBeenCalledWith('/explicit/cov');
  });

  it('does not judge the scope of a run that wrote no coverage map at all', async () => {
    const deps = baseDeps({
      passthroughArgs: ['--coverage.include=src/*.ts'],
      readCoverageMap: vi.fn<RunDeps['readCoverageMap']>(() => {}),
      readReport: vi.fn(() => ({
        testResults: [{ startTime: 0, endTime: 500, name: '/a.test.ts' }],
      })),
    });
    const code = await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps);
    expect(code).toBe(0);
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it('leaves an empty coverage map alone when no include was supplied', async () => {
    const deps = baseDeps({
      readCoverageMap: vi.fn(() => ({})),
      readReport: vi.fn(() => ({
        testResults: [{ startTime: 0, endTime: 500, name: '/a.test.ts' }],
      })),
    });
    const code = await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps);
    expect(code).toBe(0);
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it('captures the weight on a full run from the json report', async () => {
    const deps = baseDeps({
      listTestPackages: vi.fn(() => ['api', 'web']),
      readWeights: vi.fn(() => ({ api: 900, web: 300 })),
      readReport: vi.fn(() => ({ testResults: [{ startTime: 0, endTime: 1000 }] })),
    });
    const code = await runPackageTests({ HB_TEST_SCOPE: 'full', HB_PKG_NAME: 'api' }, deps);
    expect(code).toBe(0);
    expect(deps.exec).toHaveBeenCalledWith(
      expect.arrayContaining([
        '--maxWorkers=9',
        '--reporter=default',
        '--reporter=json',
        '--outputFile.json=/weights-tmp/report.json',
      ]),
      expect.anything()
    );
    expect(deps.makeTmpFile).toHaveBeenCalled();
    expect(deps.writeWeight).toHaveBeenCalledWith('/wd', 'api', 1000);
    expect(deps.log).toHaveBeenCalledWith('[api] scope=full · work-share=75% · workers=9');
  });

  it('even-splits across the authoritative workspace N on a cold cache, never the whole budget', async () => {
    const fifteen = Array.from({ length: 15 }, (_, index) => `pkg${String(index)}`);
    const deps = baseDeps({
      cores: 8, // budget = round(8 × 1.5) = 12
      readWeights: vi.fn(() => ({})), // cold cache: no weight files yet
      listTestPackages: vi.fn(() => fifteen),
    });
    await runPackageTests({ HB_TEST_SCOPE: 'full', HB_PKG_NAME: 'pkg0' }, deps);
    // N comes from the workspace (15), not from the empty weights: 12 / 15 → round → 1.
    // The bug this guards: deriving N from weights ∪ self gives N = 1 → the full budget of 12.
    expect(deps.log).toHaveBeenCalledWith('[pkg0] scope=full · work-share=even · workers=1');
  });

  it('derives the package name from cwd package.json when HB_PKG_NAME is unset or empty', async () => {
    const deps = baseDeps();
    await runPackageTests({ HB_TEST_SCOPE: 'full' }, deps);
    expect(deps.log).toHaveBeenCalledWith('[ops] scope=full · work-share=even · workers=12');

    const deps2 = baseDeps();
    await runPackageTests({ HB_TEST_SCOPE: 'full', HB_PKG_NAME: '' }, deps2);
    expect(deps2.log).toHaveBeenCalledWith('[ops] scope=full · work-share=even · workers=12');
  });

  it('warns and writes nothing when a run produces no json report', async () => {
    const deps = baseDeps({ readReport: vi.fn<RunDeps['readReport']>(() => {}) });
    await runPackageTests({ HB_TEST_SCOPE: 'full', HB_PKG_NAME: 'api' }, deps);
    expect(deps.warn).toHaveBeenCalledWith(
      '[api] no json report at /weights-tmp/report.json: weight capture and pole gate skipped'
    );
    expect(deps.writeWeight).not.toHaveBeenCalled();
  });

  it('propagates vitest exit code', async () => {
    const deps = baseDeps({
      exec: vi.fn(() => Promise.resolve(1)),
      readReport: vi.fn<RunDeps['readReport']>(() => {}),
    });
    const code = await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps);
    expect(code).toBe(1);
  });

  it('fails an otherwise-passing run when the report contains a pole', async () => {
    const deps = baseDeps({
      exec: vi.fn(() => Promise.resolve(0)),
      readReport: vi.fn(() => ({
        testResults: [
          { startTime: 0, endTime: 20_000, name: '/heavy.test.ts' },
          { startTime: 0, endTime: 3000, name: '/light.test.ts' },
        ],
      })),
    });
    const code = await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps);
    expect(code).toBe(1);
    const warnings = (deps.warn as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as string)
      .join('\n');
    expect(warnings).toContain('/heavy.test.ts');
    expect(warnings).toContain('20.0s');
    expect(warnings).toMatch(/split/i);
  });

  it('lets a real vitest failure win over the pole exit code', async () => {
    const deps = baseDeps({
      exec: vi.fn(() => Promise.resolve(2)),
      readReport: vi.fn(() => ({
        testResults: [{ startTime: 0, endTime: 20_000, name: '/heavy.test.ts' }],
      })),
    });
    const code = await runPackageTests({ HB_TEST_SCOPE: 'full', HB_PKG_NAME: 'ops' }, deps);
    expect(code).toBe(2);
  });

  it('passes the vitest exit code through when the report has no pole', async () => {
    const deps = baseDeps({
      exec: vi.fn(() => Promise.resolve(0)),
      readReport: vi.fn(() => ({
        testResults: [
          { startTime: 0, endTime: 5000, name: '/a.test.ts' },
          { startTime: 0, endTime: 5000, name: '/b.test.ts' },
        ],
      })),
    });
    const code = await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps);
    expect(code).toBe(0);
    expect(deps.warn).not.toHaveBeenCalled();
  });
});
