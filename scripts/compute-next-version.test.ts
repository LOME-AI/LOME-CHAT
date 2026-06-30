import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseSemver,
  determineBumpType,
  computeNextVersion,
  findLatestStableTag,
  findMergedPrLabels,
  main,
} from './compute-next-version.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  appendFileSync: vi.fn(),
}));

describe('parseSemver', () => {
  it('parses a basic semver string', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it('strips v prefix', () => {
    expect(parseSemver('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it('parses 0.0.0', () => {
    expect(parseSemver('0.0.0')).toEqual({ major: 0, minor: 0, patch: 0 });
  });

  it('parses large version numbers', () => {
    expect(parseSemver('10.20.30')).toEqual({ major: 10, minor: 20, patch: 30 });
  });

  it('throws on invalid input', () => {
    expect(() => parseSemver('not-a-version')).toThrow();
  });

  it('throws on empty string', () => {
    expect(() => parseSemver('')).toThrow();
  });

  it('throws on incomplete semver', () => {
    expect(() => parseSemver('1.2')).toThrow();
  });

  it('throws on pre-release suffix', () => {
    expect(() => parseSemver('1.2.3-beta.1')).toThrow();
  });
});

describe('determineBumpType', () => {
  it('returns major when major label present', () => {
    expect(determineBumpType(['major'])).toBe('major');
  });

  it('returns minor when minor label present', () => {
    expect(determineBumpType(['minor'])).toBe('minor');
  });

  it('returns patch when patch label present', () => {
    expect(determineBumpType(['patch'])).toBe('patch');
  });

  it('defaults to patch when no recognized label', () => {
    expect(determineBumpType(['bugfix', 'documentation'])).toBe('patch');
  });

  it('defaults to patch when labels array is empty', () => {
    expect(determineBumpType([])).toBe('patch');
  });

  it('major takes priority over minor and patch', () => {
    expect(determineBumpType(['patch', 'minor', 'major'])).toBe('major');
  });

  it('minor takes priority over patch', () => {
    expect(determineBumpType(['patch', 'minor'])).toBe('minor');
  });
});

describe('computeNextVersion', () => {
  it('returns 1.0.0 when no prior tags', () => {
    const result = computeNextVersion({ latestTag: null, labels: [] });

    expect(result.version).toBe('1.0.0');
    expect(result.versionName).toBe('1.0.0');
    expect(result.versionCode).toBe(10_000);
  });

  it('increments patch by default', () => {
    const result = computeNextVersion({ latestTag: 'v1.0.0', labels: [] });

    expect(result.version).toBe('1.0.1');
    expect(result.versionCode).toBe(10_001);
  });

  it('increments minor and resets patch', () => {
    const result = computeNextVersion({ latestTag: 'v1.2.3', labels: ['minor'] });

    expect(result.version).toBe('1.3.0');
    expect(result.versionCode).toBe(10_300);
  });

  it('increments major and resets minor and patch', () => {
    const result = computeNextVersion({ latestTag: 'v1.2.3', labels: ['major'] });

    expect(result.version).toBe('2.0.0');
    expect(result.versionCode).toBe(20_000);
  });

  it('increments patch with explicit patch label', () => {
    const result = computeNextVersion({ latestTag: 'v1.2.3', labels: ['patch'] });

    expect(result.version).toBe('1.2.4');
    expect(result.versionCode).toBe(10_204);
  });

  it('returns 1.0.0 when no prior tags even with major label', () => {
    const result = computeNextVersion({ latestTag: null, labels: ['major'] });

    expect(result.version).toBe('1.0.0');
  });

  it('version and versionName are always equal', () => {
    const result = computeNextVersion({ latestTag: 'v3.5.9', labels: ['patch'] });

    expect(result.version).toBe(result.versionName);
  });
});

describe('findLatestStableTag', () => {
  let execFileSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const childProcess = await import('node:child_process');
    execFileSyncMock = vi.mocked(childProcess.execFileSync);
  });

  it('returns the first stable tag from sorted output', () => {
    execFileSyncMock.mockReturnValue('v2.1.0\nv2.0.0\nv1.0.0\n');

    expect(findLatestStableTag()).toBe('v2.1.0');
  });

  it('invokes git via execFileSync with array args (no shell interpolation)', () => {
    execFileSyncMock.mockReturnValue('v1.0.0\n');
    findLatestStableTag();
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git',
      ['tag', '--list', 'v*', '--sort=-version:refname'],
      expect.objectContaining({ encoding: 'utf8' })
    );
  });

  it('returns null when no tags exist', () => {
    execFileSyncMock.mockReturnValue('');

    expect(findLatestStableTag()).toBeNull();
  });

  it('skips pre-release tags', () => {
    execFileSyncMock.mockReturnValue('v2.0.0-beta.1\nv1.5.0\nv1.0.0\n');

    expect(findLatestStableTag()).toBe('v1.5.0');
  });

  it('returns null when only pre-release tags exist', () => {
    execFileSyncMock.mockReturnValue('v2.0.0-beta.1\nv1.0.0-alpha.3\n');

    expect(findLatestStableTag()).toBeNull();
  });
});

describe('findMergedPrLabels', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  it('returns labels from the first associated PR', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ labels: [{ name: 'minor' }, { name: 'enhancement' }] }]),
    });

    const labels = await findMergedPrLabels('owner/repo', 'abc123', 'token');

    expect(labels).toEqual(['minor', 'enhancement']);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/commits/abc123/pulls',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token',
        }),
      })
    );
  });

  it('returns empty array when no PRs found', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const labels = await findMergedPrLabels('owner/repo', 'abc123', 'token');

    expect(labels).toEqual([]);
  });

  it('throws on API error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    });

    await expect(findMergedPrLabels('owner/repo', 'abc123', 'token')).rejects.toThrow(
      'GitHub API error: 403 Forbidden'
    );
  });

  it('returns empty array when the PR carries no labels field', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{}]),
    });

    const labels = await findMergedPrLabels('owner/repo', 'abc123', 'token');

    expect(labels).toEqual([]);
  });
});

describe('main', () => {
  const mockFetch = vi.fn();
  let execFileSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    vi.stubEnv('GITHUB_TOKEN', 'token');
    vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo');
    vi.stubEnv('GITHUB_SHA', 'abc123');
    vi.stubEnv('GITHUB_OUTPUT', '');
    const childProcess = await import('node:child_process');
    execFileSyncMock = vi.mocked(childProcess.execFileSync);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('throws when GITHUB_TOKEN is missing', async () => {
    vi.stubEnv('GITHUB_TOKEN', '');

    await expect(main()).rejects.toThrow('GITHUB_TOKEN is required');
  });

  it('throws when GITHUB_REPOSITORY is missing', async () => {
    vi.stubEnv('GITHUB_REPOSITORY', '');

    await expect(main()).rejects.toThrow('GITHUB_REPOSITORY is required');
  });

  it('throws when GITHUB_SHA is missing', async () => {
    vi.stubEnv('GITHUB_SHA', '');

    await expect(main()).rejects.toThrow('GITHUB_SHA is required');
  });

  it('writes the computed next version to the workflow output', async () => {
    execFileSyncMock.mockReturnValue('v1.2.3\n');
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ labels: [{ name: 'minor' }] }]),
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main();

    const lines = logSpy.mock.calls.map((call) => String(call[0]));
    expect(lines).toContain('version=1.3.0');
    expect(lines).toContain('version_name=1.3.0');
    expect(lines).toContain('version_code=10300');
  });
});
