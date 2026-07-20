import type { InferenceTransformation, PreInferenceOutcome, StageId } from '@hushbox/shared';

import type { AIClient } from '../../services/ai/index.js';
import type { SSEEventWriter } from '../stream-handler.js';

/**
 * Arguments passed to a stage's `run` method by the executor.
 *
 * `upstream` carries the cumulative transformation produced by earlier stages
 * in the same chain. Stages should treat it as read-only context — it never
 * mutates between calls. The executor merges each stage's returned
 * transformation into `upstream` before invoking the next stage.
 */
export interface PreInferenceRunArgs {
  aiClient: AIClient;
  writer: SSEEventWriter;
  /** The slot's assistantMessageId. Stages tag their SSE events with this. */
  assistantMessageId: string;
  /** Cumulative transformation from earlier stages in the same chain. */
  upstream: InferenceTransformation;
}

/**
 * A pre-inference processing stage. Implementations may transform the
 * inference request (resolved model, rewritten prompt, compressed messages),
 * make their own billable LLM calls, and emit SSE events to surface progress
 * to the user.
 *
 * Implementations live in `apps/api/src/lib/pre-inference/` and are wired
 * into a slot's chain by `resolveStagesForSlot`.
 *
 * @see executePreInferenceChain — orchestrates a list of stages
 * @see SmartModelStage — the first concrete implementation
 */
export interface PreInferenceStage {
  /** Stable id — surfaces in SSE events, billing breadcrumbs, error logs. */
  readonly id: StageId;

  /**
   * Worst-case cents the stage may incur, with fees applied. Returns 0 for
   * stages that don't make billable LLM calls (pure transforms). The host
   * sums this across all stages in all slots when reserving budget.
   */
  reserveCents(): number;

  /**
   * Execute the stage. Emits its own SSE events. Returns either a
   * transformation with optional billing breadcrumb (success), or an error
   * code that tells the executor to abort the chain.
   *
   * On failure, the host marks the slot failed and emits a `model:error`
   * SSE event; sibling slots in the parallel multi-model set continue.
   */
  run(args: PreInferenceRunArgs): Promise<PreInferenceOutcome>;
}
