import type {
  AdmissionRequest,
  ErrorCode,
  FlowHoldIdentity,
  FlowHookBindings,
  SettlementHook,
} from '@hushbox/shared';

/**
 * Engine-grade policy hooks. The shared DO↔engine seam
 * (`FlowHookBindings`) carries only an opaque `holdRef` on an admission
 * grant; the cost circuit additionally needs billing's hold readout — the
 * admitted estimate, the named multiplier K, and the precomputed
 * `hold × K` limit. Engine bindings therefore extend the shared shape with
 * the readout (structurally assignable to the shared seam), and the
 * interpreter treats a grant without one as a binder defect: the engine
 * never recomputes the limit.
 */
export interface CostCircuitReadout {
  readonly estimateNanoUsd: bigint;
  readonly costCircuitMultiplier: bigint;
  readonly costCircuitLimitNanoUsd: bigint;
}

export interface EngineAdmissionGrant {
  readonly admitted: true;
  readonly holdRef: string;
  /**
   * The wallet-hold identity the grant placed (paid runs only — trial grants
   * place no hold). Rides the shared seam to the run handle's `admitted`
   * promise so the DO's terminal sink can release the hold early.
   */
  readonly hold?: FlowHoldIdentity;
  readonly circuit: CostCircuitReadout;
}

export type EngineAdmissionDecision =
  | EngineAdmissionGrant
  | { readonly admitted: false; readonly code: ErrorCode };

export type EngineAdmissionHook = (request: AdmissionRequest) => Promise<EngineAdmissionDecision>;

export interface EngineHookBindings extends FlowHookBindings {
  readonly admission: EngineAdmissionHook;
  readonly settlement: SettlementHook;
}

interface GrantLike {
  readonly admitted: true;
  readonly holdRef: string;
  readonly circuit?: unknown;
}

/**
 * Runtime narrowing for grants arriving over the shared seam: returns the
 * readout when every amount is a bigint, undefined otherwise.
 */
export function circuitReadoutOf(grant: GrantLike): CostCircuitReadout | undefined {
  const circuit: unknown = grant.circuit;
  if (typeof circuit !== 'object' || circuit === null) return undefined;
  const candidate = circuit as Partial<CostCircuitReadout>;
  if (
    typeof candidate.estimateNanoUsd === 'bigint' &&
    typeof candidate.costCircuitMultiplier === 'bigint' &&
    typeof candidate.costCircuitLimitNanoUsd === 'bigint'
  ) {
    return {
      estimateNanoUsd: candidate.estimateNanoUsd,
      costCircuitMultiplier: candidate.costCircuitMultiplier,
      costCircuitLimitNanoUsd: candidate.costCircuitLimitNanoUsd,
    };
  }
  return undefined;
}
