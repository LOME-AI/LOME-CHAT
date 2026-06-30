import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolvePorts,
  parseProcNetTcp,
  parseNetstatListeners,
  linuxListenerPids,
  darwinListenerPids,
  windowsListenerPids,
  selectListenerLookup,
  linuxPgid,
  darwinPgid,
  windowsPgid,
  selectPgidResolver,
  killPort,
  killPorts,
  type KillerDeps,
  type ProcessKiller,
  type PgidResolver,
} from './kill-ports.js';

function makeDeps(overrides: Partial<KillerDeps> = {}): KillerDeps {
  return {
    readFile: vi.fn(),
    readdir: vi.fn(),
    readlink: vi.fn(),
    execa: vi.fn(),
    ...overrides,
  } as KillerDeps;
}

function makeKiller(): { kill: ReturnType<typeof vi.fn<ProcessKiller['kill']>> } {
  return { kill: vi.fn<ProcessKiller['kill']>() };
}

// Promise sugar so mocks satisfy the typed async signatures without being
// `async` themselves (eslint @typescript-eslint/require-await flags async
// functions that don't use await).
const ok = <T>(value: T): Promise<T> => Promise.resolve(value);
// eslint-disable-next-line promise/no-promise-in-callback -- intentional rejection helper for typed mocks
const fail = (error: Error): Promise<never> => Promise.reject(error);

// Resolver that never finds a PGID, forcing killPort's pid-fallback path (and,
// when used as the default resolver, a null self-PGID so the self-guard is
// inert). Used by tests asserting direct pid kills so they avoid real /proc.
const noPgid: PgidResolver = () => ok(null);

describe('kill-ports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['KP_TEST_A'];
    delete process.env['KP_TEST_B'];
    delete process.env['KP_TEST_C'];
  });

  describe('resolvePorts', () => {
    it('reads port numbers from process.env for each name', () => {
      process.env['KP_TEST_A'] = '4321';
      process.env['KP_TEST_B'] = '5678';
      expect(resolvePorts(['KP_TEST_A', 'KP_TEST_B'])).toEqual([4321, 5678]);
    });

    it('skips env vars that are unset', () => {
      process.env['KP_TEST_A'] = '4321';
      expect(resolvePorts(['KP_TEST_A', 'KP_TEST_B'])).toEqual([4321]);
    });

    it('skips env vars that are non-numeric', () => {
      process.env['KP_TEST_A'] = '4321';
      process.env['KP_TEST_B'] = 'notaport';
      expect(resolvePorts(['KP_TEST_A', 'KP_TEST_B'])).toEqual([4321]);
    });

    it('skips env vars that are zero or negative', () => {
      process.env['KP_TEST_A'] = '0';
      process.env['KP_TEST_B'] = '-1';
      process.env['KP_TEST_C'] = '4321';
      expect(resolvePorts(['KP_TEST_A', 'KP_TEST_B', 'KP_TEST_C'])).toEqual([4321]);
    });

    it('returns empty array when no names provided', () => {
      expect(resolvePorts([])).toEqual([]);
    });
  });

  describe('parseProcNetTcp', () => {
    const sampleTcp = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:10E7 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123924786 1 ffffffff 100 0 0 10 0',
      '   1: 0100007F:22D3 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123925043 1 ffffffff 100 0 0 10 0',
      '   2: 0100007F:0050 0100007F:E7B2 01 00000000:00000000 00:00000000 00000000  1000        0 123925100 1 ffffffff 100 0 0 10 0',
      '',
    ].join('\n');

    it('parses listening sockets with port (hex) and inode', () => {
      const rows = parseProcNetTcp(sampleTcp);
      expect(rows).toContainEqual({ port: 0x10_e7, state: '0A', inode: '123924786' });
      expect(rows).toContainEqual({ port: 0x22_d3, state: '0A', inode: '123925043' });
    });

    it('also includes non-listening rows with their state', () => {
      const rows = parseProcNetTcp(sampleTcp);
      const established = rows.find((r) => r.state === '01');
      expect(established).toEqual({ port: 0x50, state: '01', inode: '123925100' });
    });

    it('skips header line', () => {
      const rows = parseProcNetTcp(sampleTcp);
      expect(rows).toHaveLength(3);
    });

    it('skips blank lines', () => {
      const withBlanks = sampleTcp + '\n\n   \n';
      expect(parseProcNetTcp(withBlanks)).toHaveLength(3);
    });

    it('skips malformed rows missing required columns', () => {
      const broken = ['  sl  local_address ...', '   0: bad-row', ''].join('\n');
      expect(parseProcNetTcp(broken)).toEqual([]);
    });

    it('skips rows whose local address has no port after the colon', () => {
      const noPort = [
        '  sl  local_address rem_address   st ...',
        '   0: 0100007F: 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 42 1 ffffffff 100 0 0 10 0',
        '',
      ].join('\n');
      expect(parseProcNetTcp(noPort)).toEqual([]);
    });

    it('skips rows whose port hex is non-numeric', () => {
      const badPort = [
        '  sl  local_address rem_address   st ...',
        '   0: 0100007F:ZZZZ 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 42 1 ffffffff 100 0 0 10 0',
        '',
      ].join('\n');
      expect(parseProcNetTcp(badPort)).toEqual([]);
    });

    it('parses tcp6 entries (32-char hex addresses)', () => {
      const tcp6 = [
        '  sl  local_address                         remote_address                        st ...',
        '   0: 00000000000000000000000000000000:10E7 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 999 1 ffffffff 100 0 0 10 0',
        '',
      ].join('\n');
      const rows = parseProcNetTcp(tcp6);
      expect(rows).toEqual([{ port: 0x10_e7, state: '0A', inode: '999' }]);
    });

    it('returns empty array for empty content', () => {
      expect(parseProcNetTcp('')).toEqual([]);
    });
  });

  describe('parseNetstatListeners', () => {
    const sampleNetstat = [
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:4301           0.0.0.0:0              LISTENING       5518',
      '  TCP    0.0.0.0:8915           0.0.0.0:0              LISTENING       5895',
      '  TCP    127.0.0.1:54321        127.0.0.1:4301         ESTABLISHED     9999',
      '  TCP    [::]:4301              [::]:0                 LISTENING       5518',
      '  UDP    0.0.0.0:4301           *:*                                    1234',
      '',
    ].join('\n');

    it('returns LISTENING PIDs for matching TCP port', () => {
      expect(parseNetstatListeners(sampleNetstat, 4301)).toEqual([5518]);
    });

    it('returns empty for ports with no LISTENING entry', () => {
      expect(parseNetstatListeners(sampleNetstat, 9999)).toEqual([]);
    });

    it('ignores rows whose PID is zero', () => {
      const stdout = '  TCP    0.0.0.0:4301           0.0.0.0:0              LISTENING       0';

      expect(parseNetstatListeners(stdout, 4301)).toEqual([]);
    });

    it('ignores UDP and ESTABLISHED rows', () => {
      expect(parseNetstatListeners(sampleNetstat, 54_321)).toEqual([]);
    });

    it('deduplicates PIDs that appear on both IPv4 and IPv6 LISTEN rows', () => {
      const pids = parseNetstatListeners(sampleNetstat, 4301);
      expect(pids).toEqual([5518]);
    });

    it('returns empty for empty input', () => {
      expect(parseNetstatListeners('', 4301)).toEqual([]);
    });
  });

  describe('linuxListenerPids', () => {
    function tcpFixture(port: number, inode: string): string {
      const portHex = port.toString(16).toUpperCase().padStart(4, '0');
      return [
        '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
        `   0: 0100007F:${portHex} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 ffffffff 100 0 0 10 0`,
        '',
      ].join('\n');
    }

    it('returns PIDs whose /proc fds reference the listening inode', async () => {
      const readFile = vi.fn((path: string): Promise<string> => {
        if (path === '/proc/net/tcp') return ok(tcpFixture(4301, '123924786'));
        if (path === '/proc/net/tcp6') return ok('');
        return fail(new Error(`unexpected readFile ${path}`));
      });
      const readdir = vi.fn((path: string): Promise<string[]> => {
        if (path === '/proc') return ok(['1', '5518', 'self', 'cpuinfo']);
        if (path === '/proc/1/fd') return ok(['0', '1', '2']);
        if (path === '/proc/5518/fd') return ok(['0', '1', '2', '14']);
        return fail(new Error(`unexpected readdir ${path}`));
      });
      const readlink = vi.fn((path: string): Promise<string> => {
        if (path === '/proc/5518/fd/14') return ok('socket:[123924786]');
        if (path.startsWith('/proc/1/fd/')) return ok('/dev/null');
        if (path.startsWith('/proc/5518/fd/')) return ok('pipe:[111]');
        return fail(new Error(`unexpected readlink ${path}`));
      });
      const deps = makeDeps({ readFile, readdir, readlink });
      await expect(linuxListenerPids(4301, deps)).resolves.toEqual([5518]);
    });

    it('returns empty array when no listener matches the port', async () => {
      const readFile = vi.fn(() => ok(tcpFixture(9999, '5')));
      const readdir = vi.fn(() => ok([] as string[]));
      const readlink = vi.fn();
      const deps = makeDeps({ readFile, readdir, readlink });
      await expect(linuxListenerPids(4301, deps)).resolves.toEqual([]);
      expect(readdir).not.toHaveBeenCalled();
    });

    it('tolerates /proc/net/tcp6 being absent', async () => {
      const readFile = vi.fn((path: string): Promise<string> => {
        if (path === '/proc/net/tcp') return ok(tcpFixture(4301, '42'));
        return fail(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });
      const readdir = vi.fn(
        (path: string): Promise<string[]> => ok(path === '/proc' ? ['1'] : ['0'])
      );
      const readlink = vi.fn(() => ok('/dev/null'));
      const deps = makeDeps({ readFile, readdir, readlink });
      await expect(linuxListenerPids(4301, deps)).resolves.toEqual([]);
    });

    it('propagates failure to read /proc/net/tcp', async () => {
      const readFile = vi.fn(() => fail(new Error('EACCES')));
      const deps = makeDeps({ readFile });
      await expect(linuxListenerPids(4301, deps)).rejects.toThrow('EACCES');
    });

    it('skips non-numeric /proc entries (self, cpuinfo) and broken readlinks', async () => {
      const readFile = vi.fn(
        (path: string): Promise<string> =>
          ok(path === '/proc/net/tcp' ? tcpFixture(4301, '42') : '')
      );
      const readdir = vi.fn((path: string): Promise<string[]> => {
        if (path === '/proc') return ok(['self', 'cpuinfo', '99']);
        if (path === '/proc/99/fd') return ok(['7']);
        return fail(new Error(`unexpected ${path}`));
      });
      const readlink = vi.fn(() => fail(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
      const deps = makeDeps({ readFile, readdir, readlink });
      await expect(linuxListenerPids(4301, deps)).resolves.toEqual([]);
    });

    it('skips PIDs whose fd directory cannot be read (process exited mid-scan)', async () => {
      const readFile = vi.fn(
        (path: string): Promise<string> =>
          ok(path === '/proc/net/tcp' ? tcpFixture(4301, '42') : '')
      );
      const readdir = vi.fn((path: string): Promise<string[]> => {
        if (path === '/proc') return ok(['1234']);
        return fail(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });
      const readlink = vi.fn();
      const deps = makeDeps({ readFile, readdir, readlink });
      await expect(linuxListenerPids(4301, deps)).resolves.toEqual([]);
    });
  });

  describe('darwinListenerPids', () => {
    it('shells lsof -t and parses one PID per line', async () => {
      const execa = vi.fn(() =>
        ok({ stdout: '5518\n5519\n', stderr: '', exitCode: 0, failed: false })
      );
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(darwinListenerPids(4301, deps)).resolves.toEqual([5518, 5519]);
      expect(execa).toHaveBeenCalledWith('lsof', ['-nP', '-iTCP:4301', '-sTCP:LISTEN', '-t'], {
        reject: false,
      });
    });

    it('returns empty when lsof exits 1 (no matches)', async () => {
      const execa = vi.fn(() => ok({ stdout: '', stderr: '', exitCode: 1, failed: true }));
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(darwinListenerPids(4301, deps)).resolves.toEqual([]);
    });

    it('throws when lsof exits with another non-zero code', async () => {
      const execa = vi.fn(() =>
        ok({
          stdout: '',
          stderr: 'permission denied',
          exitCode: 2,
          failed: true,
          shortMessage: 'lsof failed',
        })
      );
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(darwinListenerPids(4301, deps)).rejects.toThrow(
        /lsof failed.*permission denied/
      );
    });

    it('throws a clear error when lsof is missing (ENOENT)', async () => {
      const execa = vi.fn(() =>
        fail(Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' }))
      );
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(darwinListenerPids(4301, deps)).rejects.toThrow(/lsof not found/);
    });

    it('re-throws non-ENOENT spawn errors verbatim', async () => {
      const execa = vi.fn(() =>
        fail(Object.assign(new Error('spawn lsof EACCES'), { code: 'EACCES' }))
      );
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(darwinListenerPids(4301, deps)).rejects.toThrow('spawn lsof EACCES');
    });

    it('reports "unknown" when the binary failed without stderr or shortMessage', async () => {
      const execa = vi.fn(() => ok({ stdout: '', stderr: '', exitCode: null, failed: true }));
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(darwinListenerPids(4301, deps)).rejects.toThrow(
        /lsof failed \(exit null\): unknown/
      );
    });
  });

  describe('windowsListenerPids', () => {
    it('shells netstat -ano and returns LISTENING PIDs for the port', async () => {
      const stdout = [
        '  Proto  Local Address          Foreign Address        State           PID',
        '  TCP    0.0.0.0:4301           0.0.0.0:0              LISTENING       5518',
        '',
      ].join('\n');
      const execa = vi.fn(() => ok({ stdout, stderr: '', exitCode: 0, failed: false }));
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(windowsListenerPids(4301, deps)).resolves.toEqual([5518]);
      expect(execa).toHaveBeenCalledWith('netstat', ['-ano'], { reject: false });
    });

    it('throws when netstat exits non-zero', async () => {
      const execa = vi.fn(() =>
        ok({
          stdout: '',
          stderr: 'oops',
          exitCode: 1,
          failed: true,
          shortMessage: 'netstat failed',
        })
      );
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(windowsListenerPids(4301, deps)).rejects.toThrow(/netstat failed.*oops/);
    });

    it('throws a clear error when netstat is missing (ENOENT)', async () => {
      const execa = vi.fn(() =>
        fail(Object.assign(new Error('spawn netstat ENOENT'), { code: 'ENOENT' }))
      );
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(windowsListenerPids(4301, deps)).rejects.toThrow(/netstat not found/);
    });
  });

  describe('selectListenerLookup', () => {
    it('returns the Linux killer on linux', () => {
      expect(selectListenerLookup('linux')).toBe(linuxListenerPids);
    });

    it('returns the macOS killer on darwin', () => {
      expect(selectListenerLookup('darwin')).toBe(darwinListenerPids);
    });

    it('returns the Windows killer on win32', () => {
      expect(selectListenerLookup('win32')).toBe(windowsListenerPids);
    });

    it('throws on unsupported platforms', () => {
      expect(() => selectListenerLookup('aix' as NodeJS.Platform)).toThrow(
        /unsupported platform "aix"/
      );
    });

    it('defaults to process.platform when no argument is passed', () => {
      // On Linux CI/dev, this should be linuxListenerPids.
      expect(typeof selectListenerLookup()).toBe('function');
    });
  });

  describe('linuxPgid', () => {
    it('returns the process group from /proc/<pid>/stat', async () => {
      const readFile = vi.fn(() => ok('649954 (workerd) S 649860 649773 649773 0 -1 4194560'));
      const deps = makeDeps({ readFile });
      await expect(linuxPgid(649_954, deps)).resolves.toBe(649_773);
      expect(readFile).toHaveBeenCalledWith('/proc/649954/stat', 'utf8');
    });

    it('parses pgrp when the comm field itself contains parentheses', async () => {
      // comm (field 2) is "(weird ) (name)"; pgrp is the 3rd field after the LAST ')'
      const readFile = vi.fn(() => ok('42 (weird ) (name) S 7 1234 1234 0 -1 0'));
      const deps = makeDeps({ readFile });
      await expect(linuxPgid(42, deps)).resolves.toBe(1234);
    });

    it('returns null when /proc/<pid>/stat cannot be read (process exited)', async () => {
      const readFile = vi.fn(() => fail(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
      const deps = makeDeps({ readFile });
      await expect(linuxPgid(999, deps)).resolves.toBeNull();
    });

    it('returns null when the stat line has no closing paren', async () => {
      const readFile = vi.fn(() => ok('garbage-without-paren'));
      const deps = makeDeps({ readFile });
      await expect(linuxPgid(1, deps)).resolves.toBeNull();
    });

    it('returns null when the pgrp field is non-numeric', async () => {
      const readFile = vi.fn(() => ok('42 (comm) S 7 notanumber 0 0'));
      const deps = makeDeps({ readFile });
      await expect(linuxPgid(42, deps)).resolves.toBeNull();
    });

    it('returns null when pgrp is not positive', async () => {
      const readFile = vi.fn(() => ok('42 (comm) S 7 0 0 0'));
      const deps = makeDeps({ readFile });
      await expect(linuxPgid(42, deps)).resolves.toBeNull();
    });
  });

  describe('darwinPgid', () => {
    it('shells `ps -o pgid=` and parses the group id', async () => {
      const execa = vi.fn(() =>
        ok({ stdout: ' 649773\n', stderr: '', exitCode: 0, failed: false })
      );
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(darwinPgid(649_954, deps)).resolves.toBe(649_773);
      expect(execa).toHaveBeenCalledWith('ps', ['-o', 'pgid=', '-p', '649954'], { reject: false });
    });

    it('returns null when ps prints nothing (no such pid)', async () => {
      const execa = vi.fn(() => ok({ stdout: '', stderr: '', exitCode: 1, failed: true }));
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(darwinPgid(999, deps)).resolves.toBeNull();
    });

    it('returns null when ps cannot be spawned', async () => {
      const execa = vi.fn(() =>
        fail(Object.assign(new Error('spawn ps ENOENT'), { code: 'ENOENT' }))
      );
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(darwinPgid(999, deps)).resolves.toBeNull();
    });
  });

  describe('windowsPgid', () => {
    it('always returns null (POSIX process groups are not used on Windows)', async () => {
      await expect(windowsPgid()).resolves.toBeNull();
    });
  });

  describe('selectPgidResolver', () => {
    it('returns the Linux resolver on linux', () => {
      expect(selectPgidResolver('linux')).toBe(linuxPgid);
    });

    it('returns the macOS resolver on darwin', () => {
      expect(selectPgidResolver('darwin')).toBe(darwinPgid);
    });

    it('returns the Windows resolver on win32', () => {
      expect(selectPgidResolver('win32')).toBe(windowsPgid);
    });

    it('throws on unsupported platforms', () => {
      expect(() => selectPgidResolver('aix' as NodeJS.Platform)).toThrow(
        /unsupported platform "aix"/
      );
    });

    it('defaults to process.platform when no argument is passed', () => {
      expect(typeof selectPgidResolver()).toBe('function');
    });
  });

  describe('killPort', () => {
    it('SIGKILLs every PID returned by the lookup', async () => {
      const killer = makeKiller();
      const lookup = vi.fn(() => ok([111, 222]));
      const result = await killPort(4301, { lookup, killer, pgid: noPgid });
      expect(lookup).toHaveBeenCalledWith(4301, undefined);
      expect(killer.kill).toHaveBeenNthCalledWith(1, 111, 'SIGKILL');
      expect(killer.kill).toHaveBeenNthCalledWith(2, 222, 'SIGKILL');
      expect(result).toEqual([111, 222]);
    });

    it('returns empty array and does not kill when port has no listener', async () => {
      const killer = makeKiller();
      const lookup = vi.fn(() => ok([] as number[]));
      await expect(killPort(4301, { lookup, killer, pgid: noPgid })).resolves.toEqual([]);
      expect(killer.kill).not.toHaveBeenCalled();
    });

    it('tolerates ESRCH (process already exited between discovery and kill)', async () => {
      const killer = makeKiller();
      killer.kill.mockImplementation((_pid: number) => {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      });
      const lookup = vi.fn(() => ok([111]));
      await expect(killPort(4301, { lookup, killer, pgid: noPgid })).resolves.toEqual([111]);
    });

    it('throws when process.kill fails for a reason other than ESRCH', async () => {
      const killer = makeKiller();
      killer.kill.mockImplementation(() => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      });
      const lookup = vi.fn(() => ok([111]));
      await expect(killPort(4301, { lookup, killer, pgid: noPgid })).rejects.toThrow(
        /failed to SIGKILL pid 111 \(port 4301\): EPERM/
      );
    });

    it('reports non-Error throws via String() so the message still appears', async () => {
      const killer = makeKiller();
      killer.kill.mockImplementation(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- testing the non-Error branch
        throw 'unexpected-string-throw';
      });
      const lookup = vi.fn(() => ok([222]));
      await expect(killPort(4301, { lookup, killer, pgid: noPgid })).rejects.toThrow(
        /failed to SIGKILL pid 222 \(port 4301\): unexpected-string-throw/
      );
    });

    it('forwards deps to the lookup', async () => {
      const killer = makeKiller();
      const lookup = vi.fn(() => ok([] as number[]));
      const deps = makeDeps();
      await killPort(4301, { lookup, killer, deps, pgid: noPgid });
      expect(lookup).toHaveBeenCalledWith(4301, deps);
    });

    it('falls back to the platform default lookup and killer when no options are passed', async () => {
      // Smoke test: real /proc-based lookup on Linux against a port we don't
      // bind. Returns [] without invoking the real process.kill (no PIDs to
      // kill), so it covers both default fallbacks without side effects.
      await expect(killPort(65_530)).resolves.toEqual([]);
    });
  });

  describe('killPort — process group escalation', () => {
    it("SIGKILLs the listener's process group (negative PGID), not just the pid", async () => {
      const killer = makeKiller();
      const lookup = vi.fn(() => ok([649_954])); // workerd listening on the port
      const pgid = vi.fn(() => ok(649_773)); // its wrangler-led process group
      const result = await killPort(8915, { lookup, pgid, killer, selfPgid: null });
      expect(killer.kill).toHaveBeenCalledTimes(1);
      expect(killer.kill).toHaveBeenCalledWith(-649_773, 'SIGKILL');
      // Returns the discovered listener pids (for logging), not the group.
      expect(result).toEqual([649_954]);
    });

    it('kills a shared process group once when several listeners belong to it', async () => {
      const killer = makeKiller();
      const lookup = vi.fn(() => ok([100, 101])); // two workerd in one wrangler group
      const pgid = vi.fn(() => ok(900));
      await killPort(8915, { lookup, pgid, killer, selfPgid: null });
      expect(killer.kill).toHaveBeenCalledTimes(1);
      expect(killer.kill).toHaveBeenCalledWith(-900, 'SIGKILL');
    });

    it('kills each distinct process group when listeners span multiple groups', async () => {
      const killer = makeKiller();
      const lookup = vi.fn(() => ok([100, 200]));
      const pgid = vi.fn((pid: number) => ok(pid === 100 ? 900 : 901));
      await killPort(8915, { lookup, pgid, killer, selfPgid: null });
      expect(killer.kill).toHaveBeenNthCalledWith(1, -900, 'SIGKILL');
      expect(killer.kill).toHaveBeenNthCalledWith(2, -901, 'SIGKILL');
    });

    it('falls back to killing the listener pid when the PGID cannot be resolved', async () => {
      const killer = makeKiller();
      const lookup = vi.fn(() => ok([111]));
      const pgid = vi.fn(() => ok(null));
      await killPort(8915, { lookup, pgid, killer, selfPgid: null });
      expect(killer.kill).toHaveBeenCalledTimes(1);
      expect(killer.kill).toHaveBeenCalledWith(111, 'SIGKILL');
    });

    it('names the process group in the error when a group kill fails', async () => {
      const killer = makeKiller();
      killer.kill.mockImplementation(() => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      });
      const lookup = vi.fn(() => ok([100]));
      const pgid = vi.fn(() => ok(900));
      await expect(killPort(8915, { lookup, pgid, killer, selfPgid: null })).rejects.toThrow(
        /failed to SIGKILL process group 900 \(port 8915\): EPERM/
      );
    });

    it('tolerates ESRCH when the group already exited', async () => {
      const killer = makeKiller();
      killer.kill.mockImplementation(() => {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      });
      const lookup = vi.fn(() => ok([100]));
      const pgid = vi.fn(() => ok(900));
      await expect(killPort(8915, { lookup, pgid, killer, selfPgid: null })).resolves.toEqual([
        100,
      ]);
    });

    it('never signals our own process group (self-guard)', async () => {
      const killer = makeKiller();
      const lookup = vi.fn(() => ok([100])); // a listener that lives in OUR group
      const pgid = vi.fn(() => ok(900));
      const result = await killPort(8915, { lookup, pgid, killer, selfPgid: 900 });
      expect(killer.kill).not.toHaveBeenCalled();
      expect(result).toEqual([100]);
    });

    it('resolves our own PGID via the resolver when selfPgid is not provided', async () => {
      const killer = makeKiller();
      const lookup = vi.fn(() => ok([100]));
      // Resolver returns our own group for process.pid, a different group for the listener.
      const pgid = vi.fn((pid: number) => ok(pid === process.pid ? 900 : 901));
      await killPort(8915, { lookup, pgid, killer });
      expect(pgid).toHaveBeenCalledWith(process.pid, undefined);
      expect(killer.kill).toHaveBeenCalledTimes(1);
      expect(killer.kill).toHaveBeenCalledWith(-901, 'SIGKILL');
    });

    it('does not resolve our own PGID when there are no listeners', async () => {
      const killer = makeKiller();
      const lookup = vi.fn(() => ok([] as number[]));
      const pgid = vi.fn(() => ok(900));
      const result = await killPort(8915, { lookup, pgid, killer });
      expect(pgid).not.toHaveBeenCalled();
      expect(killer.kill).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });
  });

  describe('killPorts', () => {
    it('kills every port in order', async () => {
      const killer = makeKiller();
      const lookup = vi.fn((port: number) => ok([port * 10]));
      await killPorts([4301, 8915], { lookup, killer, pgid: noPgid });
      // vitest matches call arity exactly; lookup is invoked as (port, undefined).
      // eslint-disable-next-line unicorn/no-useless-undefined
      expect(lookup).toHaveBeenNthCalledWith(1, 4301, undefined);
      // eslint-disable-next-line unicorn/no-useless-undefined
      expect(lookup).toHaveBeenNthCalledWith(2, 8915, undefined);
      expect(killer.kill).toHaveBeenNthCalledWith(1, 43_010, 'SIGKILL');
      expect(killer.kill).toHaveBeenNthCalledWith(2, 89_150, 'SIGKILL');
    });

    it('stops at the first real failure', async () => {
      const killer = makeKiller();
      killer.kill.mockImplementation((pid: number) => {
        if (pid === 43_010) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      });
      const lookup = vi.fn((port: number) => ok([port * 10]));
      await expect(killPorts([4301, 8915], { lookup, killer, pgid: noPgid })).rejects.toThrow(
        /EPERM/
      );
      expect(lookup).toHaveBeenCalledTimes(1);
    });

    it('no-ops on empty list', async () => {
      const killer = makeKiller();
      const lookup = vi.fn();
      await expect(killPorts([], { lookup, killer })).resolves.toBeUndefined();
      expect(lookup).not.toHaveBeenCalled();
      expect(killer.kill).not.toHaveBeenCalled();
    });
  });
});
