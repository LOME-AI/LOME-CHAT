/* eslint-disable @typescript-eslint/require-await -- mock callbacks need to be async to satisfy the dep contract's Promise return shape; vitest fixture, not real async code */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureStack, type EnsureStackDeps, type EnsureStackOptions } from './ensure-stack.js';

let workDir = '';

const SLOT = 7;

function makeDeps(overrides: Partial<EnsureStackDeps> = {}): EnsureStackDeps {
  return {
    touchHeartbeat: vi.fn(async () => {}),
    generateEnvFiles: vi.fn(),
    installDeps: vi.fn(async () => {}),
    cleanupOrphans: vi.fn(async () => {}),
    ensureContainersHealthy: vi.fn(async () => {}),
    runMigrations: vi.fn(async () => {}),
    installDevTracking: vi.fn(async () => {}),
    provisionAdminSqlPanelRole: vi.fn(async () => {}),
    readMeta: vi.fn().mockResolvedValue({ seedHash: '', seededAt: null, dirty: true }),
    markClean: vi.fn(async () => {}),
    composeDown: vi.fn(async () => {}),
    ensureDaemonRunning: vi.fn(async () => {}),
    readDepsHash: vi.fn().mockResolvedValue(null),
    writeDepsHash: vi.fn(async () => {}),
    computeDepsFingerprint: vi.fn().mockResolvedValue('deps-fp'),
    computeMigrationFingerprint: vi.fn().mockResolvedValue('mig-fp'),
    sqlExecutor: { exec: vi.fn(), query: vi.fn() },
    ...overrides,
  };
}

function makeOptions(overrides: Partial<EnsureStackOptions> = {}): EnsureStackOptions {
  return {
    repoRoot: workDir,
    slot: SLOT,
    daemonScriptPath: '/fake/daemon.ts',
    idleTtlMs: 3_600_000,
    idleDaemonPort: 7707,
    ...overrides,
  };
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'hb-ensure-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('ensureStack', () => {
  it('ticks the heartbeat first, before any other step', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      touchHeartbeat: vi.fn(async () => {
        order.push('touchHeartbeat');
      }),
      generateEnvFiles: vi.fn(() => {
        order.push('generateEnvFiles');
      }),
      ensureContainersHealthy: vi.fn(async () => {
        order.push('ensureContainersHealthy');
      }),
    });
    await ensureStack(makeOptions(), deps);
    expect(order[0]).toBe('touchHeartbeat');
  });

  it('regenerates env files always (cheap, sub-100ms)', async () => {
    const deps = makeDeps();
    await ensureStack(makeOptions(), deps);
    expect(deps.generateEnvFiles).toHaveBeenCalledWith(workDir);
  });

  it('runs installDeps when pnpm-lock fingerprint differs from cached', async () => {
    const deps = makeDeps({
      computeDepsFingerprint: vi.fn().mockResolvedValue('new-fp'),
      readDepsHash: vi.fn().mockResolvedValue('old-fp'),
    });
    await ensureStack(makeOptions(), deps);
    expect(deps.installDeps).toHaveBeenCalledWith(workDir);
    expect(deps.writeDepsHash).toHaveBeenCalledWith(expect.any(String), 'new-fp');
  });

  it('skips installDeps when fingerprint matches the cached value', async () => {
    const deps = makeDeps({
      computeDepsFingerprint: vi.fn().mockResolvedValue('same-fp'),
      readDepsHash: vi.fn().mockResolvedValue('same-fp'),
    });
    await ensureStack(makeOptions(), deps);
    expect(deps.installDeps).not.toHaveBeenCalled();
    expect(deps.writeDepsHash).not.toHaveBeenCalled();
  });

  it('always ensures containers are healthy (idempotent for the helper)', async () => {
    const deps = makeDeps();
    await ensureStack(makeOptions(), deps);
    expect(deps.ensureContainersHealthy).toHaveBeenCalled();
  });

  it('runs migrations when current fingerprint differs from stored seed_hash', async () => {
    const deps = makeDeps({
      computeMigrationFingerprint: vi.fn().mockResolvedValue('mig-fp-new'),
      readMeta: vi.fn().mockResolvedValue({
        seedHash: 'old:any',
        seededAt: new Date(),
        dirty: false,
      }),
    });
    await ensureStack(makeOptions(), deps);
    expect(deps.runMigrations).toHaveBeenCalled();
  });

  it('records the migration fingerprint in the meta row after migrating', async () => {
    const deps = makeDeps();
    await ensureStack(makeOptions(), deps);
    expect(deps.markClean).toHaveBeenCalledWith(expect.anything(), 'mig-fp');
  });

  it('provisions the admin SQL panel LOGIN role after migrating', async () => {
    const deps = makeDeps();
    await ensureStack(makeOptions(), deps);
    expect(deps.provisionAdminSqlPanelRole).toHaveBeenCalledWith(deps.sqlExecutor);
  });

  it('provisions the admin SQL panel LOGIN role even on the migration hot path', async () => {
    // The migration creates the role NOLOGIN; local LOGIN provisioning is
    // dev-only and must survive a DB that was migrated by another path
    // (e.g. a bare db:migrate) — so it runs on every ensure, not only when
    // migrations do.
    const deps = makeDeps({
      readMeta: vi.fn().mockResolvedValue({
        seedHash: 'mig-fp',
        seededAt: new Date(),
        dirty: false,
      }),
    });
    await ensureStack(makeOptions(), deps);
    expect(deps.runMigrations).not.toHaveBeenCalled();
    expect(deps.provisionAdminSqlPanelRole).toHaveBeenCalledWith(deps.sqlExecutor);
  });

  it('does not rewrite the meta row on the hot path', async () => {
    const deps = makeDeps({
      readMeta: vi.fn().mockResolvedValue({
        seedHash: 'mig-fp',
        seededAt: new Date(),
        dirty: false,
      }),
    });
    await ensureStack(makeOptions(), deps);
    expect(deps.markClean).not.toHaveBeenCalled();
  });

  it('treats a stored legacy composed hash (mig-fp:seed-fp) as current', async () => {
    // Local DBs written before the seed phase was retired store
    // "<migrationFp>:<seedFp>" in seed_hash; the migration portion still
    // gates the skip.
    const deps = makeDeps({
      readMeta: vi.fn().mockResolvedValue({
        seedHash: 'mig-fp:seed-fp',
        seededAt: new Date(),
        dirty: false,
      }),
    });
    await ensureStack(makeOptions(), deps);
    expect(deps.runMigrations).not.toHaveBeenCalled();
  });

  it('--wipe runs composeDown -v before everything else', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      composeDown: vi.fn(async () => {
        order.push('composeDown');
      }),
      ensureContainersHealthy: vi.fn(async () => {
        order.push('ensureContainersHealthy');
      }),
    });
    await ensureStack(makeOptions({ wipe: true }), deps);
    expect(deps.composeDown).toHaveBeenCalledWith(workDir, { volumes: true });
    expect(order.indexOf('composeDown')).toBeLessThan(order.indexOf('ensureContainersHealthy'));
  });

  it('--wipe migrates even when the meta row is current', async () => {
    const deps = makeDeps({
      readMeta: vi.fn().mockResolvedValue({
        seedHash: 'mig-fp',
        seededAt: new Date(),
        dirty: false,
      }),
    });
    await ensureStack(makeOptions({ wipe: true }), deps);
    expect(deps.runMigrations).toHaveBeenCalled();
    expect(deps.markClean).toHaveBeenCalledWith(expect.anything(), 'mig-fp');
  });

  it('installs dev-only tracking after migrations on a cold path (seededAt=null)', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      runMigrations: vi.fn(async () => {
        order.push('runMigrations');
      }),
      installDevTracking: vi.fn(async () => {
        order.push('installDevTracking');
      }),
      markClean: vi.fn(async () => {
        order.push('markClean');
      }),
      readMeta: vi.fn(async () => {
        order.push('readMeta');
        return { seedHash: '', seededAt: null, dirty: true };
      }),
    });
    await ensureStack(makeOptions(), deps);
    // Optimistic readMeta first (probe). Cold path detects seededAt=null →
    // runMigrations + installDevTracking (creates the meta row) → markClean
    // records the applied migration fingerprint.
    expect(order).toEqual(['readMeta', 'runMigrations', 'installDevTracking', 'markClean']);
  });

  it('skips runMigrations and installDevTracking on the hot path (migration fingerprint matches)', async () => {
    const deps = makeDeps({
      readMeta: vi.fn().mockResolvedValue({
        seedHash: 'mig-fp',
        seededAt: new Date(),
        dirty: false,
      }),
    });
    await ensureStack(makeOptions(), deps);
    expect(deps.runMigrations).not.toHaveBeenCalled();
    expect(deps.installDevTracking).not.toHaveBeenCalled();
  });

  it('still runs migrations when the stored migration fingerprint differs', async () => {
    const deps = makeDeps({
      computeMigrationFingerprint: vi.fn().mockResolvedValue('new-mig-fp'),
      readMeta: vi.fn().mockResolvedValue({
        seedHash: 'old-mig-fp:seed-fp',
        seededAt: new Date(),
        dirty: false,
      }),
    });
    await ensureStack(makeOptions(), deps);
    expect(deps.runMigrations).toHaveBeenCalled();
    expect(deps.installDevTracking).toHaveBeenCalled();
  });

  it('falls through to migrate when readMeta throws (table not yet created)', async () => {
    const deps = makeDeps({
      readMeta: vi
        .fn()
        .mockRejectedValueOnce(new Error('__stack_meta does not exist'))
        .mockResolvedValue({ seedHash: '', seededAt: null, dirty: true }),
    });
    await ensureStack(makeOptions(), deps);
    expect(deps.runMigrations).toHaveBeenCalled();
    expect(deps.installDevTracking).toHaveBeenCalled();
  });

  it('stringifies non-Error readMeta failures in the fall-through warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps({
      readMeta: vi
        .fn()
        .mockRejectedValueOnce('connection refused')
        .mockResolvedValue({ seedHash: '', seededAt: null, dirty: true }),
    });
    await ensureStack(makeOptions(), deps);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('connection refused'));
    warnSpy.mockRestore();
  });

  it('starts the idle daemon at the end (after all other work)', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      markClean: vi.fn(async () => {
        order.push('markClean');
      }),
      ensureDaemonRunning: vi.fn(async () => {
        order.push('ensureDaemonRunning');
      }),
    });
    await ensureStack(makeOptions(), deps);
    expect(order.indexOf('ensureDaemonRunning')).toBeGreaterThan(order.indexOf('markClean'));
  });

  it('creates the per-slot cache directory on first run', async () => {
    const deps = makeDeps();
    const options = makeOptions();
    await ensureStack(options, deps);
    const expectedDir = path.join(workDir, 'scripts', '.cache', 'local', String(SLOT));
    const stat = await import('node:fs/promises').then((m) => m.stat(expectedDir));
    expect(stat.isDirectory()).toBe(true);
  });

  it('passes the per-slot cache directory + heartbeat path to touchHeartbeat', async () => {
    const deps = makeDeps();
    await ensureStack(makeOptions(), deps);
    expect(deps.touchHeartbeat).toHaveBeenCalledWith(
      path.join(workDir, 'scripts', '.cache', 'local', String(SLOT), 'heartbeat')
    );
  });

  it('passes the right port/slot/cacheDir to ensureDaemonRunning', async () => {
    const deps = makeDeps();
    await ensureStack(makeOptions(), deps);
    const callArgument = (deps.ensureDaemonRunning as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as
      | {
          port: number;
          slot: number;
          cacheDir: string;
          ttlMs: number;
        }
      | undefined;
    expect(callArgument?.port).toBe(7707);
    expect(callArgument?.slot).toBe(SLOT);
    expect(callArgument?.cacheDir).toBe(
      path.join(workDir, 'scripts', '.cache', 'local', String(SLOT))
    );
    expect(callArgument?.ttlMs).toBe(3_600_000);
  });
});

describe('readDepsHash + writeDepsHash round-trip (file-backed defaults)', () => {
  // Smoke test for the default file-IO implementations used by ensureStack.
  it('writes a hash to <cacheDir>/deps.hash and reads it back', async () => {
    const deps = makeDeps({
      readDepsHash: vi.fn().mockImplementation(async (cacheDir: string) => {
        const file = path.join(cacheDir, 'deps.hash');
        const fsPromises = await import('node:fs/promises');
        try {
          const contents = await fsPromises.readFile(file, 'utf8');
          return contents.trim();
        } catch {
          return null;
        }
      }),
      writeDepsHash: vi.fn().mockImplementation(async (cacheDir: string, hash: string) => {
        const file = path.join(cacheDir, 'deps.hash');
        const { writeFile } = await import('node:fs/promises');
        await writeFile(file, hash);
      }),
      computeDepsFingerprint: vi.fn().mockResolvedValue('hash-A'),
    });
    const options = makeOptions();
    await ensureStack(options, deps);
    const cacheDir = path.join(workDir, 'scripts', '.cache', 'local', String(SLOT));
    const fsPromises = await import('node:fs/promises');
    const writtenRaw = await fsPromises.readFile(path.join(cacheDir, 'deps.hash'), 'utf8');
    expect(writtenRaw.trim()).toBe('hash-A');
  });

  // Verify cache file presence ensures fingerprint comparison works.
  it('keeps installDeps callable even when the deps.hash file is missing', async () => {
    // Pre-populate a stale cache dir that's empty (simulates first run)
    const cacheDir = path.join(workDir, 'scripts', '.cache', 'local', String(SLOT));
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path.join(cacheDir, 'unrelated.txt'), '');
    const deps = makeDeps();
    await ensureStack(makeOptions(), deps);
    expect(deps.installDeps).toHaveBeenCalled();
  });
});
