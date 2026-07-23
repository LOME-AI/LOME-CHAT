import { describe, it, expect, vi } from 'vitest';
import {
  computeMaxWorkers,
  median,
  sumWorkFromJsonReport,
  deriveShortName,
  readWeights,
  writeWeight,
  runPackageTests,
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

describe('runPackageTests', () => {
  const baseDeps = (over: Partial<RunDeps> = {}): RunDeps => ({
    cores: 8,
    weightsDir: '/wd',
    cwdPackageName: '@hushbox/ops',
    passthroughArgs: [],
    listTestPackages: vi.fn(() => ['ops']),
    readWeights: vi.fn(() => ({})),
    writeWeight: vi.fn(),
    readReport: vi.fn<RunDeps['readReport']>(() => {}),
    makeTmpFile: vi.fn(() => '/weights-tmp/report.json'),
    exec: vi.fn(() => Promise.resolve(0)),
    log: vi.fn(),
    warn: vi.fn(),
    ...over,
  });

  it('runs solo at one worker per core and captures no weights', async () => {
    const deps = baseDeps({ exec: vi.fn(() => Promise.resolve(0)) });
    const code = await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps);
    expect(code).toBe(0);
    expect(deps.exec).toHaveBeenCalledTimes(1);
    // round(8 × 1.0) = 8.
    expect(deps.exec).toHaveBeenCalledWith(
      ['run', '--coverage', '--maxWorkers=8'],
      expect.objectContaining({ HB_TEST_SCOPE: 'solo' })
    );
    expect(deps.writeWeight).not.toHaveBeenCalled();
    expect(deps.readReport).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('[ops] scope=solo · work-share=solo · workers=8');
  });

  it('forwards passthrough args to vitest', async () => {
    const deps = baseDeps();
    await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps);
    expect(deps.exec).toHaveBeenCalledWith(
      ['run', '--coverage', '--maxWorkers=8'],
      expect.anything()
    );

    const deps2 = baseDeps({ passthroughArgs: ['--passWithNoTests'] });
    await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps2);
    expect(deps2.exec).toHaveBeenCalledWith(
      expect.arrayContaining(['--passWithNoTests']),
      expect.anything()
    );
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

  it('warns and writes nothing when a full run produces no json report', async () => {
    const deps = baseDeps({ readReport: vi.fn<RunDeps['readReport']>(() => {}) });
    await runPackageTests({ HB_TEST_SCOPE: 'full', HB_PKG_NAME: 'api' }, deps);
    expect(deps.warn).toHaveBeenCalledWith(
      '[api] weight capture skipped: no json report at /weights-tmp/report.json'
    );
    expect(deps.writeWeight).not.toHaveBeenCalled();
  });

  it('propagates vitest exit code', async () => {
    const deps = baseDeps({ exec: vi.fn(() => Promise.resolve(1)) });
    const code = await runPackageTests({ HB_TEST_SCOPE: 'solo', HB_PKG_NAME: 'ops' }, deps);
    expect(code).toBe(1);
  });
});
