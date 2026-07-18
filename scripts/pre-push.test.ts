import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('./lib/gitleaks.js', () => ({
  ensureGitleaks: vi.fn((): Promise<string> => Promise.resolve('/cache/gitleaks/8.24.3/gitleaks')),
}));

import { execa } from 'execa';
import { ensureGitleaks } from './lib/gitleaks.js';
import {
  PARALLEL_TASKS,
  TEST_TASK,
  runParallel,
  runSequential,
  main,
  parsePushReferences,
  computeLogOptionsString,
  buildGitleaksTask,
  type Task,
} from './pre-push.js';

const mockExeca = vi.mocked(execa);
const mockEnsure = vi.mocked(ensureGitleaks);

interface FakeProcess extends Promise<void> {
  exitCode: number | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  _resolve: () => void;
  _reject: (error: Error) => void;
}

function makeFakeProcess(): FakeProcess {
  let resolveFunction!: () => void;
  let rejectFunction!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveFunction = () => {
      resolve();
    };
    rejectFunction = reject;
  });
  const fake = Object.assign(promise, {
    exitCode: null as number | null,
    killed: false,
    kill: vi.fn(),
    _resolve: () => {
      fake.exitCode = 0;
      resolveFunction();
    },
    _reject: (error: Error) => {
      fake.exitCode = 1;
      rejectFunction(error);
    },
  }) as unknown as FakeProcess;
  fake.kill.mockImplementation(() => {
    fake.killed = true;
    fake.exitCode = 143;
    rejectFunction(new Error('killed by SIGTERM'));
    return true;
  });
  return fake;
}

function captureProcs(): FakeProcess[] {
  const procs: FakeProcess[] = [];
  mockExeca.mockImplementation((() => {
    const p = makeFakeProcess();
    procs.push(p);
    return p;
  }) as never);
  return procs;
}

async function waitForExecaCalls(n: number): Promise<void> {
  while (mockExeca.mock.calls.length < n) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

describe('pre-push', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('PARALLEL_TASKS', () => {
    it('contains the five static checks in expected order', () => {
      expect(PARALLEL_TASKS.map((t) => t.name)).toEqual([
        'lint:duplication',
        'lint:unused',
        'lint',
        'typecheck',
        'arch:check',
      ]);
    });

    it('each task invokes pnpm <name>', () => {
      for (const task of PARALLEL_TASKS) {
        expect(task.command).toBe('pnpm');
        expect(task.args).toEqual([task.name]);
      }
    });
  });

  describe('TEST_TASK', () => {
    it('is pnpm test', () => {
      expect(TEST_TASK).toEqual({ name: 'test', command: 'pnpm', args: ['test'] });
    });
  });

  describe('runParallel', () => {
    it('spawns each task with stdio inherit', async () => {
      const procs = captureProcs();
      const tasks: Task[] = [
        { name: 'a', command: 'pnpm', args: ['a'] },
        { name: 'b', command: 'pnpm', args: ['b'] },
      ];
      const promise = runParallel(tasks);
      await waitForExecaCalls(2);
      procs[0]!._resolve();
      procs[1]!._resolve();
      await promise;
      expect(mockExeca).toHaveBeenCalledTimes(2);
      expect(mockExeca).toHaveBeenNthCalledWith(
        1,
        'pnpm',
        ['a'],
        expect.objectContaining({ stdio: 'inherit' })
      );
      expect(mockExeca).toHaveBeenNthCalledWith(
        2,
        'pnpm',
        ['b'],
        expect.objectContaining({ stdio: 'inherit' })
      );
    });

    it('resolves when all tasks succeed', async () => {
      const procs = captureProcs();
      const tasks: Task[] = [
        { name: 'a', command: 'pnpm', args: ['a'] },
        { name: 'b', command: 'pnpm', args: ['b'] },
      ];
      const promise = runParallel(tasks);
      await waitForExecaCalls(2);
      procs[0]!._resolve();
      procs[1]!._resolve();
      await expect(promise).resolves.toBeUndefined();
    });

    it('kills siblings with SIGTERM when one task fails', async () => {
      const procs = captureProcs();
      const tasks: Task[] = [
        { name: 'a', command: 'pnpm', args: ['a'] },
        { name: 'b', command: 'pnpm', args: ['b'] },
        { name: 'c', command: 'pnpm', args: ['c'] },
      ];
      const promise = runParallel(tasks);
      await waitForExecaCalls(3);
      procs[0]!._reject(new Error('boom'));
      await expect(promise).rejects.toThrow('boom');
      expect(procs[1]!.kill).toHaveBeenCalledWith('SIGTERM');
      expect(procs[2]!.kill).toHaveBeenCalledWith('SIGTERM');
      expect(procs[0]!.kill).not.toHaveBeenCalled();
    });

    it('does not kill already-completed siblings', async () => {
      const procs = captureProcs();
      const tasks: Task[] = [
        { name: 'a', command: 'pnpm', args: ['a'] },
        { name: 'b', command: 'pnpm', args: ['b'] },
      ];
      const promise = runParallel(tasks);
      await waitForExecaCalls(2);
      procs[0]!._resolve();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      procs[1]!._reject(new Error('failure'));
      await expect(promise).rejects.toThrow('failure');
      expect(procs[0]!.kill).not.toHaveBeenCalled();
    });

    it('throws the first failure even when later ones fail too', async () => {
      const procs = captureProcs();
      const tasks: Task[] = [
        { name: 'a', command: 'pnpm', args: ['a'] },
        { name: 'b', command: 'pnpm', args: ['b'] },
      ];
      const promise = runParallel(tasks);
      await waitForExecaCalls(2);
      procs[1]!._reject(new Error('first failure'));
      await expect(promise).rejects.toThrow('first failure');
    });

    it('wraps a non-Error rejection in an Error', async () => {
      const procs = captureProcs();
      const tasks: Task[] = [{ name: 'a', command: 'pnpm', args: ['a'] }];
      const promise = runParallel(tasks);
      await waitForExecaCalls(1);
      procs[0]!._reject('plain string failure' as unknown as Error);
      await expect(promise).rejects.toThrow('plain string failure');
    });
  });

  describe('runSequential', () => {
    it('runs the task with stdio inherit and resolves on success', async () => {
      const procs = captureProcs();
      const promise = runSequential({ name: 'test', command: 'pnpm', args: ['test'] });
      await waitForExecaCalls(1);
      procs[0]!._resolve();
      await expect(promise).resolves.toBeUndefined();
      expect(mockExeca).toHaveBeenCalledWith(
        'pnpm',
        ['test'],
        expect.objectContaining({ stdio: 'inherit' })
      );
    });

    it('rejects when the task fails', async () => {
      const procs = captureProcs();
      const promise = runSequential({ name: 'test', command: 'pnpm', args: ['test'] });
      await waitForExecaCalls(1);
      procs[0]!._reject(new Error('test failed'));
      await expect(promise).rejects.toThrow('test failed');
    });
  });

  describe('parsePushRefs', () => {
    it('returns an empty array for empty stdin', () => {
      expect(parsePushReferences('')).toEqual([]);
    });

    it('ignores blank lines and surrounding whitespace', () => {
      expect(parsePushReferences('\n  \n')).toEqual([]);
    });

    it('parses a single push ref line', () => {
      expect(parsePushReferences('refs/heads/main abc refs/heads/main def')).toEqual([
        {
          localRef: 'refs/heads/main',
          localSha: 'abc',
          remoteRef: 'refs/heads/main',
          remoteSha: 'def',
        },
      ]);
    });

    it('parses multiple push ref lines', () => {
      const references = parsePushReferences(
        'refs/heads/a 111 refs/heads/a 222\nrefs/heads/b 333 refs/heads/b 444'
      );
      expect(references).toHaveLength(2);
      expect(references[1]!.localSha).toBe('333');
    });
  });

  describe('computeLogOptsString', () => {
    const ZERO = '0'.repeat(40);

    it('returns a remote..local range for an updated branch', () => {
      expect(
        computeLogOptionsString([
          {
            localRef: 'refs/heads/main',
            localSha: 'newsha',
            remoteRef: 'refs/heads/main',
            remoteSha: 'oldsha',
          },
        ])
      ).toBe('oldsha..newsha');
    });

    it('scans commits not already on a remote for a new branch', () => {
      expect(
        computeLogOptionsString([
          {
            localRef: 'refs/heads/feat',
            localSha: 'newsha',
            remoteRef: 'refs/heads/feat',
            remoteSha: ZERO,
          },
        ])
      ).toBe('newsha --not --remotes');
    });

    it('skips branch deletions', () => {
      expect(
        computeLogOptionsString([
          { localRef: '', localSha: ZERO, remoteRef: 'refs/heads/gone', remoteSha: 'oldsha' },
        ])
      ).toBeNull();
    });

    it('joins multiple ranges into one log-opts string', () => {
      expect(
        computeLogOptionsString([
          { localRef: 'refs/heads/a', localSha: 'a2', remoteRef: 'refs/heads/a', remoteSha: 'a1' },
          { localRef: 'refs/heads/b', localSha: 'b2', remoteRef: 'refs/heads/b', remoteSha: ZERO },
        ])
      ).toBe('a1..a2 b2 --not --remotes');
    });
  });

  describe('buildGitleaksTask', () => {
    const ZERO = '0'.repeat(40);

    it('scans the last commit when run from a TTY', async () => {
      const task = await buildGitleaksTask('', true);
      expect(task).toEqual({
        name: 'gitleaks',
        command: '/cache/gitleaks/8.24.3/gitleaks',
        args: ['git', '--redact', '--no-banner', '--log-opts=-1'],
      });
      expect(mockEnsure).toHaveBeenCalledTimes(1);
    });

    it('falls back to the last commit when stdin is empty', async () => {
      const task = await buildGitleaksTask('', false);
      expect(task!.args).toContain('--log-opts=-1');
    });

    it('scans the pushed range from stdin', async () => {
      const task = await buildGitleaksTask('refs/heads/main newsha refs/heads/main oldsha', false);
      expect(task!.args).toContain('--log-opts=oldsha..newsha');
    });

    it('returns null and does not resolve the binary when only deletions are pushed', async () => {
      const task = await buildGitleaksTask(`refs/heads/gone ${ZERO} refs/heads/gone oldsha`, false);
      expect(task).toBeNull();
      expect(mockEnsure).not.toHaveBeenCalled();
    });
  });

  describe('main', () => {
    it('runs parallel checks plus gitleaks, then test on success', async () => {
      const procs = captureProcs();
      const promise = main('', true);
      await waitForExecaCalls(6);
      for (let index = 0; index < 6; index++) {
        procs[index]!._resolve();
      }
      await waitForExecaCalls(7);
      procs[6]!._resolve();
      await expect(promise).resolves.toBeUndefined();
      expect(mockExeca).toHaveBeenCalledTimes(7);
      expect(mockExeca).toHaveBeenCalledWith(
        '/cache/gitleaks/8.24.3/gitleaks',
        ['git', '--redact', '--no-banner', '--log-opts=-1'],
        expect.objectContaining({ stdio: 'inherit' })
      );
      expect(mockExeca).toHaveBeenLastCalledWith(
        'pnpm',
        ['test'],
        expect.objectContaining({ stdio: 'inherit' })
      );
    });

    it('omits the gitleaks task when only deletions are pushed', async () => {
      const procs = captureProcs();
      const promise = main(`refs/heads/gone ${'0'.repeat(40)} refs/heads/gone oldsha`, false);
      await waitForExecaCalls(5);
      for (let index = 0; index < 5; index++) {
        procs[index]!._resolve();
      }
      await waitForExecaCalls(6);
      procs[5]!._resolve();
      await expect(promise).resolves.toBeUndefined();
      expect(mockExeca).toHaveBeenCalledTimes(6);
    });

    it('does not run test when a parallel task fails', async () => {
      const procs = captureProcs();
      const promise = main('', true);
      await waitForExecaCalls(6);
      procs[0]!._reject(new Error('lint failed'));
      await expect(promise).rejects.toThrow('lint failed');
      expect(mockExeca).not.toHaveBeenCalledWith(
        'pnpm',
        ['test'],
        expect.objectContaining({ stdio: 'inherit' })
      );
    });
  });
});
