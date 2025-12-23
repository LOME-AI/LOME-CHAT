import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock execa before importing the module
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

// Mock generate-env to avoid file system operations in tests
vi.mock('./generate-env.js', () => ({
  generateEnvFiles: vi.fn(),
}));

import { execa } from 'execa';
import { startDocker, runMigrations, startTurbo, main, loadEnv } from './dev';

const mockExeca = vi.mocked(execa);

describe('dev script', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExeca.mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loadEnv', () => {
    it('loads environment variables from .env.development', () => {
      const env = loadEnv();
      expect(env).toBeDefined();
      expect(typeof env).toBe('object');
    });
  });

  describe('startDocker', () => {
    it('calls docker compose up with correct arguments', async () => {
      await startDocker();

      expect(mockExeca).toHaveBeenCalledWith(
        'docker',
        ['compose', 'up', '-d', '--wait', 'postgres', 'neon-proxy'],
        expect.objectContaining({
          stdio: 'inherit',
        })
      );
    });

    it('throws error when docker compose fails', async () => {
      mockExeca.mockRejectedValueOnce(new Error('Docker not running'));

      await expect(startDocker()).rejects.toThrow('Docker not running');
    });
  });

  describe('runMigrations', () => {
    it('calls pnpm db:migrate with correct arguments', async () => {
      await runMigrations();

      expect(mockExeca).toHaveBeenCalledWith(
        'pnpm',
        ['--filter', '@lome-chat/db', 'db:migrate'],
        expect.objectContaining({
          stdio: 'inherit',
        })
      );
    });

    it('throws error when migrations fail', async () => {
      mockExeca.mockRejectedValueOnce(new Error('Migration failed'));

      await expect(runMigrations()).rejects.toThrow('Migration failed');
    });
  });

  describe('startTurbo', () => {
    it('calls turbo dev with correct arguments', async () => {
      await startTurbo();

      expect(mockExeca).toHaveBeenCalledWith(
        'turbo',
        ['dev'],
        expect.objectContaining({
          stdio: 'inherit',
        })
      );
    });

    it('throws error when turbo fails', async () => {
      mockExeca.mockRejectedValueOnce(new Error('Turbo failed'));

      await expect(startTurbo()).rejects.toThrow('Turbo failed');
    });
  });

  describe('main', () => {
    it('executes steps in correct order: docker, migrations, turbo', async () => {
      const callOrder: string[] = [];

      mockExeca.mockImplementation((cmd) => {
        if (cmd === 'docker') callOrder.push('docker');
        if (cmd === 'pnpm') callOrder.push('migrations');
        if (cmd === 'turbo') callOrder.push('turbo');
        return Promise.resolve({} as never);
      });

      await main();

      expect(callOrder).toEqual(['docker', 'migrations', 'turbo']);
    });

    it('stops execution if docker fails', async () => {
      mockExeca.mockImplementation((cmd) => {
        if (cmd === 'docker') return Promise.reject(new Error('Docker failed'));
        return Promise.resolve({} as never);
      });

      await expect(main()).rejects.toThrow('Docker failed');

      // Should only have called docker, not migrations or turbo
      expect(mockExeca).toHaveBeenCalledTimes(1);
    });

    it('stops execution if migrations fail', async () => {
      let callCount = 0;
      mockExeca.mockImplementation((cmd) => {
        callCount++;
        if (cmd === 'pnpm') return Promise.reject(new Error('Migration failed'));
        return Promise.resolve({} as never);
      });

      await expect(main()).rejects.toThrow('Migration failed');

      // Should have called docker and migrations, but not turbo
      expect(callCount).toBe(2);
    });
  });
});
