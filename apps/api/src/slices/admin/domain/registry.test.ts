import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { okAsync } from '../../../lib/result/index.js';
import { createAdminOpRegistry, defineAdminOp } from './registry.js';
import type { AdminOpContract, AnyAdminOpContract } from '@hushbox/shared';
import type { AdminOpImplementation, AdminOpRegistry } from './registry.js';

const reason = z.string().trim().min(1);

interface TestDeps {
  readonly log: string[];
}

function contract(
  name: `${string}.${string}`,
  overrides: Partial<AdminOpContract> = {}
): AdminOpContract {
  // Built as a raw literal (not defineAdminOpContract) so registry tests can
  // craft shapes the shared constructor would refuse.
  return {
    name,
    title: name,
    kind: 'mutation',
    input: z.object({ targetId: z.uuid(), reason }),
    inverse: null,
    effectClass: 'ephemeral',
    ...overrides,
  };
}

function implementationOf(opContract: AdminOpContract): AdminOpImplementation<TestDeps> {
  return defineAdminOp(opContract, {
    execute: (ctx) => {
      ctx.deps.log.push(opContract.name);
      return okAsync({ effects: [{ label: opContract.name }] });
    },
  });
}

describe('createAdminOpRegistry', () => {
  it('rejects a durable mutation whose inverse is not registered (Iron Law)', () => {
    const durable = contract('fixture.mark', { inverse: 'fixture.unmark', effectClass: 'durable' });

    expect(() => createAdminOpRegistry<TestDeps>([implementationOf(durable)])).toThrow(
      /fixture\.mark.*fixture\.unmark.*not registered/
    );
  });

  it('rejects a durable mutation carrying no inverse name at all', () => {
    const lawless = contract('fixture.lawless', { effectClass: 'durable', inverse: null });

    expect(() => createAdminOpRegistry<TestDeps>([implementationOf(lawless)])).toThrow(
      /fixture\.lawless.*inverse/
    );
  });

  it('accepts a durable pair registered together', () => {
    const mark = contract('fixture.mark', { inverse: 'fixture.unmark', effectClass: 'durable' });
    const unmark = contract('fixture.unmark', { inverse: 'fixture.mark', effectClass: 'durable' });

    const registry = createAdminOpRegistry<TestDeps>([
      implementationOf(mark),
      implementationOf(unmark),
    ]);

    expect(registry.get('fixture.mark')?.contract.name).toBe('fixture.mark');
    expect(registry.get('fixture.unmark')?.contract.name).toBe('fixture.unmark');
  });

  it('accepts an ephemeral op registered alone', () => {
    const ping = contract('fixture.ping');

    const registry = createAdminOpRegistry<TestDeps>([implementationOf(ping)]);

    expect(registry.get('fixture.ping')?.contract.effectClass).toBe('ephemeral');
  });

  it('rejects a duplicate op name', () => {
    const ping = contract('fixture.ping');

    expect(() =>
      createAdminOpRegistry<TestDeps>([implementationOf(ping), implementationOf(ping)])
    ).toThrow(/duplicate.*fixture\.ping/);
  });

  it('returns undefined for an unknown op name', () => {
    const registry = createAdminOpRegistry<TestDeps>([implementationOf(contract('fixture.ping'))]);

    expect(registry.get('fixture.unknown')).toBeUndefined();
  });

  it('rejects a structural impostor registry at the type level (brand mints only here)', () => {
    const impostor = {
      get: (): AdminOpImplementation<TestDeps> | undefined => undefined,
      list: (): readonly AnyAdminOpContract[] => [],
    };
    // @ts-expect-error — a hand-built { get, list } lacks the registry brand; only createAdminOpRegistry (the Iron Law gate) produces AdminOpRegistry
    const branded: AdminOpRegistry<TestDeps> = impostor;

    expect(branded.list()).toEqual([]);
  });

  it('lists every registered contract sorted by name', () => {
    const registry = createAdminOpRegistry<TestDeps>([
      implementationOf(contract('fixture.zeta')),
      implementationOf(contract('fixture.alpha')),
    ]);

    expect(registry.list().map((entry) => entry.name)).toEqual(['fixture.alpha', 'fixture.zeta']);
  });
});
