import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateVersionString,
  getDistributionZipPath,
  getApiBaseUrl,
  getSetVersionUrl,
  getUpdatesCurrentUrl,
  getR2ObjectKey,
  parsePlatformArgument,
  runCapTestUpdate,
  zipDirectory,
} from './cap-test-update.js';

const dollarMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ $: dollarMock }));

describe('generateVersionString', () => {
  it('generates a string starting with dev-update-', () => {
    const version = generateVersionString();
    expect(version).toMatch(/^dev-update-/);
  });

  it('generates unique strings on successive calls', () => {
    const v1 = generateVersionString();
    const v2 = generateVersionString();
    expect(v1).not.toBe(v2);
  });

  it('includes a timestamp and counter component', () => {
    const version = generateVersionString();
    // Format: dev-update-{timestamp}-{counter}
    const parts = version.replace('dev-update-', '').split('-');
    expect(parts).toHaveLength(2);
    expect(Number(parts[0])).toBeGreaterThan(0);
    expect(Number(parts[1])).toBeGreaterThan(0);
  });
});

describe('getDistZipPath', () => {
  it('returns the dist zip path under web app', () => {
    const result = getDistributionZipPath('/root');
    expect(result).toBe('/root/apps/web/dist');
  });
});

describe('getApiBaseUrl', () => {
  it('returns the default local API URL', () => {
    expect(getApiBaseUrl()).toBe('http://localhost:8788');
  });
});

describe('getUpdatesCurrentUrl', () => {
  it('returns the updates/current endpoint URL', () => {
    expect(getUpdatesCurrentUrl()).toBe('http://localhost:8788/updates/current');
  });
});

describe('getSetVersionUrl', () => {
  it('returns the dev/set-version endpoint URL', () => {
    expect(getSetVersionUrl()).toBe('http://localhost:8788/dev/set-version');
  });
});

describe('getR2ObjectKey', () => {
  it('returns platform-specific R2 key for ios', () => {
    expect(getR2ObjectKey('ios', 'abc123')).toBe('hushbox-app-builds/builds/ios/abc123.zip');
  });

  it('returns platform-specific R2 key for android', () => {
    expect(getR2ObjectKey('android', '1.0.0')).toBe('hushbox-app-builds/builds/android/1.0.0.zip');
  });

  it('returns platform-specific R2 key for android-direct', () => {
    expect(getR2ObjectKey('android-direct', 'dev-update-1234567890')).toBe(
      'hushbox-app-builds/builds/android-direct/dev-update-1234567890.zip'
    );
  });
});

describe('zipDirectory', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(tmpdir(), 'cap-test-zip-'));
  });

  function cleanup(): void {
    rmSync(temporaryDir, { recursive: true, force: true });
  }

  it('creates a zip file at the target path containing entries for the source files', async () => {
    const sourceDir = path.join(temporaryDir, 'src');
    mkdirSync(sourceDir);
    writeFileSync(path.join(sourceDir, 'a.txt'), 'alpha');
    writeFileSync(path.join(sourceDir, 'b.txt'), 'beta');

    const zipPath = path.join(temporaryDir, 'out.zip');
    await zipDirectory(sourceDir, zipPath);

    const zipBytes = readFileSync(zipPath);
    // PK\x03\x04 = local file header signature
    expect(zipBytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(zipBytes.byteLength).toBeGreaterThan(0);

    const zipString = zipBytes.toString('binary');
    expect(zipString).toContain('a.txt');
    expect(zipString).toContain('b.txt');

    cleanup();
  });

  it('includes nested files relative to the source directory root', async () => {
    const sourceDir = path.join(temporaryDir, 'src');
    const nested = path.join(sourceDir, 'nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, 'deep.txt'), 'deep content');

    const zipPath = path.join(temporaryDir, 'out.zip');
    await zipDirectory(sourceDir, zipPath);

    const zipBytes = readFileSync(zipPath);
    const zipString = zipBytes.toString('binary');
    expect(zipString).toContain('nested/deep.txt');

    cleanup();
  });

  it('rejects when archiver cannot write to the destination', async () => {
    const sourceDir = path.join(temporaryDir, 'src');
    mkdirSync(sourceDir);
    const invalidZipPath = path.join(temporaryDir, 'no-such-dir', 'out.zip');
    await expect(zipDirectory(sourceDir, invalidZipPath)).rejects.toThrow();
    cleanup();
  });
});

describe('runCapTestUpdate', () => {
  let rootDir: string;
  const fetchMock = vi.fn();
  /** Records each $({options})`command` invocation as { options, command }. */
  let shellCalls: { options: Record<string, unknown>; command: string }[];

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), 'cap-test-update-run-'));
    mkdirSync(path.join(rootDir, 'apps', 'web', 'dist'), { recursive: true });
    writeFileSync(path.join(rootDir, 'apps', 'web', 'dist', 'index.html'), '<html></html>');

    shellCalls = [];
    dollarMock.mockReset();
    dollarMock.mockImplementation((options: Record<string, unknown>) => {
      return (strings: TemplateStringsArray, ...values: string[]): Promise<void> => {
        const command = strings.reduce(
          (joined, part, index) => joined + part + (values[index] ?? ''),
          ''
        );
        shellCalls.push({ options, command });
        return Promise.resolve();
      };
    });

    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/updates/current')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '0.0.9' }) });
      }
      return Promise.resolve({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('builds the web app with the generated version in the environment', async () => {
    await runCapTestUpdate(rootDir);

    const build = shellCalls.find((call) => call.command === 'pnpm exec vite build');
    expect(build).toBeDefined();
    expect(build!.options['cwd']).toBe(path.join(rootDir, 'apps', 'web'));
    const environment = build!.options['env'] as Record<string, string>;
    expect(environment['VITE_APP_VERSION']).toMatch(/^dev-update-/);
    expect(environment['VITE_PLATFORM']).toBe('android-direct');
  });

  it('zips the dist directory into web-dist.zip at the repo root', async () => {
    await runCapTestUpdate(rootDir);

    expect(existsSync(path.join(rootDir, 'web-dist.zip'))).toBe(true);
  });

  it('uploads the zip to R2 under the platform-specific key', async () => {
    await runCapTestUpdate(rootDir, 'ios');

    const upload = shellCalls.find((call) => call.command.includes('wrangler r2 object put'));
    expect(upload).toBeDefined();
    expect(upload!.command).toContain('hushbox-app-builds/builds/ios/');
    expect(upload!.command).toContain(path.join(rootDir, 'web-dist.zip'));
    expect(upload!.options['cwd']).toBe(path.join(rootDir, 'apps', 'api'));
  });

  it('posts the same generated version to the set-version endpoint', async () => {
    await runCapTestUpdate(rootDir);

    const build = shellCalls.find((call) => call.command === 'pnpm exec vite build');
    const environment = build!.options['env'] as Record<string, string>;
    const setVersionCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/dev/set-version')
    );
    expect(setVersionCall).toBeDefined();
    const requestInit = setVersionCall![1] as { method: string; body: string };
    expect(requestInit.method).toBe('POST');
    expect(JSON.parse(requestInit.body)).toEqual({
      version: environment['VITE_APP_VERSION'],
    });
  });

  it('throws when the current-version query fails without building', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });

    await expect(runCapTestUpdate(rootDir)).rejects.toThrow('Failed to query current version: 500');
    expect(shellCalls).toHaveLength(0);
  });

  it('throws when setting the version override fails', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/updates/current')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '0.0.9' }) });
      }
      return Promise.resolve({ ok: false, status: 503 });
    });

    await expect(runCapTestUpdate(rootDir)).rejects.toThrow('Failed to set version: 503');
  });
});

describe('parsePlatformArgument', () => {
  it('returns undefined when --platform is not provided', () => {
    expect(parsePlatformArgument([])).toBeUndefined();
  });

  it('returns undefined when --platform has no value', () => {
    expect(parsePlatformArgument(['--platform'])).toBeUndefined();
  });

  it('returns the platform value when provided', () => {
    expect(parsePlatformArgument(['--platform', 'ios'])).toBe('ios');
  });

  it('parses android-direct platform', () => {
    expect(parsePlatformArgument(['--platform', 'android-direct'])).toBe('android-direct');
  });
});
