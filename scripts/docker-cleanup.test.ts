import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import {
  parseWorktreePaths,
  parseDockerProjects,
  findOrphanedProjects,
  getActiveWorktreePaths,
  getRunningDockerProjects,
  removeProject,
  cleanupOrphanedProjects,
  parseArgs,
  main,
  type DockerComposeProject,
} from './docker-cleanup.js';

const mockExeca = vi.mocked(execa);

describe('docker-cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseArgs', () => {
    it('returns dryRun false by default', () => {
      expect(parseArgs([])).toEqual({ dryRun: false });
    });

    it('returns dryRun true when --dry-run is present', () => {
      expect(parseArgs(['--dry-run'])).toEqual({ dryRun: true });
    });

    it('ignores other flags', () => {
      expect(parseArgs(['--verbose', '--dry-run', '--force'])).toEqual({ dryRun: true });
    });
  });

  describe('parseWorktreePaths', () => {
    it('parses porcelain output with multiple worktrees', () => {
      const output = [
        'worktree /home/user/project',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /home/user/worktrees/feature-a',
        'HEAD def456',
        'branch refs/heads/feature-a',
        '',
      ].join('\n');

      expect(parseWorktreePaths(output)).toEqual([
        '/home/user/project',
        '/home/user/worktrees/feature-a',
      ]);
    });

    it('returns empty array for empty string', () => {
      expect(parseWorktreePaths('')).toEqual([]);
    });

    it('handles single worktree', () => {
      const output = [
        'worktree /home/user/project',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
      ].join('\n');

      expect(parseWorktreePaths(output)).toEqual(['/home/user/project']);
    });

    it('handles trailing newlines', () => {
      const output = 'worktree /home/user/project\nHEAD abc123\nbranch refs/heads/main\n\n\n';

      expect(parseWorktreePaths(output)).toEqual(['/home/user/project']);
    });
  });

  describe('parseDockerProjects', () => {
    it('parses multi-line output into unique projects', () => {
      const output = [
        'hushbox-34\t/home/user/worktrees/feature-a',
        'hushbox-34\t/home/user/worktrees/feature-a',
        'hushbox-51\t/home/user/worktrees/feature-b',
      ].join('\n');

      expect(parseDockerProjects(output)).toEqual([
        { projectName: 'hushbox-34', workingDir: '/home/user/worktrees/feature-a' },
        { projectName: 'hushbox-51', workingDir: '/home/user/worktrees/feature-b' },
      ]);
    });

    it('filters to only hushbox-* prefix', () => {
      const output = [
        'hushbox\t/home/user/main-repo',
        'hushbox-34\t/home/user/worktrees/feature-a',
        'other-project\t/home/user/other',
      ].join('\n');

      expect(parseDockerProjects(output)).toEqual([
        { projectName: 'hushbox-34', workingDir: '/home/user/worktrees/feature-a' },
      ]);
    });

    it('returns empty array for empty string', () => {
      expect(parseDockerProjects('')).toEqual([]);
    });

    it('handles single project', () => {
      const output = 'hushbox-73\t/home/user/worktrees/feature-c';

      expect(parseDockerProjects(output)).toEqual([
        { projectName: 'hushbox-73', workingDir: '/home/user/worktrees/feature-c' },
      ]);
    });

    it('skips malformed lines', () => {
      const output = [
        'hushbox-34\t/home/user/worktrees/feature-a',
        'malformed-line',
        '\t',
        'hushbox-51\t/home/user/worktrees/feature-b',
      ].join('\n');

      expect(parseDockerProjects(output)).toEqual([
        { projectName: 'hushbox-34', workingDir: '/home/user/worktrees/feature-a' },
        { projectName: 'hushbox-51', workingDir: '/home/user/worktrees/feature-b' },
      ]);
    });
  });

  describe('findOrphanedProjects', () => {
    const projects: DockerComposeProject[] = [
      { projectName: 'hushbox-34', workingDir: '/home/user/worktrees/feature-a' },
      { projectName: 'hushbox-51', workingDir: '/home/user/worktrees/feature-b' },
      { projectName: 'hushbox-73', workingDir: '/home/user/worktrees/feature-c' },
    ];

    it('returns empty when all projects have matching worktrees', () => {
      const activePaths = [
        '/home/user/project',
        '/home/user/worktrees/feature-a',
        '/home/user/worktrees/feature-b',
        '/home/user/worktrees/feature-c',
      ];

      expect(findOrphanedProjects(projects, activePaths)).toEqual([]);
    });

    it('returns orphaned projects whose workingDir is missing from active paths', () => {
      const activePaths = ['/home/user/project', '/home/user/worktrees/feature-c'];

      expect(findOrphanedProjects(projects, activePaths)).toEqual([
        { projectName: 'hushbox-34', workingDir: '/home/user/worktrees/feature-a' },
        { projectName: 'hushbox-51', workingDir: '/home/user/worktrees/feature-b' },
      ]);
    });

    it('returns all projects when no paths match', () => {
      const activePaths = ['/home/user/project'];

      expect(findOrphanedProjects(projects, activePaths)).toEqual(projects);
    });

    it('returns empty when given empty project list', () => {
      expect(findOrphanedProjects([], ['/home/user/project'])).toEqual([]);
    });

    it('returns all projects when active paths list is empty', () => {
      expect(findOrphanedProjects(projects, [])).toEqual(projects);
    });

    it('matches Windows-style backslash paths against forward-slash worktree paths', () => {
      const windowsProjects: DockerComposeProject[] = [
        {
          projectName: 'hushbox-34',
          workingDir: String.raw`C:\Users\dev\repo\worktrees\feature-a`,
        },
      ];
      const activePaths = ['C:/Users/dev/repo/worktrees/feature-a'];
      expect(findOrphanedProjects(windowsProjects, activePaths)).toEqual([]);
    });

    it('matches when drive letter case differs', () => {
      const windowsProjects: DockerComposeProject[] = [
        { projectName: 'hushbox-34', workingDir: 'C:/Users/dev/repo' },
      ];
      const activePaths = ['c:/Users/dev/repo'];
      expect(findOrphanedProjects(windowsProjects, activePaths)).toEqual([]);
    });

    it('does not treat unrelated paths as equal even after normalization', () => {
      const windowsProjects: DockerComposeProject[] = [
        {
          projectName: 'hushbox-34',
          workingDir: String.raw`C:\Users\dev\repo\worktrees\feature-a`,
        },
      ];
      const activePaths = ['C:/Users/dev/repo/worktrees/feature-b'];
      expect(findOrphanedProjects(windowsProjects, activePaths)).toEqual(windowsProjects);
    });
  });

  describe('getActiveWorktreePaths', () => {
    it('calls git worktree list --porcelain via execa', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: 'worktree /home/user/project\nHEAD abc\nbranch refs/heads/main\n',
      } as never);

      const result = await getActiveWorktreePaths();

      expect(mockExeca).toHaveBeenCalledWith('git', ['worktree', 'list', '--porcelain']);
      expect(result).toEqual(['/home/user/project']);
    });
  });

  describe('getRunningDockerProjects', () => {
    it('calls docker ps with correct format and filter arguments', async () => {
      mockExeca.mockResolvedValueOnce({ stdout: 'hushbox-34\t/home/user/worktrees/a' } as never);

      await getRunningDockerProjects();

      expect(mockExeca).toHaveBeenCalledWith('docker', [
        'ps',
        '--filter',
        'label=com.docker.compose.project',
        '--format',
        '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}',
      ]);
    });

    it('returns parsed projects from output', async () => {
      mockExeca.mockResolvedValueOnce({ stdout: 'hushbox-34\t/home/user/worktrees/a' } as never);

      const result = await getRunningDockerProjects();

      expect(result).toEqual([{ projectName: 'hushbox-34', workingDir: '/home/user/worktrees/a' }]);
    });

    it('returns empty array when docker ps returns empty output', async () => {
      mockExeca.mockResolvedValueOnce({ stdout: '' } as never);

      const result = await getRunningDockerProjects();

      expect(result).toEqual([]);
    });

    it('returns empty array when docker ps fails', async () => {
      mockExeca.mockRejectedValueOnce(new Error('Docker not running'));

      const result = await getRunningDockerProjects();

      expect(result).toEqual([]);
    });
  });

  describe('removeProject', () => {
    it('calls docker compose -p <name> down with correct args', async () => {
      mockExeca.mockResolvedValueOnce({} as never);

      await removeProject('hushbox-34');

      expect(mockExeca).toHaveBeenCalledWith('docker', ['compose', '-p', 'hushbox-34', 'down'], {
        stdio: 'inherit',
      });
    });

    it('throws on failure', async () => {
      mockExeca.mockRejectedValueOnce(new Error('compose down failed'));

      await expect(removeProject('hushbox-34')).rejects.toThrow('compose down failed');
    });
  });

  describe('cleanupOrphanedProjects', () => {
    function setupMocks(worktreeOutput: string, dockerOutput: string | Error): void {
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        if (cmd === 'git') return Promise.resolve({ stdout: worktreeOutput } as never);
        if (cmd === 'docker' && Array.isArray(args) && args[0] === 'ps') {
          if (dockerOutput instanceof Error) return Promise.reject(dockerOutput);
          return Promise.resolve({ stdout: dockerOutput } as never);
        }
        // docker compose down
        return Promise.resolve({} as never);
      }) as never);
    }

    const worktreeOutput = [
      'worktree /home/user/project',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /home/user/worktrees/feature-c',
      'HEAD def',
      'branch refs/heads/feature-c',
      '',
    ].join('\n');

    const dockerOutput = [
      'hushbox-34\t/home/user/worktrees/feature-a',
      'hushbox-51\t/home/user/worktrees/feature-b',
      'hushbox-73\t/home/user/worktrees/feature-c',
    ].join('\n');

    it('finds and removes orphaned projects', async () => {
      setupMocks(worktreeOutput, dockerOutput);

      const result = await cleanupOrphanedProjects({ dryRun: false });

      expect(result.orphaned).toEqual([
        { projectName: 'hushbox-34', workingDir: '/home/user/worktrees/feature-a' },
        { projectName: 'hushbox-51', workingDir: '/home/user/worktrees/feature-b' },
      ]);
      expect(result.removed).toEqual(['hushbox-34', 'hushbox-51']);
      expect(result.failed).toEqual([]);
    });

    it('does not remove in dry-run mode', async () => {
      setupMocks(worktreeOutput, dockerOutput);

      const result = await cleanupOrphanedProjects({ dryRun: true });

      expect(result.orphaned).toHaveLength(2);
      expect(result.removed).toEqual([]);
      expect(result.failed).toEqual([]);

      const downCalls = mockExeca.mock.calls.filter(
        ([cmd, args]) => cmd === 'docker' && Array.isArray(args) && args.includes('down')
      );
      expect(downCalls).toHaveLength(0);
    });

    it('returns empty lists when no orphans found', async () => {
      const allActiveDockerOutput = 'hushbox-73\t/home/user/worktrees/feature-c';
      setupMocks(worktreeOutput, allActiveDockerOutput);

      const result = await cleanupOrphanedProjects({ dryRun: false });

      expect(result.orphaned).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.failed).toEqual([]);
    });

    it('returns empty lists when no docker projects running', async () => {
      setupMocks(worktreeOutput, '');

      const result = await cleanupOrphanedProjects({ dryRun: false });

      expect(result.orphaned).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.failed).toEqual([]);
    });

    it('continues when one removal fails and reports it in failed', async () => {
      let removeCount = 0;
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        if (cmd === 'git') return Promise.resolve({ stdout: worktreeOutput } as never);
        if (cmd === 'docker' && Array.isArray(args) && args[0] === 'ps') {
          return Promise.resolve({ stdout: dockerOutput } as never);
        }
        // docker compose down — fail the first one
        removeCount++;
        if (removeCount === 1) return Promise.reject(new Error('network error'));
        return Promise.resolve({} as never);
      }) as never);

      const result = await cleanupOrphanedProjects({ dryRun: false });

      expect(result.orphaned).toHaveLength(2);
      expect(result.removed).toEqual(['hushbox-51']);
      expect(result.failed).toEqual(['hushbox-34']);
    });

    it('returns empty lists when docker is not running', async () => {
      setupMocks(worktreeOutput, new Error('Docker not running'));

      const result = await cleanupOrphanedProjects({ dryRun: false });

      expect(result.orphaned).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.failed).toEqual([]);
    });

    describe('main', () => {
      const originalArgv = process.argv;

      afterEach(() => {
        process.argv = originalArgv;
      });

      it('passes --dry-run from argv through to cleanup', async () => {
        setupMocks(worktreeOutput, dockerOutput);
        process.argv = ['node', 'docker-cleanup.ts', '--dry-run'];

        await main();

        const composeDownCalls = mockExeca.mock.calls.filter(
          ([, args]) => Array.isArray(args) && args[0] === 'compose'
        );
        expect(composeDownCalls).toEqual([]);
      });

      it('removes orphaned projects when run without flags', async () => {
        setupMocks(worktreeOutput, dockerOutput);
        process.argv = ['node', 'docker-cleanup.ts'];

        await main();

        const composeDownCalls = mockExeca.mock.calls.filter(
          ([, args]) => Array.isArray(args) && args[0] === 'compose'
        );
        expect(composeDownCalls).toHaveLength(2);
      });
    });
  });
});
