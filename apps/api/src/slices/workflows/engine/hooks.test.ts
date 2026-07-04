import { describe, expect, it } from 'vitest';
import { circuitReadoutOf } from './hooks.js';

describe('circuitReadoutOf', () => {
  it('returns the readout carried by an engine-grade admission grant', () => {
    const circuit = {
      estimateNanoUsd: 100n,
      costCircuitMultiplier: 5n,
      costCircuitLimitNanoUsd: 500n,
    };
    expect(circuitReadoutOf({ admitted: true, holdRef: 'hold-1', circuit })).toEqual(circuit);
  });

  it('returns undefined when the grant carries no readout', () => {
    expect(circuitReadoutOf({ admitted: true, holdRef: 'hold-1' })).toBeUndefined();
  });

  it('returns undefined when the readout fields are not bigint amounts', () => {
    const grant = {
      admitted: true as const,
      holdRef: 'hold-1',
      circuit: {
        estimateNanoUsd: 100,
        costCircuitMultiplier: 5,
        costCircuitLimitNanoUsd: 500,
      },
    };
    expect(circuitReadoutOf(grant)).toBeUndefined();
  });
});
