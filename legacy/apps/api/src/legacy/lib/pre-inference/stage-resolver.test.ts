import { describe, expect, it } from 'vitest';
import { SMART_MODEL_ID } from '@hushbox/shared';

import { resolveStagesForSlot } from './stage-resolver.js';

const SMART_RESOLUTION = {
  classifierModelId: 'cheap/c',
  eligibleInferenceIds: ['cheap/c', 'mid/m'],
  classifierWorstCaseCents: 5,
  modelMetadataById: new Map([
    ['cheap/c', { name: 'Cheap C', description: 'cheapest' }],
    ['mid/m', { name: 'Mid M', description: 'mid' }],
  ]),
  conversationContext: { latestUserMessage: 'hi', latestAssistantMessage: '' },
};

describe('resolveStagesForSlot', () => {
  it('returns no stages for an explicit text model selection', () => {
    expect(
      resolveStagesForSlot({
        modality: 'text',
        selectedModelId: 'anthropic/claude-opus-4.6',
      })
    ).toEqual([]);
  });

  it('returns no stages for image/audio/video selections', () => {
    for (const modality of ['image', 'audio', 'video'] as const) {
      expect(
        resolveStagesForSlot({
          modality,
          selectedModelId: 'some/model',
        })
      ).toEqual([]);
    }
  });

  it('returns the Smart Model stage when text + smart-model + resolution is present', () => {
    const stages = resolveStagesForSlot({
      modality: 'text',
      selectedModelId: SMART_MODEL_ID,
      smartModelResolution: SMART_RESOLUTION,
    });
    expect(stages).toHaveLength(1);
    expect(stages[0]?.id).toBe('smart-model');
    expect(stages[0]?.reserveCents()).toBe(5);
  });

  it('returns no Smart Model stage when smart-model is selected but no resolution was prepared', () => {
    expect(
      resolveStagesForSlot({
        modality: 'text',
        selectedModelId: SMART_MODEL_ID,
      })
    ).toEqual([]);
  });

  it('does not attach Smart Model to non-text modalities even when resolution is supplied', () => {
    expect(
      resolveStagesForSlot({
        modality: 'image',
        selectedModelId: SMART_MODEL_ID,
        smartModelResolution: SMART_RESOLUTION,
      })
    ).toEqual([]);
  });
});
