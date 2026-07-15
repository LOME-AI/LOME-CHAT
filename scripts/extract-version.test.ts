import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { appendFileSync } from 'node:fs';
import { extractVersion, main, semverToCode, writeGithubOutput } from './extract-version.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, appendFileSync: vi.fn() };
});

describe('semverToCode', () => {
  it('converts 1.0.0 to 1_000_000', () => {
    expect(semverToCode('1.0.0')).toBe(1_000_000);
  });

  it('converts 1.2.3 to 1_002_003', () => {
    expect(semverToCode('1.2.3')).toBe(1_002_003);
  });

  it('converts 2.15.1 to 2_015_001', () => {
    expect(semverToCode('2.15.1')).toBe(2_015_001);
  });

  it('converts 0.1.0 to 1_000', () => {
    expect(semverToCode('0.1.0')).toBe(1000);
  });

  it('converts 10.0.0 to 10_000_000', () => {
    expect(semverToCode('10.0.0')).toBe(10_000_000);
  });

  it('keeps a 3-digit patch below the next minor (radix-1000, no carry)', () => {
    expect(semverToCode('1.0.100')).not.toBe(semverToCode('1.1.0'));
  });

  it('orders 1.1.0 above 1.0.100', () => {
    expect(semverToCode('1.1.0')).toBeGreaterThan(semverToCode('1.0.100'));
  });

  it('yields a code >= 1_000_000 for any major >= 1', () => {
    expect(semverToCode('1.0.0')).toBeGreaterThanOrEqual(1_000_000);
    expect(semverToCode('1.0.100')).toBeGreaterThanOrEqual(1_000_000);
    expect(semverToCode('1.1.0')).toBeGreaterThanOrEqual(1_000_000);
  });

  it('is monotonic across ascending versions', () => {
    const versions = ['1.0.0', '1.0.1', '1.0.100', '1.1.0', '1.1.1', '2.0.0'];
    const codes = versions.map((version) => semverToCode(version));
    for (let index = 1; index < codes.length; index += 1) {
      expect(codes[index]).toBeGreaterThan(codes[index - 1]!);
    }
  });

  it('throws on invalid semver', () => {
    expect(() => semverToCode('not-a-version')).toThrow();
  });

  it('throws on incomplete semver (missing patch)', () => {
    expect(() => semverToCode('1.2')).toThrow();
  });

  it('throws on empty string', () => {
    expect(() => semverToCode('')).toThrow();
  });

  it('accepts pre-release suffix and ignores it for code', () => {
    expect(semverToCode('1.0.0-beta.1')).toBe(1_000_000);
  });

  it('accepts alpha pre-release suffix', () => {
    expect(semverToCode('2.3.1-alpha.5')).toBe(2_003_001);
  });

  it('accepts rc pre-release suffix', () => {
    expect(semverToCode('1.2.3-rc.1')).toBe(1_002_003);
  });
});

describe('extractVersion', () => {
  it('strips v prefix from INPUT_VERSION if present', () => {
    const result = extractVersion({ INPUT_VERSION: 'v1.5.0' });

    expect(result.versionName).toBe('1.5.0');
    expect(result.versionCode).toBe(1_005_000);
  });

  it('parses INPUT_VERSION without v prefix', () => {
    const result = extractVersion({ INPUT_VERSION: '1.5.0' });

    expect(result.versionName).toBe('1.5.0');
    expect(result.versionCode).toBe(1_005_000);
  });

  it('returns version as alias for versionName', () => {
    const result = extractVersion({ INPUT_VERSION: '2.1.0' });

    expect(result.version).toBe(result.versionName);
  });

  it('throws on invalid semver input', () => {
    expect(() => extractVersion({ INPUT_VERSION: 'bad' })).toThrow();
  });

  it('throws when INPUT_VERSION is missing', () => {
    expect(() => extractVersion({})).toThrow('INPUT_VERSION is required');
  });

  it('handles pre-release INPUT_VERSION', () => {
    const result = extractVersion({ INPUT_VERSION: '1.0.0-beta.1' });

    expect(result.versionName).toBe('1.0.0-beta.1');
    expect(result.versionCode).toBe(1_000_000);
    expect(result.version).toBe('1.0.0-beta.1');
  });

  it('strips v prefix from pre-release INPUT_VERSION', () => {
    const result = extractVersion({ INPUT_VERSION: 'v1.0.0-beta.1' });

    expect(result.versionName).toBe('1.0.0-beta.1');
    expect(result.versionCode).toBe(1_000_000);
  });
});

describe('writeGithubOutput', () => {
  const appendMock = vi.mocked(appendFileSync);
  const originalOutput = process.env['GITHUB_OUTPUT'];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    appendMock.mockClear();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalOutput === undefined) delete process.env['GITHUB_OUTPUT'];
    else process.env['GITHUB_OUTPUT'] = originalOutput;
    logSpy.mockRestore();
  });

  it('appends each line + trailing newline to $GITHUB_OUTPUT when set', () => {
    process.env['GITHUB_OUTPUT'] = '/mock/github-output-file';

    writeGithubOutput(['version=1.2.3', 'version_name=1.2.3', 'version_code=10203']);

    expect(appendMock).toHaveBeenCalledTimes(3);
    expect(appendMock).toHaveBeenNthCalledWith(1, '/mock/github-output-file', 'version=1.2.3\n');
    expect(appendMock).toHaveBeenNthCalledWith(
      2,
      '/mock/github-output-file',
      'version_name=1.2.3\n'
    );
    expect(appendMock).toHaveBeenNthCalledWith(
      3,
      '/mock/github-output-file',
      'version_code=10203\n'
    );
  });

  it('prints each line to stdout via console.log', () => {
    delete process.env['GITHUB_OUTPUT'];

    writeGithubOutput(['version=1.0.0', 'version_name=1.0.0', 'version_code=10000']);

    expect(logSpy).toHaveBeenCalledTimes(3);
    expect(logSpy).toHaveBeenNthCalledWith(1, 'version=1.0.0');
    expect(logSpy).toHaveBeenNthCalledWith(2, 'version_name=1.0.0');
    expect(logSpy).toHaveBeenNthCalledWith(3, 'version_code=10000');
  });

  it('skips appending when GITHUB_OUTPUT is unset (still logs)', () => {
    delete process.env['GITHUB_OUTPUT'];

    writeGithubOutput(['version=2.0.0']);

    expect(appendMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('version=2.0.0');
  });

  it('is a no-op for both branches with an empty lines array', () => {
    process.env['GITHUB_OUTPUT'] = '/mock/github-output-file';

    writeGithubOutput([]);

    expect(appendMock).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe('main', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_OUTPUT', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('writes the extracted version components to the workflow output', () => {
    vi.stubEnv('INPUT_VERSION', 'v2.5.1');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    main();

    const lines = logSpy.mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual(['version_name=2.5.1', 'version_code=2005001', 'version=2.5.1']);
  });

  it('throws when INPUT_VERSION is missing', () => {
    vi.stubEnv('INPUT_VERSION', '');

    expect(() => {
      main();
    }).toThrow('INPUT_VERSION is required');
  });
});
