import { describe, expect, it } from 'vitest';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { runUndoRoundTrip } from './undo-round-trip.js';
import type { AdminOpEngine, AdminOpRunResult, RunAdminOpParams } from './engine.js';
import type { UndoRoundTripHarness } from './undo-round-trip.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { AnyAdminOpContract } from '@hushbox/shared';

/**
 * Unit coverage for the error and success arms of `runUndoRoundTrip` using a
 * fake engine — the integration test proves the real round-trip against DB ops,
 * but the throw branches (no inverse, execute error, missing inverseInput, undo
 * error) are unit-exercised here with stubbed engine results.
 */

const CONTRACT = { name: 'fixture.op', inverse: 'fixture.undo' } as unknown as AnyAdminOpContract;
const READONLY_CONTRACT = { name: 'fixture.read', inverse: null } as unknown as AnyAdminOpContract;
const CONFLICT: DomainError = { code: 'conflict', message: 'boom' };

function runResult(over: Partial<AdminOpRunResult> = {}): AdminOpRunResult {
  return { auditId: 'audit-1', effects: [], inverseInput: { restore: 1 }, ...over };
}

function fakeEngine(runs: readonly ReturnType<AdminOpEngine['run']>[]): {
  readonly engine: AdminOpEngine;
  readonly calls: RunAdminOpParams[];
} {
  const calls: RunAdminOpParams[] = [];
  let index = 0;
  const engine: AdminOpEngine = {
    run: (params) => {
      calls.push(params);
      const next = runs[index];
      index += 1;
      if (next === undefined) throw new Error('fakeEngine: unexpected extra run() call');
      return next;
    },
  };
  return { engine, calls };
}

function harness(engine: AdminOpEngine, projections: readonly unknown[]): UndoRoundTripHarness {
  let index = 0;
  return {
    engine,
    actor: 'admin@example.com',
    projection: () => {
      const value = projections[index];
      index += 1;
      return Promise.resolve(value);
    },
  };
}

describe('runUndoRoundTrip', () => {
  it('reports restored=true when the post-undo projection equals the baseline', async () => {
    const { engine, calls } = fakeEngine([okAsync(runResult()), okAsync(runResult())]);
    const result = await runUndoRoundTrip(
      harness(engine, [{ s: 0 }, { s: 1 }, { s: 0 }]),
      CONTRACT,
      {
        x: 1,
      }
    );

    expect(result.restored).toBe(true);
    expect(result.baseline).toEqual({ s: 0 });
    expect(result.afterExecute).toEqual({ s: 1 });
    // execute then undo, with the inverse threaded through undoes + inverseInput
    expect(calls).toHaveLength(2);
    expect(calls[0]?.mode).toBe('execute');
    expect(calls[1]?.name).toBe('fixture.undo');
    expect(calls[1]?.undoes).toBe('audit-1');
    expect(calls[1]?.input).toEqual({ restore: 1 });
  });

  it('reports restored=false when the post-undo projection differs from the baseline', async () => {
    const { engine } = fakeEngine([okAsync(runResult()), okAsync(runResult())]);
    const result = await runUndoRoundTrip(
      harness(engine, [{ s: 0 }, { s: 1 }, { s: 9 }]),
      CONTRACT,
      {}
    );

    expect(result.restored).toBe(false);
  });

  it('throws when the contract is not durable-invertible (null inverse)', async () => {
    const { engine } = fakeEngine([]);
    await expect(runUndoRoundTrip(harness(engine, []), READONLY_CONTRACT, {})).rejects.toThrow(
      /not durable-invertible/
    );
  });

  it('throws when the execute run returns an error', async () => {
    const { engine } = fakeEngine([errAsync(CONFLICT)]);
    await expect(runUndoRoundTrip(harness(engine, [{ s: 0 }]), CONTRACT, {})).rejects.toThrow(
      /failed to execute: conflict/
    );
  });

  it('throws when a durable op returns no inverseInput', async () => {
    const { engine } = fakeEngine([okAsync(runResult({ inverseInput: null }))]);
    await expect(
      runUndoRoundTrip(harness(engine, [{ s: 0 }, { s: 1 }]), CONTRACT, {})
    ).rejects.toThrow(/returned no inverseInput/);
  });

  it('throws when the undo run returns an error', async () => {
    const { engine } = fakeEngine([okAsync(runResult()), errAsync(CONFLICT)]);
    await expect(
      runUndoRoundTrip(harness(engine, [{ s: 0 }, { s: 1 }]), CONTRACT, {})
    ).rejects.toThrow(/failed to undo fixture.op: conflict/);
  });
});
