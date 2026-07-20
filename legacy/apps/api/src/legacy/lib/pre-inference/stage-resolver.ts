import { SMART_MODEL_ID, type LegacyModality } from '@hushbox/shared';

import { createSmartModelStage, type SmartModelStageConfig } from './smart-model-stage.js';
import type { PreInferenceStage } from './types.js';

export interface SlotStageContext {
  modality: LegacyModality;
  /** The model the user selected for this slot (e.g., 'smart-model' or a real id). */
  selectedModelId: string;
  /**
   * Resolution computed by `resolveAndReserveBilling` when SMART_MODEL_ID
   * appears in the models array. Absent when the user didn't pick Smart Model
   * for any slot, or when the billing layer couldn't fit even the cheapest
   * eligible model + classifier overhead in the user's budget (in which case
   * the request was already denied with 402 INSUFFICIENT_BALANCE).
   */
  smartModelResolution?: SmartModelStageConfig;
}

/**
 * Resolve the chain of pre-inference stages that run before the main
 * inference call for a single slot in the parallel multi-model set.
 *
 * Today only Smart Model attaches a stage; future stages (prompt enhancer for
 * image, history compressor for very long text conversations, aspect inferer,
 * safety pre-check, search distiller) plug in here without touching the
 * pipeline.
 *
 * Single source of truth for "which stages apply for which (modality,
 * selection) combination". Pipeline iterates the returned chain via
 * `executePreInferenceChain` and never inspects the conditions itself.
 */
export function resolveStagesForSlot(ctx: SlotStageContext): PreInferenceStage[] {
  const stages: PreInferenceStage[] = [];

  if (
    ctx.modality === 'text' &&
    ctx.selectedModelId === SMART_MODEL_ID &&
    ctx.smartModelResolution !== undefined
  ) {
    stages.push(createSmartModelStage(ctx.smartModelResolution));
  }

  return stages;
}
