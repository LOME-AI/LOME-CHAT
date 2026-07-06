import { err, ok } from '../../../lib/result/index.js';
import type { Result } from '../../../lib/result/index.js';
import type { ValueNode } from '../compile/context.js';
import type {
  EngineExecutionRegistry,
  NodeBillingMetadata,
  NodeRunContext,
  NodeRunError,
  NodeRunSuccess,
  RegisteredPredicate as PredicateFunction,
  RegisteredReducer as ReducerFunction,
} from './execution-registry.js';

/**
 * Shared execution doubles for the engine suite — not production wiring.
 * Behaviors are keyed by the same model/transform/ref vocabulary the compile
 * fakes pin, so one definition drives both the compile and run legs of a
 * test.
 */

export interface FakeBehavior {
  readonly streaming?: boolean;
  readonly run: (
    input: readonly unknown[],
    ctx: NodeRunContext
  ) => Promise<Result<NodeRunSuccess, NodeRunError>>;
}

export interface FakeExecutionOptions {
  readonly behaviors: Readonly<Record<string, FakeBehavior>>;
  readonly predicates?: Readonly<Record<string, PredicateFunction>>;
  readonly reducers?: Readonly<Record<string, ReducerFunction>>;
}

function behaviorNameOf(node: ValueNode): string {
  if (node.type === 'modelCall') return node.model;
  if (node.type === 'transform') return node.transform;
  return node.ref;
}

export function makeFakeExecutionRegistry(options: FakeExecutionOptions): EngineExecutionRegistry {
  return {
    resolveExecution: (node) => {
      const behavior = options.behaviors[behaviorNameOf(node)];
      if (behavior === undefined) return;
      return {
        streaming: behavior.streaming ?? false,
        run: (_node, input, ctx) => behavior.run(input, ctx),
      };
    },
    resolvePredicate: (name) => options.predicates?.[name],
    resolveReducer: (name) => options.reducers?.[name],
  };
}

/**
 * A modelCall's per-generation billing facts, so a fake can thread the real
 * fact flow through to `SettlementRequest.charges`. Omit to model a
 * transform/control node, which carries no billable generation.
 */
function successOf(
  value: unknown,
  costNanoUsd: bigint,
  billing?: NodeBillingMetadata
): NodeRunSuccess {
  return { value, costNanoUsd, ...(billing === undefined ? {} : { billing }) };
}

/** Resolves immediately with a fixed value. */
export function respondWith(
  value: unknown,
  costNanoUsd = 0n,
  billing?: NodeBillingMetadata
): FakeBehavior {
  return {
    run: () => Promise.resolve(ok(successOf(value, costNanoUsd, billing))),
  };
}

/** Fails immediately; optional spend still accrues toward the circuit. */
export function failWith(costNanoUsd?: bigint): FakeBehavior {
  return {
    run: () => Promise.resolve(err(costNanoUsd === undefined ? {} : { costNanoUsd })),
  };
}

/** Streams `echo:<input>` as one delta per character, then resolves it. */
export function streamingEcho(costNanoUsd = 0n, billing?: NodeBillingMetadata): FakeBehavior {
  return {
    streaming: true,
    run: (input, ctx) => {
      const value = `echo:${String(input[0])}`;
      for (let index = 0; index < value.length; index += 1) {
        ctx.emit?.({ kind: 'text-delta', index, content: value.charAt(index) });
      }
      return Promise.resolve(ok(successOf(value, costNanoUsd, billing)));
    },
  };
}

function abortedOnce(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        resolve();
      },
      { once: true }
    );
  });
}

export interface HangingBehavior extends FakeBehavior {
  /** Resolves once the node has emitted its prefix and is awaiting abort. */
  readonly hanging: Promise<void>;
}

/**
 * Builds a streaming behavior that hangs until the run signal aborts, then
 * settles with `outcome`; `hanging` resolves once the hang begins.
 */
function hangingBehavior(
  outcome: (ctx: NodeRunContext) => Result<NodeRunSuccess, NodeRunError>
): HangingBehavior {
  // The behavior runs only after construction, so the assignment precedes use.
  let markHanging!: () => void;
  const hanging = new Promise<void>((resolve) => {
    markHanging = resolve;
  });
  return {
    streaming: true,
    hanging,
    run: async (_input, ctx) => {
      markHanging();
      await abortedOnce(ctx.signal);
      return outcome(ctx);
    },
  };
}

/**
 * Emits a partial, then hangs until the run signal aborts and resolves the
 * partial as its (billable) value — the deadline-with-partial shape.
 */
export function streamThenHang(
  partial: string,
  costNanoUsd = 0n,
  billing?: NodeBillingMetadata
): HangingBehavior {
  const behavior = hangingBehavior(() => ok(successOf(partial, costNanoUsd, billing)));
  return {
    ...behavior,
    run: (input, ctx) => {
      ctx.emit?.({ kind: 'text-delta', index: 0, content: partial });
      return behavior.run(input, ctx);
    },
  };
}

/** Produces nothing: hangs until abort, then fails with zero spend. */
export function hangThenFail(): HangingBehavior {
  return hangingBehavior(() => err({}));
}
