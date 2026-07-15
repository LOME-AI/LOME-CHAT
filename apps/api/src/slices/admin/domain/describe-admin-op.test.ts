import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { conflictError, validationError } from '../../../lib/errors/index.js';
import { err, ok } from '../../../lib/result/index.js';
import {
  ephemeralProbes,
  requiredInverse,
  requiredInverseInput,
  runSeededActions,
  seededRng,
  winnerOfConcurrentRace,
} from './describe-admin-op.js';
import type { AdminOpContract } from '@hushbox/shared';
import type { AdminOpHarnessInstance } from './describe-admin-op.js';
import type { AdminOpRunResult } from './engine.js';

function contractWithInverse(inverse: `${string}.${string}` | null): AdminOpContract {
  return {
    name: 'fixture.guarded',
    title: 'Guarded',
    kind: 'mutation',
    input: z.object({}),
    inverse,
    effectClass: inverse === null ? 'ephemeral' : 'durable',
  };
}

function resultWithInverseInput(inverseInput: Record<string, unknown> | null): AdminOpRunResult {
  return { auditId: crypto.randomUUID(), effects: [], inverseInput };
}

describe('describeAdminOp guard helpers', () => {
  it('requiredInverse returns the registered inverse name', () => {
    expect(requiredInverse(contractWithInverse('fixture.undo'))).toBe('fixture.undo');
  });

  it('requiredInverse throws on a contract without an inverse', () => {
    expect(() => requiredInverse(contractWithInverse(null))).toThrow(/without an inverse/);
  });

  it('requiredInverseInput returns the stored inverse input', () => {
    const inverseInput = { targetId: 'x' };

    expect(requiredInverseInput(resultWithInverseInput(inverseInput))).toBe(inverseInput);
  });

  it('requiredInverseInput throws when the op stored none', () => {
    expect(() => requiredInverseInput(resultWithInverseInput(null))).toThrow(/no inverseInput/);
  });

  it('ephemeralProbes throws when the harness carries no probes', () => {
    const harness = { ephemeral: undefined } as unknown as AdminOpHarnessInstance;

    expect(() => ephemeralProbes(harness)).toThrow(/harness\.ephemeral/);
  });

  it('ephemeralProbes returns the harness probes when present', () => {
    const probes = { log: (): readonly string[] => [], armFailure: (): void => undefined };
    const harness = { ephemeral: probes } as unknown as AdminOpHarnessInstance;

    expect(ephemeralProbes(harness)).toBe(probes);
  });

  it('runSeededActions throws on an empty action set', async () => {
    const harness = {} as unknown as AdminOpHarnessInstance;

    await expect(
      runSeededActions(
        harness,
        { seeds: [1], stepsPerSeed: 1, opInput: () => ({}), actions: [] },
        seededRng(1)
      )
    ).rejects.toThrow(/at least one action/);
  });

  it('winnerOfConcurrentRace throws when nothing committed', () => {
    expect(() => winnerOfConcurrentRace([err(conflictError('in progress'))])).toThrow(
      /committed nothing/
    );
  });

  it('winnerOfConcurrentRace fails the battery on a non-conflict loser', () => {
    expect(() => winnerOfConcurrentRace([err(validationError('wrong'))])).toThrow();
  });

  it('winnerOfConcurrentRace returns the winner and requires a replay to match it', () => {
    const winner = resultWithInverseInput(null);

    expect(winnerOfConcurrentRace([ok(winner), err(conflictError('in progress'))])).toBe(winner);
    expect(winnerOfConcurrentRace([ok(winner), ok({ ...winner })])).toBe(winner);
  });
});
