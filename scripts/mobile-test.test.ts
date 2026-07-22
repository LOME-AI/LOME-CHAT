import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

const admZipFilters = vi.hoisted(() => ({
  captured: [] as ((filename: string) => boolean)[],
}));
vi.mock('adm-zip', () => ({
  default: class {
    addLocalFolder(_dir: string, _prefix: string, filter?: (filename: string) => boolean): void {
      if (filter) admZipFilters.captured.push(filter);
    }
    writeZip(): void {}
  },
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readdirSync: vi.fn().mockImplementation((dir: string) => {
      if (dir === 'mobile-tests/flows') {
        return [
          '01-app-launch.yaml',
          '02-splash-screen.yaml',
          '03-webview-renders.yaml',
          '04-back-button.yaml',
          '13-ota-update.yaml',
        ];
      }
      return actual.readdirSync(dir);
    }),
    readFileSync: vi.fn().mockImplementation((file: string, _enc?: string) => {
      const filename = file.split('/').pop() ?? '';
      if (filename.startsWith('.wrangler-') && filename.endsWith('.log')) {
        // Default empty wrangler log; tests override with mockReturnValueOnce
        return '';
      }
      // getFailedFlowPaths reads each flow YAML to map the parsed `name:`
      // back to a file path. Mock returns a name derived from the basename.
      const nameMap: Record<string, string> = {
        '01-app-launch.yaml': 'App launches without crashing',
        '02-splash-screen.yaml': 'Splash screen renders',
        '03-webview-renders.yaml': 'WebView renders',
        '04-back-button.yaml': 'Back button works',
        '13-ota-update.yaml': 'OTA update downloads and applies',
      };
      return `name: ${nameMap[filename] ?? filename}\n`;
    }),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('./lib/mobile-image.js', async () => {
  // Keep the real detectKvmGid and runEmulatorContainer (they shell out via
  // the mocked execa and fs/promises stat). Only stub bakeImage so tests
  // never trigger an actual image build / pull cascade.
  const actual =
    await vi.importActual<typeof import('./lib/mobile-image.js')>('./lib/mobile-image.js');
  return {
    ...actual,
    bakeImage: vi.fn().mockResolvedValue('ghcr.io/lome-ai/hushbox-android-emulator:testtag'),
  };
});

import { execa } from 'execa';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { bakeImage } from './lib/mobile-image.js';
import {
  parseArgs,
  requireEnv,
  parseFailedFlowNames,
  flowWeight,
  partitionByWeight,
  INPUT_CHAR_WEIGHT,
  adbPortForShard,
  containerNameForShard,
  debugOutputForShard,
  listFlowsForRun,
  checkPrerequisites,
  installMaestro,
  installAndroidSdk,
  startEmulator,
  startEmulators,
  stopEmulator,
  stopEmulators,
  startDevApi,
  buildApk,
  installApk,
  installApks,
  resetVersionOverride,
  configureAppLinks,
  configureAllAppLinks,
  runMaestroShards,
  runMaestroOta,
  setupOtaUpdate,
  stopDevApi,
  withMobileTestRun,
  writeApiSlice,
  dumpApiLogTail,
  APK_APP_VERSION,
  API_SLICE_PATH,
  main,
} from './mobile-test.js';
import { MARKER_PREFIX } from './lib/extract-mobile-api-log.js';

const mockExeca = vi.mocked(execa);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockAppendFileSync = vi.mocked(appendFileSync);
const mockBakeImage = vi.mocked(bakeImage);

// execa returns a subprocess (ChildProcess + Promise). Tests need .unref()
// for startDevApi's fire-and-forget subprocess, and .kill() for the
// stopDevApi cleanup path. We attach both as vi.fn() so tests can assert on
// kill invocation when needed.
function mockSubprocess(value: unknown = {}): never {
  return Object.assign(Promise.resolve(value as never), {
    unref: vi.fn(),
    kill: vi.fn(),
  }) as never;
}

// Mirrors the readiness probes in `checkBootCompleted`: adb connect and any
// `getprop` (sys.boot_completed and service.bootanim.exit both want '1').
// Returning null lets callers chain their own dispatch logic for non-readiness
// calls.
function bootReadinessMock(cmd: string, args: readonly string[]): { stdout: string } | null {
  if (cmd !== 'adb') return null;
  if (args.includes('connect')) return { stdout: 'connected to localhost:5555' };
  if (args.includes('getprop')) return { stdout: '1' };
  return null;
}

describe('mobile-test script', () => {
  let savedEmulatorAdbPort: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' } as never);
    mockExistsSync.mockReturnValue(true);
    mockBakeImage.mockResolvedValue('ghcr.io/lome-ai/hushbox-android-emulator:testtag');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // with-env.ts loads .env.development which may set HB_EMULATOR_ADB_PORT to a
    // per-worktree slot port. Pin it to the canonical 5555 base so shard ports
    // are deterministic; tests that exercise the fail-fast override or delete it.
    // Restore the original after each test.
    savedEmulatorAdbPort = process.env['HB_EMULATOR_ADB_PORT'];
    process.env['HB_EMULATOR_ADB_PORT'] = '5555';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedEmulatorAdbPort === undefined) {
      delete process.env['HB_EMULATOR_ADB_PORT'];
    } else {
      process.env['HB_EMULATOR_ADB_PORT'] = savedEmulatorAdbPort;
    }
  });

  describe('parseArgs', () => {
    it('returns smoke false by default', () => {
      expect(parseArgs([])).toEqual({ smoke: false });
    });

    it('returns smoke true when --smoke flag is present', () => {
      expect(parseArgs(['--smoke'])).toEqual({ smoke: true });
    });

    it('ignores other flags', () => {
      expect(parseArgs(['--other', '--smoke', '--flag'])).toEqual({ smoke: true });
    });
  });

  describe('requireEnv', () => {
    afterEach(() => {
      delete process.env['HB_MOBILE_TEST_PROBE'];
    });

    it('returns the value when the variable is set', () => {
      process.env['HB_MOBILE_TEST_PROBE'] = 'some-value';

      expect(requireEnv('HB_MOBILE_TEST_PROBE')).toBe('some-value');
    });

    it('throws naming the variable when it is missing', () => {
      delete process.env['HB_MOBILE_TEST_PROBE'];

      expect(() => requireEnv('HB_MOBILE_TEST_PROBE')).toThrow('HB_MOBILE_TEST_PROBE not set.');
    });

    it('appends the hint to the error message when provided', () => {
      delete process.env['HB_MOBILE_TEST_PROBE'];

      expect(() => requireEnv('HB_MOBILE_TEST_PROBE', 'Run pnpm generate:env first.')).toThrow(
        'HB_MOBILE_TEST_PROBE not set. Run pnpm generate:env first.'
      );
    });

    it('treats an empty string as missing', () => {
      process.env['HB_MOBILE_TEST_PROBE'] = '';

      expect(() => requireEnv('HB_MOBILE_TEST_PROBE')).toThrow('HB_MOBILE_TEST_PROBE not set.');
    });
  });

  describe('shard helpers', () => {
    it('adbPortForShard throws naming HB_EMULATOR_ADB_PORT when it is unset', () => {
      delete process.env['HB_EMULATOR_ADB_PORT'];
      expect(() => adbPortForShard(0)).toThrow('HB_EMULATOR_ADB_PORT not set.');
    });

    it('adbPortForShard spaces shards by 2 from the configured base', () => {
      process.env['HB_EMULATOR_ADB_PORT'] = '5555';
      expect(adbPortForShard(0)).toBe(5555);
      expect(adbPortForShard(1)).toBe(5557);
      expect(adbPortForShard(2)).toBe(5559);
    });

    it('adbPortForShard honors HB_EMULATOR_ADB_PORT as the base (worktree-isolated)', () => {
      process.env['HB_EMULATOR_ADB_PORT'] = '6000';
      expect(adbPortForShard(0)).toBe(6000);
      expect(adbPortForShard(1)).toBe(6002);
    });

    it('adbPortForShard throws on non-numeric HB_EMULATOR_ADB_PORT', () => {
      process.env['HB_EMULATOR_ADB_PORT'] = 'not-a-number';
      expect(() => adbPortForShard(0)).toThrow('HB_EMULATOR_ADB_PORT');
    });

    it('adbPortForShard throws on zero or negative HB_EMULATOR_ADB_PORT', () => {
      process.env['HB_EMULATOR_ADB_PORT'] = '0';
      expect(() => adbPortForShard(0)).toThrow('HB_EMULATOR_ADB_PORT');
    });

    it('containerNameForShard uses the hushbox prefix', () => {
      expect(containerNameForShard(0)).toBe('hushbox-mobile-emulator-shard-0');
      expect(containerNameForShard(3)).toBe('hushbox-mobile-emulator-shard-3');
    });

    it('debugOutputForShard nests under maestro-results', () => {
      expect(debugOutputForShard(0)).toBe('maestro-results/shard-0');
      expect(debugOutputForShard(2)).toBe('maestro-results/shard-2');
    });
  });

  describe('flowWeight', () => {
    it('counts top-level steps after the --- separator', () => {
      const yaml = [
        'appId: x',
        'name: n',
        'tags:',
        '  - smoke',
        '---',
        '- launchApp:',
        '    clearState: true',
        '- back',
        '- assertVisible: Hi',
      ].join('\n');
      expect(flowWeight(yaml)).toBe(3);
    });

    it('adds weight for literal inputText characters', () => {
      const yaml = ['---', "- inputText: 'TestKeys'"].join('\n');
      expect(flowWeight(yaml)).toBe(1 + 8 * INPUT_CHAR_WEIGHT);
    });

    it('resolves ${VAR} inputText against the flow env block', () => {
      const yaml = ['env:', '  TEST_USERNAME: tmu', '---', '- inputText: ${TEST_USERNAME}'].join(
        '\n'
      );
      expect(flowWeight(yaml)).toBe(1 + 3 * INPUT_CHAR_WEIGHT);
    });

    it('falls back to the token length when a var is unresolved', () => {
      const yaml = ['---', '- inputText: ${MISSING}'].join('\n');
      expect(flowWeight(yaml)).toBe(1 + '${MISSING}'.length * INPUT_CHAR_WEIGHT);
    });

    it('returns 0 for content with no step separator', () => {
      expect(flowWeight('name: just a name\n')).toBe(0);
    });
  });

  describe('partitionByWeight', () => {
    it('balances total weight while keeping equal counts', () => {
      const w = (f: string): number => ({ a: 10, b: 1, c: 9, d: 2 })[f] ?? 0;
      // heaviest-first a(10),c(9),d(2),b(1); caps [2,2] → loads 11/11
      expect(partitionByWeight(['a', 'b', 'c', 'd'], 2, w)).toEqual([
        ['a', 'b'],
        ['c', 'd'],
      ]);
    });

    it('honors the count cap even when one shard is far heavier', () => {
      const w = (f: string): number => ({ a: 100, b: 1, c: 1, d: 1 })[f] ?? 0;
      const result = partitionByWeight(['a', 'b', 'c', 'd'], 2, w);
      expect(result.map((s) => s.length)).toEqual([2, 2]);
    });

    it('produces n buckets even when n > flows', () => {
      expect(partitionByWeight(['a', 'b'], 4, () => 1)).toEqual([['a'], ['b'], [], []]);
    });

    it('returns one bucket for n=1', () => {
      expect(partitionByWeight(['a', 'b', 'c'], 1, () => 1)).toEqual([['a', 'b', 'c']]);
    });

    it('returns n empty buckets for empty flows', () => {
      expect(partitionByWeight([], 3, () => 1)).toEqual([[], [], []]);
    });
  });

  describe('listFlowsForRun', () => {
    it('returns smoke subset when smoke=true', () => {
      const flows = listFlowsForRun(true);
      expect(flows).toEqual([
        'mobile-tests/flows/01-app-launch.yaml',
        'mobile-tests/flows/02-splash-screen.yaml',
        'mobile-tests/flows/03-webview-renders.yaml',
      ]);
    });

    it('excludes OTA flow from full run', () => {
      const flows = listFlowsForRun(false);
      expect(flows).not.toContain('mobile-tests/flows/13-ota-update.yaml');
      expect(flows).toContain('mobile-tests/flows/01-app-launch.yaml');
    });
  });

  describe('parseFailedFlowNames', () => {
    it('extracts failed flow names from maestro output', () => {
      const output = [
        '[Passed] App launches without crashing (10s)',
        '[Failed] Keyboard appears and input remains visible (33s) (Assertion is false: "Sign up" is visible)',
        '[Passed] Push notification permission dialog appears (7s)',
      ].join('\n');

      expect(parseFailedFlowNames(output)).toEqual(['Keyboard appears and input remains visible']);
    });

    it('returns empty array when no failures', () => {
      const output = '[Passed] App launches without crashing (10s)\n[Passed] Another flow (5s)';
      expect(parseFailedFlowNames(output)).toEqual([]);
    });

    it('extracts multiple failed flow names', () => {
      const output = [
        '[Failed] Flow A (10s) (some reason)',
        '[Passed] Flow B (5s)',
        '[Failed] Flow C (20s) (another reason)',
      ].join('\n');

      expect(parseFailedFlowNames(output)).toEqual(['Flow A', 'Flow C']);
    });

    it('extracts failed flow names with multi-minute durations', () => {
      const output = [
        '[Passed] App launches without crashing (13s)',
        '[Failed] Keyboard appears and input remains visible (2m 32s)',
        '[Passed] Message list scrolls correctly (50s)',
      ].join('\n');

      expect(parseFailedFlowNames(output)).toEqual(['Keyboard appears and input remains visible']);
    });
  });

  describe('assertLinux', () => {
    it('does not throw on linux', async () => {
      const { assertLinux } = await import('./mobile-test.js');
      const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      try {
        expect(() => {
          assertLinux();
        }).not.toThrow();
      } finally {
        spy.mockRestore();
      }
    });

    it('throws on darwin with a clear message', async () => {
      const { assertLinux } = await import('./mobile-test.js');
      const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
      try {
        expect(() => {
          assertLinux();
        }).toThrow(/Linux-only/);
      } finally {
        spy.mockRestore();
      }
    });

    it('throws on win32 with a clear message', async () => {
      const { assertLinux } = await import('./mobile-test.js');
      const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      try {
        expect(() => {
          assertLinux();
        }).toThrow(/Linux-only/);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('checkPrerequisites', () => {
    it('calls docker info to check Docker is running', async () => {
      await checkPrerequisites();

      expect(mockExeca).toHaveBeenCalledWith('docker', ['info'], { stdio: 'ignore' });
    });

    it('throws when Docker is not running', async () => {
      mockExeca.mockRejectedValueOnce(new Error('Docker not running'));

      await expect(checkPrerequisites()).rejects.toThrow('Docker is not running');
    });

    it('checks /dev/kvm exists', async () => {
      await checkPrerequisites();

      expect(mockExistsSync).toHaveBeenCalledWith('/dev/kvm');
    });

    it('throws when /dev/kvm is not found', async () => {
      mockExistsSync.mockReturnValue(false);

      await expect(checkPrerequisites()).rejects.toThrow('/dev/kvm not found');
    });
  });

  describe('installMaestro', () => {
    it('checks if maestro is already installed', async () => {
      await installMaestro();

      expect(mockExeca).toHaveBeenCalledWith('maestro', ['--version'], { stdio: 'ignore' });
    });

    it('installs maestro when not found', async () => {
      mockExeca.mockRejectedValueOnce(new Error('not found'));
      mockExeca.mockResolvedValueOnce({} as never);

      await installMaestro();

      expect(mockExeca).toHaveBeenCalledWith(
        'bash',
        ['-c', 'curl -fsSL "https://get.maestro.mobile.dev" | bash'],
        { stdio: 'inherit' }
      );
    });

    it('does not install when maestro is already available', async () => {
      await installMaestro();

      expect(mockExeca).toHaveBeenCalledTimes(1);
    });

    it('throws when HOME is not set during install', async () => {
      const savedHome = process.env['HOME'];
      delete process.env['HOME'];
      mockExeca.mockRejectedValueOnce(new Error('not found'));
      mockExeca.mockResolvedValueOnce({} as never);

      try {
        await expect(installMaestro()).rejects.toThrow('HOME not set');
      } finally {
        if (savedHome === undefined) delete process.env['HOME'];
        else process.env['HOME'] = savedHome;
      }
    });

    it('throws when PATH is not set during install', async () => {
      const savedPath = process.env['PATH'];
      delete process.env['PATH'];
      mockExeca.mockRejectedValueOnce(new Error('not found'));
      mockExeca.mockResolvedValueOnce({} as never);

      try {
        await expect(installMaestro()).rejects.toThrow('PATH not set');
      } finally {
        if (savedPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = savedPath;
      }
    });
  });

  describe('installAndroidSdk', () => {
    let savedPath: string | undefined;

    beforeEach(() => {
      savedPath = process.env['PATH'];
    });

    afterEach(() => {
      delete process.env['ANDROID_HOME'];
      process.env['PATH'] = savedPath;
    });

    it('skips install when ANDROID_HOME is set and platform exists', async () => {
      process.env['ANDROID_HOME'] = '/opt/android-sdk';
      mockExistsSync.mockReturnValue(true);

      await installAndroidSdk();

      const curlCalls = mockExeca.mock.calls.filter((c) => c[0] === 'curl');
      expect(curlCalls).toHaveLength(0);
    });

    it('skips install when default SDK location has platform', async () => {
      delete process.env['ANDROID_HOME'];
      mockExistsSync.mockReturnValue(true);

      await installAndroidSdk();

      const curlCalls = mockExeca.mock.calls.filter((c) => c[0] === 'curl');
      expect(curlCalls).toHaveLength(0);
      expect(process.env['ANDROID_HOME']).toContain('Android/Sdk');
    });

    it('installs SDK when not found', async () => {
      delete process.env['ANDROID_HOME'];
      mockExistsSync.mockImplementation(((p: string) => !p.includes('android-36')) as never);

      await installAndroidSdk();

      expect(mockExeca).toHaveBeenCalledWith(
        'curl',
        expect.arrayContaining(['-o', '/tmp/cmdline-tools.zip']), // eslint-disable-line sonarjs/publicly-writable-directories -- /tmp is standard for CI SDK downloads
        expect.objectContaining({ stdio: 'inherit' })
      );
      expect(mockExeca).toHaveBeenCalledWith(
        'unzip',
        expect.arrayContaining(['/tmp/cmdline-tools.zip']), // eslint-disable-line sonarjs/publicly-writable-directories -- /tmp is standard for CI SDK downloads
        expect.objectContaining({ stdio: 'inherit' })
      );
      expect(process.env['ANDROID_HOME']).toContain('Android/Sdk');
    });

    it('accepts licenses and installs platform', async () => {
      delete process.env['ANDROID_HOME'];
      mockExistsSync.mockImplementation(((p: string) => !p.includes('android-36')) as never);

      await installAndroidSdk();

      expect(mockExeca).toHaveBeenCalledWith(
        'bash',
        ['-c', expect.stringContaining('--licenses')],
        expect.objectContaining({ stdio: 'pipe' })
      );
      expect(mockExeca).toHaveBeenCalledWith(
        expect.stringContaining('sdkmanager'),
        expect.arrayContaining(['platforms;android-36', 'platform-tools']),
        expect.objectContaining({ stdio: 'inherit' })
      );
    });

    it('adds platform-tools to PATH when ANDROID_HOME is set', async () => {
      process.env['ANDROID_HOME'] = '/opt/android-sdk';
      mockExistsSync.mockReturnValue(true);

      await installAndroidSdk();

      expect(process.env['PATH']).toContain('/opt/android-sdk/platform-tools');
    });

    it('adds platform-tools to PATH when using default SDK location', async () => {
      delete process.env['ANDROID_HOME'];
      mockExistsSync.mockReturnValue(true);

      await installAndroidSdk();

      expect(process.env['PATH']).toContain('Android/Sdk/platform-tools');
    });

    it('adds platform-tools to PATH after fresh install', async () => {
      delete process.env['ANDROID_HOME'];
      mockExistsSync.mockImplementation(((p: string) => !p.includes('android-36')) as never);

      await installAndroidSdk();

      expect(process.env['PATH']).toContain('Android/Sdk/platform-tools');
    });

    it('throws when PATH is not set after fresh install', async () => {
      delete process.env['ANDROID_HOME'];
      delete process.env['PATH'];
      mockExistsSync.mockImplementation(((p: string) => !p.includes('android-36')) as never);

      await expect(installAndroidSdk()).rejects.toThrow('PATH not set');
    });

    it('throws when HOME is not set and ANDROID_HOME is missing', async () => {
      const savedHome = process.env['HOME'];
      delete process.env['ANDROID_HOME'];
      delete process.env['HOME'];
      mockExistsSync.mockReturnValue(true);

      try {
        await expect(installAndroidSdk()).rejects.toThrow('HOME not set');
      } finally {
        if (savedHome === undefined) delete process.env['HOME'];
        else process.env['HOME'] = savedHome;
      }
    });
  });

  describe('startEmulator', () => {
    const emulatorMock = ((cmd: string, args?: readonly string[]) => {
      const probe = bootReadinessMock(cmd, Array.isArray(args) ? args : []);
      if (probe) return Promise.resolve(probe as never);
      // Default for any other docker/adb call in this mock.
      return Promise.resolve({ stdout: '' } as never);
    }) as never;

    beforeEach(() => {
      process.env['HB_API_PORT'] = '8787';
    });

    afterEach(() => {
      delete process.env['HB_API_PORT'];
    });

    it('runs docker container with privileged mode and KVM device', async () => {
      mockExeca.mockImplementation(emulatorMock);

      await startEmulator(0, 'test-image', '993');

      expect(mockExeca).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining([
          'run',
          '-d',
          '--privileged',
          '--name',
          'hushbox-mobile-emulator-shard-0',
          '--device',
          '/dev/kvm',
          '--group-add',
          '993',
        ]),
        expect.objectContaining({ stdio: 'inherit' })
      );
    });

    it('maps shard 1 to ADB port 5557', async () => {
      mockExeca.mockImplementation(emulatorMock);

      await startEmulator(1, 'test-image', '993');

      expect(mockExeca).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['-p', '5557:5555']),
        expect.anything()
      );
    });

    it('connects adb to the shard-specific port', async () => {
      mockExeca.mockImplementation(emulatorMock);

      await startEmulator(0, 'test-image', '993');

      expect(mockExeca).toHaveBeenCalledWith('adb', ['connect', 'localhost:5555'], {
        stdio: 'pipe',
      });
    });

    it('polls for boot completion', async () => {
      let pollCount = 0;
      function sysBootCompletedResponse(): Promise<unknown> {
        pollCount++;
        if (pollCount < 3) return Promise.reject(new Error('not ready'));
        return Promise.resolve({ stdout: '1' });
      }
      function dispatchPollCall(cmd: string, args: readonly string[]): Promise<unknown> {
        if (cmd === 'docker' && args.includes('run')) {
          return Promise.resolve({ stdout: 'container-id' });
        }
        if (cmd === 'adb' && args.includes('getprop') && args.includes('sys.boot_completed')) {
          return sysBootCompletedResponse();
        }
        const probe = bootReadinessMock(cmd, args);
        if (probe) return Promise.resolve(probe);
        return Promise.resolve({ stdout: '' });
      }
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) =>
        dispatchPollCall(cmd, Array.isArray(args) ? args : [])) as never);

      await startEmulator(0, 'test-image', '993');

      expect(pollCount).toBe(3);
    });

    it('removes leftover container before starting fresh', async () => {
      mockExeca.mockImplementation(emulatorMock);

      await startEmulator(0, 'test-image', '993');

      expect(mockExeca).toHaveBeenCalledWith(
        'docker',
        ['rm', '-f', 'hushbox-mobile-emulator-shard-0'],
        expect.objectContaining({ stdio: 'ignore' })
      );
    });

    /**
     * Drives the boot poll loop with scripted per-call responses: `connects`
     * and `getprops` are consumed one entry per adb connect / getprop call;
     * the last entry repeats. A response can be an Error (or any thrown
     * value) to exercise the failure paths.
     */
    function scriptBootSequence(
      connects: unknown[],
      getprops: unknown[],
      options?: { failDisconnect?: boolean }
    ): void {
      let connectIndex = 0;
      let getpropIndex = 0;
      function next(script: unknown[], index: number): Promise<unknown> {
        const entry = script[Math.min(index, script.length - 1)];
        if (entry instanceof Error || typeof entry === 'string') {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- string rejections exercise extractErrorDetail's non-Error String(error) fallback
          return Promise.reject(entry);
        }
        return Promise.resolve(entry);
      }
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        const argumentList = Array.isArray(args) ? args : [];
        if (cmd === 'adb' && argumentList.includes('connect')) {
          return next(connects, connectIndex++);
        }
        if (cmd === 'adb' && argumentList.includes('getprop')) {
          return next(getprops, getpropIndex++);
        }
        if (cmd === 'adb' && argumentList[0] === 'disconnect' && options?.failDisconnect) {
          return Promise.reject(new Error('no such device'));
        }
        return Promise.resolve({ stdout: '' });
      }) as never);
    }

    it('clears a stale offline adb entry before reconnecting', async () => {
      scriptBootSequence(
        [
          { stdout: 'failed to connect: device offline' },
          { stdout: 'unable to connect' },
          { stdout: 'connected to localhost:5555' },
        ],
        [{ stdout: '1' }],
        // The stale entry's disconnect itself failing must not abort the poll.
        { failDisconnect: true }
      );

      await startEmulator(0, 'test-image', '993');

      expect(mockExeca).toHaveBeenCalledWith('adb', ['disconnect', 'localhost:5555'], {
        stdio: 'pipe',
      });
      expect(mockExeca).toHaveBeenCalledWith('adb', [
        '-s',
        'localhost:5555',
        'reverse',
        'tcp:8787',
        'tcp:8787',
      ]);
    }, 30_000);

    it('logs boot progress only at the diagnostic interval', async () => {
      const logSpy = vi.mocked(console.log);
      scriptBootSequence(
        [{ stdout: 'connected to localhost:5555' }],
        [{ stdout: '0' }, { stdout: '0' }, { stdout: '1' }]
      );

      await startEmulator(0, 'test-image', '993');

      const progressLogs = logSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("sys.boot_completed not yet '1'"));
      expect(progressLogs).toHaveLength(1);
    }, 30_000);

    it('reconnects when the device drops offline mid-boot', async () => {
      scriptBootSequence(
        [{ stdout: 'connected to localhost:5555' }],
        [
          Object.assign(new Error('adb failed'), { stderr: 'error: device offline' }),
          Object.assign(new Error('adb failed'), { stderr: 'error: device offline' }),
          Object.assign(new Error('adb failed'), { stderr: 'protocol fault' }),
          { stdout: '1' },
        ]
      );

      await startEmulator(0, 'test-image', '993');

      const disconnects = mockExeca.mock.calls.filter(
        (call) => call[0] === 'adb' && Array.isArray(call[1]) && call[1][0] === 'disconnect'
      );
      expect(disconnects).toHaveLength(2);
    }, 30_000);

    it('logs connection errors thrown by adb itself only at the diagnostic interval', async () => {
      const logSpy = vi.mocked(console.log);
      scriptBootSequence(
        ['socket hangup', 'socket hangup', { stdout: 'connected to localhost:5555' }],
        [{ stdout: '1' }]
      );

      await startEmulator(0, 'test-image', '993');

      const errorLogs = logSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('error: socket hangup'));
      expect(errorLogs).toHaveLength(1);
    }, 30_000);
  });

  describe('startEmulators', () => {
    beforeEach(() => {
      process.env['HB_API_PORT'] = '8787';
    });

    afterEach(() => {
      delete process.env['HB_API_PORT'];
    });

    it('starts n emulators in parallel with distinct container names', async () => {
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        const probe = bootReadinessMock(cmd, Array.isArray(args) ? args : []);
        if (probe) return Promise.resolve(probe as never);
        return Promise.resolve({ stdout: '' } as never);
      }) as never);

      await startEmulators(2, 'test-image');

      // detectKvmGid uses fs.stat directly (not execa) — verified by the
      // fact that docker run still fires N times, since startEmulator only
      // proceeds after gid resolution.
      const runCalls = mockExeca.mock.calls.filter(
        (c) => c[0] === 'docker' && Array.isArray(c[1]) && c[1].includes('run')
      );
      expect(runCalls).toHaveLength(2);
      const names = runCalls.map(
        (c) => (c[1] as string[])[(c[1] as string[]).indexOf('--name') + 1]
      );
      expect(names).toContain('hushbox-mobile-emulator-shard-0');
      expect(names).toContain('hushbox-mobile-emulator-shard-1');
    });

    it('propagates rejection when any shard fails to start', async () => {
      // Shard 0's docker run succeeds; shard 1's rejects. Promise.all rejects
      // immediately — the caller (main()) relies on this to break out of
      // boot-time work and trigger its finally-block cleanup.
      // We use a no-op setTimeout to skip the 2s boot-poll sleeps; without
      // it shard 0 hangs polling for ~4 minutes after shard 1 rejects.
      const originalSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((function_: () => void) => {
        function_();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;
      try {
        mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
          const argumentList = Array.isArray(args) ? args : [];
          if (
            cmd === 'docker' &&
            argumentList.includes('run') &&
            argumentList.includes('hushbox-mobile-emulator-shard-1')
          ) {
            return Promise.reject(new Error('docker run failed for shard 1'));
          }
          if (cmd === 'adb' && argumentList.includes('connect')) {
            return Promise.resolve({ stdout: 'connected to localhost:5555' } as never);
          }
          if (cmd === 'adb' && argumentList.includes('getprop')) {
            return Promise.resolve({ stdout: '1' } as never);
          }
          return Promise.resolve({ stdout: '' } as never);
        }) as never);

        await expect(startEmulators(2, 'test-image')).rejects.toThrow(/shard 1/);
      } finally {
        globalThis.setTimeout = originalSetTimeout;
      }
    });
  });

  describe('startDevApi', () => {
    it('reuses an existing healthy API and returns null apiProcess', async () => {
      process.env['HB_API_PORT'] = '8787';
      try {
        const handle = await startDevApi();
        expect(mockExeca).toHaveBeenCalledWith('curl', ['-sf', 'http://localhost:8787/health'], {
          stdio: 'ignore',
        });
        expect(handle.apiProcess).toBeNull();
        const apiDevCalls = mockExeca.mock.calls.filter(
          (call) =>
            call[0] === 'pnpm' &&
            Array.isArray(call[1]) &&
            call[1].includes('--filter') &&
            call[1].includes('@hushbox/api')
        );
        expect(apiDevCalls).toHaveLength(0);
      } finally {
        delete process.env['HB_API_PORT'];
      }
    });

    it('spawns wrangler dev as a background subprocess when API is not ready', async () => {
      process.env['HB_API_PORT'] = '8787';
      let healthCheckCount = 0;
      mockExeca.mockImplementation(((cmd: string, _args?: readonly string[]) => {
        if (cmd === 'curl') {
          healthCheckCount++;
          if (healthCheckCount === 1) return Promise.reject(new Error('not running'));
          return mockSubprocess();
        }
        return mockSubprocess();
      }) as never);
      try {
        const handle = await startDevApi();
        expect(handle.apiProcess).not.toBeNull();
        expect(mockExeca).toHaveBeenCalledWith(
          'pnpm',
          ['--filter', '@hushbox/api', 'dev'],
          expect.objectContaining({ stdio: 'ignore' })
        );
      } finally {
        delete process.env['HB_API_PORT'];
      }
    });

    it('does not crash when the spawned dev subprocess dies immediately', async () => {
      process.env['HB_API_PORT'] = '8787';
      let healthCheckCount = 0;
      function deadSubprocess(): never {
        const rejected = Promise.reject(new Error('wrangler crashed'));
        return Object.assign(rejected, { unref: vi.fn(), kill: vi.fn() }) as never;
      }
      mockExeca.mockImplementation(((cmd: string) => {
        if (cmd === 'curl') {
          healthCheckCount++;
          if (healthCheckCount === 1) return Promise.reject(new Error('not running'));
          return mockSubprocess();
        }
        return deadSubprocess();
      }) as never);

      try {
        const handle = await startDevApi();

        expect(handle.apiProcess).not.toBeNull();
      } finally {
        delete process.env['HB_API_PORT'];
      }
    });

    it('throws when HB_API_PORT is not set', async () => {
      delete process.env['HB_API_PORT'];

      await expect(startDevApi()).rejects.toThrow('HB_API_PORT not set');
    });

    it('throws when the API never becomes ready', async () => {
      process.env['HB_API_PORT'] = '8787';
      const originalSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((function_: () => void) => {
        function_();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;
      try {
        mockExeca.mockImplementation(((cmd: string) => {
          if (cmd === 'curl') return Promise.reject(new Error('API never ready'));
          return mockSubprocess();
        }) as never);
        await expect(startDevApi()).rejects.toThrow(/failed to start within timeout/);
      } finally {
        globalThis.setTimeout = originalSetTimeout;
        delete process.env['HB_API_PORT'];
      }
    });
  });

  describe('stopDevApi', () => {
    it('is a no-op when apiProcess is null', async () => {
      await expect(stopDevApi({ apiProcess: null })).resolves.toBeUndefined();
    });

    it('kills the apiProcess when present', async () => {
      const fakeProcess = mockSubprocess() as unknown as ReturnType<typeof execa>;
      await stopDevApi({ apiProcess: fakeProcess });
      expect((fakeProcess as unknown as { kill: () => void }).kill).toHaveBeenCalled();
    });

    it('does not throw when kill itself fails (best-effort cleanup)', async () => {
      const fakeProcess = {
        kill: vi.fn(() => {
          throw new Error('already exited');
        }),
      } as unknown as ReturnType<typeof execa>;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(stopDevApi({ apiProcess: fakeProcess })).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to stop API server'));
    });

    it('stringifies non-Error failures from kill', async () => {
      const fakeProcess = {
        kill: vi.fn(() => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercises the non-Error branch of the kill recovery
          throw 'ESRCH';
        }),
      } as unknown as ReturnType<typeof execa>;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(stopDevApi({ apiProcess: fakeProcess })).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ESRCH'));
    });
  });

  describe('withMobileTestRun', () => {
    beforeEach(() => {
      process.env['HB_API_PORT'] = '8915';
    });
    afterEach(() => {
      delete process.env['HB_API_PORT'];
    });

    it('writes START marker before body executes', async () => {
      const calls: string[] = [];
      mockAppendFileSync.mockImplementation((_path, data) => {
        calls.push(String(data));
      });

      const body = vi.fn(() => {
        // Inspect at body-entry: START should already be written, END not yet
        expect(calls.some((c) => c.includes(`${MARKER_PREFIX} run-1 START`))).toBe(true);
        expect(calls.some((c) => c.includes(`${MARKER_PREFIX} run-1 END`))).toBe(false);
        return Promise.resolve();
      });

      await withMobileTestRun('run-1', body);
      expect(body).toHaveBeenCalledOnce();
    });

    it('writes END marker after body resolves', async () => {
      const calls: string[] = [];
      mockAppendFileSync.mockImplementation((_path, data) => {
        calls.push(String(data));
      });

      await withMobileTestRun('run-2', async () => {});

      expect(calls.some((c) => c.includes(`${MARKER_PREFIX} run-2 START`))).toBe(true);
      expect(calls.some((c) => c.includes(`${MARKER_PREFIX} run-2 END`))).toBe(true);
    });

    it('writes END marker even when body throws', async () => {
      const calls: string[] = [];
      mockAppendFileSync.mockImplementation((_path, data) => {
        calls.push(String(data));
      });

      await expect(
        withMobileTestRun('run-3', () => Promise.reject(new Error('body failed')))
      ).rejects.toThrow('body failed');

      expect(calls.some((c) => c.includes(`${MARKER_PREFIX} run-3 END`))).toBe(true);
    });

    it('writes both markers to apps/api/.wrangler-<port>.log', async () => {
      const paths: string[] = [];
      mockAppendFileSync.mockImplementation((path) => {
        paths.push(String(path));
      });

      await withMobileTestRun('run-4', async () => {});

      expect(paths.every((p) => p.endsWith('apps/api/.wrangler-8915.log'))).toBe(true);
      expect(paths).toHaveLength(2);
    });

    it('throws when HB_API_PORT is not set', async () => {
      delete process.env['HB_API_PORT'];

      await expect(withMobileTestRun('run-6', async () => {})).rejects.toThrow(
        'HB_API_PORT not set'
      );
    });
  });

  describe('writeApiSlice', () => {
    beforeEach(() => {
      process.env['HB_API_PORT'] = '8915';
    });
    afterEach(() => {
      delete process.env['HB_API_PORT'];
    });

    it('extracts the slice and writes it to maestro-results/api-during-mobile-test.log', () => {
      const runId = 'run-5';
      // The request-log middleware emits one structured JSON line per request
      // (no app-version field). The slice keeps those lines and the run markers
      // inside the START/END window and drops surrounding wrangler noise.
      const reqLine = (route: string): string =>
        JSON.stringify({
          level: 'info',
          msg: 'request completed',
          method: 'POST',
          route,
          statusCode: 200,
          latencyMs: 100,
        });
      const raw = [
        '[wrangler:info] before',
        `${MARKER_PREFIX} ${runId} START 2026-05-26T03:00:00.000Z =====`,
        reqLine('/api/auth/login/init'),
        reqLine('/api/conversations'),
        `${MARKER_PREFIX} ${runId} END 2026-05-26T03:01:00.000Z =====`,
        '[wrangler:info] after',
      ].join('\n');

      mockReadFileSync.mockImplementationOnce(() => raw);

      writeApiSlice(runId);

      const writeCall = mockWriteFileSync.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].endsWith('api-during-mobile-test.log')
      );
      expect(writeCall).toBeDefined();
      const sliceContent = writeCall?.[1] as string;
      expect(sliceContent).toContain('/api/auth/login/init');
      expect(sliceContent).toContain('/api/conversations');
      expect(sliceContent).not.toContain('before');
      expect(sliceContent).not.toContain('after');
    });

    it('writes the slice at the documented API_SLICE_PATH constant', () => {
      mockReadFileSync.mockImplementationOnce(() => '');

      writeApiSlice('any-run-id');

      const calls = mockWriteFileSync.mock.calls;
      const target = calls.find(
        (call) => typeof call[0] === 'string' && call[0] === API_SLICE_PATH
      );
      expect(target).toBeDefined();
    });

    it('throws when HB_API_PORT is not set', () => {
      delete process.env['HB_API_PORT'];

      expect(() => {
        writeApiSlice('any-run-id');
      }).toThrow('HB_API_PORT not set');
    });
  });

  describe('resetVersionOverride', () => {
    beforeEach(() => {
      process.env['HB_API_PORT'] = '8787';
    });

    afterEach(() => {
      delete process.env['HB_API_PORT'];
      vi.unstubAllGlobals();
    });

    it('posts the APK version to the dev endpoint on HB_API_PORT', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      await resetVersionOverride();

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:8787/dev/set-version', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: APK_APP_VERSION }),
      });
    });

    it('throws when HB_API_PORT is not set', async () => {
      delete process.env['HB_API_PORT'];

      await expect(resetVersionOverride()).rejects.toThrow('HB_API_PORT not set');
    });

    it('throws when the dev endpoint rejects the override', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

      await expect(resetVersionOverride()).rejects.toThrow(
        'Failed to reset version override: HTTP 500'
      );
    });
  });

  describe('dumpApiLogTail', () => {
    it('echoes the last N lines of the slice file to the process stdout', () => {
      const sliceContent = Array.from({ length: 250 }, (_, index) => `line ${String(index)}`).join(
        '\n'
      );
      mockReadFileSync.mockImplementationOnce((file) => {
        if (String(file).endsWith('api-during-mobile-test.log')) return sliceContent;
        return '';
      });
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      try {
        dumpApiLogTail(50);

        const written = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
        expect(written).toContain('=== last 50 lines of API log');
        expect(written).toContain('line 249');
        expect(written).not.toContain('line 199');
      } finally {
        stdoutSpy.mockRestore();
      }
    });

    it('emits a one-line notice when the slice file is empty', () => {
      mockReadFileSync.mockImplementationOnce(() => '');
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      try {
        dumpApiLogTail(50);

        const written = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
        expect(written).toContain('API log slice is empty');
      } finally {
        stdoutSpy.mockRestore();
      }
    });
  });

  describe('buildApk', () => {
    beforeEach(() => {
      process.env['API_URL'] = 'http://localhost:8787';
      process.env['FRONTEND_URL'] = 'http://localhost:5173';
    });

    afterEach(() => {
      delete process.env['API_URL'];
      delete process.env['FRONTEND_URL'];
    });

    it('builds web with env vars derived from process.env', async () => {
      await buildApk();

      expect(mockExeca).toHaveBeenCalledWith(
        'pnpm',
        ['--filter', 'web', 'build'],
        expect.objectContaining({
          stdio: 'inherit',
          env: expect.objectContaining({
            VITE_API_URL: 'http://localhost:8787',
            VITE_PLATFORM: 'android-direct',
            VITE_APP_VERSION: 'local-mobile-test',
            VITE_OPAQUE_SERVER_ID: 'localhost:5173',
          }),
        })
      );
    });

    it('throws when API_URL is not set', async () => {
      delete process.env['API_URL'];

      await expect(buildApk()).rejects.toThrow('API_URL not set');
    });

    it('throws when FRONTEND_URL is not set', async () => {
      delete process.env['FRONTEND_URL'];

      await expect(buildApk()).rejects.toThrow('FRONTEND_URL not set');
    });

    it('syncs capacitor', async () => {
      await buildApk();

      expect(mockExeca).toHaveBeenCalledWith('npx', ['cap', 'sync', 'android'], {
        stdio: 'inherit',
        cwd: 'apps/web',
        env: process.env,
      });
    });

    it('writes google-services.json from base64 env var when missing', async () => {
      const jsonContent = '{"project_info":{"project_id":"test"}}';
      process.env['GOOGLE_SERVICES_JSON_BASE64'] = Buffer.from(jsonContent).toString('base64');
      mockExistsSync.mockImplementation(
        ((p: string) => p !== 'apps/web/android/app/google-services.json') as never
      );

      await buildApk();

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        'apps/web/android/app/google-services.json',
        jsonContent
      );

      delete process.env['GOOGLE_SERVICES_JSON_BASE64'];
    });

    it('skips writing google-services.json when file already exists', async () => {
      mockExistsSync.mockReturnValue(true);

      await buildApk();

      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('throws when google-services.json is missing and env var is not set', async () => {
      delete process.env['GOOGLE_SERVICES_JSON_BASE64'];
      mockExistsSync.mockImplementation(
        ((p: string) => p !== 'apps/web/android/app/google-services.json') as never
      );

      await expect(buildApk()).rejects.toThrow('GOOGLE_SERVICES_JSON_BASE64');
    });

    it('runs gradle clean assembleDebug with version and keystore env vars', async () => {
      await buildApk();

      expect(mockExeca).toHaveBeenCalledWith('./gradlew', ['clean', 'assembleDebug'], {
        stdio: 'inherit',
        cwd: 'apps/web/android',
        env: expect.objectContaining({
          VERSION_CODE: '1',
          VERSION_NAME: 'local-mobile-test',
          ANDROID_KEYSTORE_PATH: 'debug.keystore',
          ANDROID_KEYSTORE_PASSWORD: 'debug',
          ANDROID_KEY_ALIAS: 'debug',
          ANDROID_KEY_PASSWORD: 'debug',
        }),
      });
    });
  });

  describe('installApk', () => {
    it('installs APK via adb on the shard-specific port', async () => {
      await installApk(1);

      expect(mockExeca).toHaveBeenCalledWith(
        'adb',
        [
          '-s',
          'localhost:5557',
          'install',
          '-r',
          'apps/web/android/app/build/outputs/apk/debug/app-debug.apk',
        ],
        { stdio: 'inherit' }
      );
    });
  });

  describe('installApks', () => {
    it('installs APK on all n shards', async () => {
      await installApks(2);

      const installCalls = mockExeca.mock.calls.filter(
        (c) => c[0] === 'adb' && Array.isArray(c[1]) && c[1].includes('install')
      );
      expect(installCalls).toHaveLength(2);
      const targetHosts = installCalls.map((c) => (c[1] as string[])[1]);
      expect(targetHosts).toContain('localhost:5555');
      expect(targetHosts).toContain('localhost:5557');
    });
  });

  describe('configureAppLinks', () => {
    it('targets the shard-specific adb host', async () => {
      await configureAppLinks(1);

      expect(mockExeca).toHaveBeenCalledWith(
        'adb',
        expect.arrayContaining(['-s', 'localhost:5557', 'shell', 'pm', 'set-app-links-allowed']),
        expect.objectContaining({ stdio: 'inherit' })
      );
    });
  });

  describe('configureAllAppLinks', () => {
    it('configures app links on all n shards', async () => {
      await configureAllAppLinks(2);

      const setAppLinksCalls = mockExeca.mock.calls.filter(
        (c) => c[0] === 'adb' && Array.isArray(c[1]) && c[1].includes('set-app-links-allowed')
      );
      expect(setAppLinksCalls).toHaveLength(2);
    });
  });

  describe('stopEmulator', () => {
    it('removes the shard container with docker rm -f', async () => {
      await stopEmulator(0);

      expect(mockExeca).toHaveBeenCalledWith(
        'docker',
        ['rm', '-f', 'hushbox-mobile-emulator-shard-0'],
        { stdio: 'inherit' }
      );
    });

    it('targets the shard-specific container name', async () => {
      await stopEmulator(1);

      expect(mockExeca).toHaveBeenCalledWith(
        'docker',
        ['rm', '-f', 'hushbox-mobile-emulator-shard-1'],
        { stdio: 'inherit' }
      );
    });

    it('does not throw when docker rm fails', async () => {
      mockExeca.mockRejectedValueOnce(new Error('container not found'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(stopEmulator(0)).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to stop emulator'));
    });

    it('stringifies non-Error failures from docker rm', async () => {
      mockExeca.mockRejectedValueOnce('daemon unreachable' as never);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(stopEmulator(0)).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('daemon unreachable'));
    });
  });

  describe('stopEmulators', () => {
    it('stops all n shards in parallel', async () => {
      await stopEmulators(2);

      const rmCalls = mockExeca.mock.calls.filter(
        (c) =>
          c[0] === 'docker' &&
          Array.isArray(c[1]) &&
          c[1][0] === 'rm' &&
          (c[1][2] === 'hushbox-mobile-emulator-shard-0' ||
            c[1][2] === 'hushbox-mobile-emulator-shard-1')
      );
      expect(rmCalls).toHaveLength(2);
    });
  });

  describe('runMaestroShards', () => {
    beforeEach(() => {
      process.env['HB_API_PORT'] = '8787';
    });

    afterEach(() => {
      delete process.env['HB_API_PORT'];
    });

    it('kills adb server to clear ghost devices', async () => {
      await runMaestroShards(false, 2);

      expect(mockExeca).toHaveBeenCalledWith('adb', ['kill-server']);
    });

    it('restarts adb server with emulator scanning disabled', async () => {
      await runMaestroShards(false, 2);

      expect(mockExeca).toHaveBeenCalledWith('adb', ['start-server'], {
        env: expect.objectContaining({ ADB_LOCAL_TRANSPORT_MAX_PORT: '0' }),
      });
    });

    it('connects adb to each shard after server restart', async () => {
      await runMaestroShards(false, 2);

      expect(mockExeca).toHaveBeenCalledWith('adb', ['connect', 'localhost:5555']);
      expect(mockExeca).toHaveBeenCalledWith('adb', ['connect', 'localhost:5557']);
    });

    it('re-establishes adb reverse for API port on each shard', async () => {
      process.env['HB_API_PORT'] = '9999';

      await runMaestroShards(false, 2);

      expect(mockExeca).toHaveBeenCalledWith('adb', [
        '-s',
        'localhost:5555',
        'reverse',
        'tcp:9999',
        'tcp:9999',
      ]);
      expect(mockExeca).toHaveBeenCalledWith('adb', [
        '-s',
        'localhost:5557',
        'reverse',
        'tcp:9999',
        'tcp:9999',
      ]);
    });

    it('runs maestro on each shard with disjoint flow partitions', async () => {
      mockExeca.mockImplementation(((cmd: string) => {
        if (cmd === 'maestro') return mockSubprocess({ exitCode: 0, stdout: '' });
        return mockSubprocess();
      }) as never);

      await runMaestroShards(false, 2);

      const maestroCalls = mockExeca.mock.calls.filter(
        (c) => c[0] === 'maestro' && Array.isArray(c[1]) && c[1].includes('test')
      );
      expect(maestroCalls).toHaveLength(2);

      const allFlows = maestroCalls.flatMap((c) =>
        (c[1] as string[]).filter((argument) => argument.endsWith('.yaml'))
      );
      // OTA excluded; smoke vs non-smoke handled by listFlowsForRun
      expect(allFlows).not.toContain('mobile-tests/flows/13-ota-update.yaml');
      // Each flow appears exactly once across all shards (weight-balanced partition)
      const flowCounts = new Map<string, number>();
      for (const flow of allFlows) {
        flowCounts.set(flow, (flowCounts.get(flow) ?? 0) + 1);
      }
      for (const count of flowCounts.values()) {
        expect(count).toBe(1);
      }
    });

    it('continues when adb kill-server fails because no server is running', async () => {
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        if (cmd === 'adb' && Array.isArray(args) && args[0] === 'kill-server') {
          return Promise.reject(new Error('server not running'));
        }
        if (cmd === 'maestro') return mockSubprocess({ exitCode: 0, stdout: '' });
        return mockSubprocess();
      }) as never);

      await runMaestroShards(false, 1);

      expect(mockExeca).toHaveBeenCalledWith('adb', ['start-server'], expect.anything());
    });

    it('throws when HB_API_PORT is not set', async () => {
      delete process.env['HB_API_PORT'];

      await expect(runMaestroShards(false, 1)).rejects.toThrow('HB_API_PORT not set');
    });

    it('treats a maestro result without an exit code as a failure', async () => {
      mockExeca.mockImplementation(((cmd: string) => {
        if (cmd === 'maestro') return mockSubprocess({ stdout: '' });
        return mockSubprocess();
      }) as never);

      await expect(runMaestroShards(false, 1)).rejects.toThrow(
        'Maestro tests failed without identifiable flow failures'
      );
    });

    it('runs only smoke flows when smoke is true', async () => {
      mockExeca.mockImplementation(((cmd: string) => {
        if (cmd === 'maestro') return mockSubprocess({ exitCode: 0, stdout: '' });
        return mockSubprocess();
      }) as never);

      await runMaestroShards(true, 2);

      const maestroCalls = mockExeca.mock.calls.filter(
        (c) => c[0] === 'maestro' && Array.isArray(c[1]) && c[1].includes('test')
      );
      const allFlows = maestroCalls.flatMap((c) =>
        (c[1] as string[]).filter((argument) => argument.endsWith('.yaml'))
      );
      expect(allFlows).toContain('mobile-tests/flows/01-app-launch.yaml');
      expect(allFlows).toContain('mobile-tests/flows/02-splash-screen.yaml');
      expect(allFlows).toContain('mobile-tests/flows/03-webview-renders.yaml');
      // Smoke is 3 flows, n=2: counts split 2/1 across shards.
      expect(allFlows).toHaveLength(3);
    });

    it('retries failed flows on shard 0', async () => {
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        if (cmd === 'maestro' && Array.isArray(args) && args.includes('test')) {
          // First two are the per-shard runs; one of them returns a failure
          return mockSubprocess({
            exitCode: 1,
            stdout: '[Failed] App launches without crashing (10s) (some reason)',
          });
        }
        return mockSubprocess();
      }) as never);

      await runMaestroShards(false, 2);

      const maestroTestCalls = mockExeca.mock.calls.filter(
        (c) => c[0] === 'maestro' && Array.isArray(c[1]) && c[1].includes('test')
      );
      // 2 shard runs + 1 retry pass = 3 maestro test invocations
      expect(maestroTestCalls.length).toBeGreaterThanOrEqual(3);
      // Retry targets shard 0's host
      const retry = maestroTestCalls.at(-1)!;
      expect(retry[1] as string[]).toContain('localhost:5555');
    });

    it('re-connects adb to the retry shard before the retry maestro invocation', async () => {
      // Per-shard maestro processes can disturb the host adb server's device
      // table on exit (see maestro#2167), which makes the retry fail with
      // "Device localhost:PORT not connected". The retry path must
      // idempotently re-establish the connection before invoking maestro.
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        if (cmd === 'maestro' && Array.isArray(args) && args.includes('test')) {
          return mockSubprocess({
            exitCode: 1,
            stdout: '[Failed] App launches without crashing (10s) (some reason)',
          });
        }
        return mockSubprocess();
      }) as never);

      await runMaestroShards(false, 2);

      // Find the index of the final (retry) maestro test call.
      const callOrder = mockExeca.mock.calls.map((c, index) => ({
        index,
        cmd: c[0] as string,
        args: Array.isArray(c[1]) ? (c[1] as string[]) : [],
      }));
      const retryIndex = callOrder.findLast(
        (c) => c.cmd === 'maestro' && c.args.includes('test')
      )!.index;

      // adb connect localhost:5555 + wait-for-device must appear after the
      // per-shard runs settle and before the retry maestro fires.
      const reconnectIndex = callOrder.findIndex(
        (c, index) =>
          index < retryIndex &&
          c.cmd === 'adb' &&
          c.args[0] === 'connect' &&
          c.args[1] === 'localhost:5555' &&
          // Restrict to the LAST adb connect localhost:5555 before retry —
          // prepareAdbServer's earlier connect doesn't count.
          callOrder
            .slice(index + 1, retryIndex)
            .every((later) => !(later.cmd === 'adb' && later.args[0] === 'connect'))
      );
      expect(reconnectIndex).toBeGreaterThan(-1);

      const waitForDeviceIndex = callOrder.findIndex(
        (c, index) =>
          index > reconnectIndex &&
          index < retryIndex &&
          c.cmd === 'adb' &&
          c.args.includes('wait-for-device') &&
          c.args.includes('localhost:5555')
      );
      expect(waitForDeviceIndex).toBeGreaterThan(reconnectIndex);
    });

    it('skips empty shards (no maestro invocation, no failures)', async () => {
      // Round-robin 1 flow across 2 shards puts the flow in shard 0; shard 1
      // has nothing to do. The script must not invoke maestro for shard 1 and
      // must not treat its (empty) stdout as a missing-failure error.
      mockExeca.mockImplementation(((cmd: string) => {
        if (cmd === 'maestro') return mockSubprocess({ exitCode: 0, stdout: '' });
        return mockSubprocess();
      }) as never);

      await runMaestroShards(true, 4);

      const maestroCalls = mockExeca.mock.calls.filter(
        (c) => c[0] === 'maestro' && Array.isArray(c[1]) && c[1].includes('test')
      );
      // smoke = 3 flows, n = 4: shards 0,1,2 each get 1 flow; shard 3 is empty
      expect(maestroCalls).toHaveLength(3);
    });

    it('throws when shard fails without identifiable flow failures', async () => {
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        if (cmd === 'maestro' && Array.isArray(args) && args.includes('test')) {
          return mockSubprocess({ exitCode: 1, stdout: 'unparseable output' });
        }
        return mockSubprocess();
      }) as never);

      await expect(runMaestroShards(false, 2)).rejects.toThrow(/without identifiable/);
    });
  });

  describe('main', () => {
    let savedPath: string | undefined;

    beforeEach(() => {
      savedPath = process.env['PATH'];
      process.env['HB_API_PORT'] = '8787';
      process.env['API_URL'] = 'http://localhost:8787';
      process.env['FRONTEND_URL'] = 'http://localhost:5173';

      function dispatchMainCall(cmd: string, args: readonly string[]): unknown {
        if (cmd === 'stat') return Promise.resolve({ stdout: '993' });
        const probe = bootReadinessMock(cmd, args);
        if (probe) return Promise.resolve(probe);
        if (cmd === 'maestro' && args.includes('test')) {
          return mockSubprocess({ exitCode: 0, stdout: '' });
        }
        // runEmulatorContainer reads stdout.trim() from docker run.
        return Promise.resolve({ stdout: '' });
      }
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) =>
        dispatchMainCall(cmd, Array.isArray(args) ? args : [])) as never);
    });

    afterEach(() => {
      delete process.env['HB_API_PORT'];
      delete process.env['HB_KVM_GID'];
      delete process.env['API_URL'];
      delete process.env['FRONTEND_URL'];
      process.env['PATH'] = savedPath;
    });

    it('calls bakeImage with push=false before starting emulators', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
      );

      await main();

      vi.unstubAllGlobals();
      expect(mockBakeImage).toHaveBeenCalledWith({ push: false });
    });

    it('skips the OTA stage when --smoke is passed', async () => {
      const savedArgv = process.argv;
      process.argv = [...savedArgv.slice(0, 2), '--smoke'];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
      );

      try {
        await main();

        const r2Calls = mockExeca.mock.calls.filter(
          (call) => Array.isArray(call[1]) && call[1].includes('r2')
        );
        expect(r2Calls).toEqual([]);
      } finally {
        process.argv = savedArgv;
        vi.unstubAllGlobals();
      }
    });

    function failMaestroDispatch(cmd: string, args: readonly string[]): unknown {
      if (cmd === 'stat') return Promise.resolve({ stdout: '993' });
      const probe = bootReadinessMock(cmd, args);
      if (probe) return Promise.resolve(probe);
      if (cmd === 'maestro' && args.includes('test')) {
        return mockSubprocess({ exitCode: 1, stdout: '' });
      }
      return Promise.resolve({ stdout: '' });
    }

    it('dumps the API log tail when maestro fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
      );
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) =>
        failMaestroDispatch(cmd, Array.isArray(args) ? args : [])) as never);

      try {
        await expect(main()).rejects.toThrow(
          'Maestro tests failed without identifiable flow failures'
        );

        const written = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
        expect(written).toContain('API log');
      } finally {
        stdoutSpy.mockRestore();
        vi.unstubAllGlobals();
      }
    });

    it('reports a failure to write the API slice without masking the run error', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
      );
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) =>
        failMaestroDispatch(cmd, Array.isArray(args) ? args : [])) as never);
      mockWriteFileSync.mockImplementation(() => {
        throw new Error('disk full');
      });

      try {
        await expect(main()).rejects.toThrow(
          'Maestro tests failed without identifiable flow failures'
        );

        expect(errorSpy).toHaveBeenCalledWith('Failed to write API slice: disk full');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('stringifies non-Error failures from the API slice write', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
      );
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) =>
        failMaestroDispatch(cmd, Array.isArray(args) ? args : [])) as never);
      mockWriteFileSync.mockImplementation(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercises the non-Error branch of the slice-write recovery
        throw 'raw disk failure';
      });

      try {
        await expect(main()).rejects.toThrow(
          'Maestro tests failed without identifiable flow failures'
        );

        expect(errorSpy).toHaveBeenCalledWith('Failed to write API slice: raw disk failure');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('stops execution if prerequisites fail', async () => {
      mockExeca.mockRejectedValueOnce(new Error('Docker not running'));

      await expect(main()).rejects.toThrow('Docker is not running');

      const stopCalls = mockExeca.mock.calls.filter(
        (call) =>
          call[0] === 'docker' &&
          Array.isArray(call[1]) &&
          call[1][0] === 'rm' &&
          typeof call[1][2] === 'string' &&
          call[1][2].startsWith('hushbox-mobile-emulator-shard-')
      );
      expect(stopCalls).toHaveLength(0);
    });

    it('stops all emulators in finally even when a later step fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
      );

      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        if (cmd === 'stat') return Promise.resolve({ stdout: '993' } as never);
        const argumentList = Array.isArray(args) ? [...args] : [];
        if (cmd === 'adb') {
          if (argumentList.includes('connect'))
            return Promise.resolve({ stdout: 'connected' } as never);
          if (argumentList.includes('getprop')) return Promise.resolve({ stdout: '1' } as never);
        }
        if (cmd === 'pnpm' && argumentList.includes('build'))
          return Promise.reject(new Error('build failed'));
        return mockSubprocess();
      }) as never);

      await expect(main()).rejects.toThrow('build failed');
      vi.unstubAllGlobals();

      // teardown stops every shard's emulator
      const stopCalls = mockExeca.mock.calls.filter(
        (call) =>
          call[0] === 'docker' &&
          Array.isArray(call[1]) &&
          call[1][0] === 'rm' &&
          typeof call[1][2] === 'string' &&
          call[1][2].startsWith('hushbox-mobile-emulator-shard-')
      );
      const stoppedShards = new Set(stopCalls.map((c) => (c[1] as string[])[2]));
      expect(stoppedShards.size).toBeGreaterThanOrEqual(1);
    });
  });

  describe('runMaestroOta', () => {
    it('runs the OTA flow with --debug-output and passes when maestro succeeds', async () => {
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        if (cmd === 'maestro' && Array.isArray(args) && args.includes('test')) {
          return mockSubprocess({ exitCode: 0, stdout: '' });
        }
        return mockSubprocess();
      }) as never);

      await expect(runMaestroOta()).resolves.toBeUndefined();
      expect(mockExeca).toHaveBeenCalledWith(
        'maestro',
        expect.arrayContaining([
          'test',
          '--debug-output',
          'maestro-results/ota',
          '--flatten-debug-output',
        ]),
        expect.anything()
      );
    });

    it('rethrows without dumping logcat when maestro fails', async () => {
      const otaError = new Error('OTA flow assertion failed');
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        const argumentList = Array.isArray(args) ? args : [];
        if (cmd === 'maestro' && argumentList.includes('test')) return Promise.reject(otaError);
        return mockSubprocess();
      }) as never);

      // Maestro's own --debug-output artifacts replace the post-mortem logcat dump.
      await expect(runMaestroOta()).rejects.toThrow('OTA flow assertion failed');
      const logcatCalls = mockExeca.mock.calls.filter(
        (c) => c[0] === 'adb' && Array.isArray(c[1]) && c[1].includes('logcat')
      );
      expect(logcatCalls).toHaveLength(0);
    });
  });

  describe('setupOtaUpdate', () => {
    beforeEach(() => {
      process.env['API_URL'] = 'http://localhost:8787';
      process.env['HB_API_PORT'] = '8787';
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
      );
    });

    afterEach(() => {
      delete process.env['API_URL'];
      delete process.env['HB_API_PORT'];
      vi.unstubAllGlobals();
    });

    it('throws when API_URL is not set', async () => {
      delete process.env['API_URL'];

      await expect(setupOtaUpdate()).rejects.toThrow('API_URL not set');
    });

    it('throws when HB_API_PORT is not set', async () => {
      delete process.env['HB_API_PORT'];

      await expect(setupOtaUpdate()).rejects.toThrow('HB_API_PORT not set');
    });

    it('builds OTA bundle with correct VITE_PLATFORM and VITE_APP_VERSION', async () => {
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' } as never);

      await setupOtaUpdate();

      const viteBuild = mockExeca.mock.calls.find(
        (call) =>
          call[0] === 'pnpm' &&
          Array.isArray(call[1]) &&
          call[1].includes('vite') &&
          call[1].includes('build')
      );
      expect(viteBuild).toBeDefined();
      const options = (
        viteBuild as unknown as [string, string[], { env?: Record<string, string> }]
      )[2];
      expect(options.env).toBeDefined();
      expect(options.env!['VITE_PLATFORM']).toBe('android-direct');
      expect(options.env!['VITE_APP_VERSION']).toBe('ota-v2');
    });

    it('uploads to platform-specific R2 key', async () => {
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' } as never);

      await setupOtaUpdate();

      const r2Upload = mockExeca.mock.calls.find(
        (call) =>
          call[0] === 'pnpm' &&
          Array.isArray(call[1]) &&
          call[1].some((argument: string) => argument.includes('hushbox-app-builds'))
      );
      expect(r2Upload).toBeDefined();
      const r2Key = (r2Upload![1] as string[]).find((argument: string) =>
        argument.includes('hushbox-app-builds')
      );
      expect(r2Key).toBe('hushbox-app-builds/builds/android-direct/ota-v2.zip');
    });

    it('sets version override via dev endpoint', async () => {
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' } as never);
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      await setupOtaUpdate();

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:8787/dev/set-version', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 'ota-v2' }),
      });
    });

    it('throws when version override request fails', async () => {
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' } as never);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

      await expect(setupOtaUpdate()).rejects.toThrow('Failed to set version override');
    });

    it('excludes the bundle zip itself when zipping dist-ota', async () => {
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' } as never);
      admZipFilters.captured.length = 0;

      await setupOtaUpdate();

      const filter = admZipFilters.captured.at(-1);
      expect(filter).toBeDefined();
      expect(filter!('ota-bundle.zip')).toBe(false);
      expect(filter!('index.html')).toBe(true);
    });
  });
});
