import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { modelKeys } from '@/hooks/models/models';
import { useModelStore, DEFAULT_MODEL_ID, DEFAULT_MODEL_NAME } from '@/stores/model';
import { pickDemoTextModelEntry, seedDemoModelSelection } from './seed-model-selection';
import type { Model } from '@hushbox/shared';

function makeTextModel(overrides: Partial<Model> & { id: string; name: string }): Model {
  return {
    provider: 'demo',
    modality: 'text',
    contextLength: 128_000,
    pricing: { inputPerToken: '1000', outputPerToken: '2000' },
    capabilities: [],
    description: 'demo model',
    supportedParameters: [],
    ...overrides,
  };
}

const WEAK = makeTextModel({
  id: 'demo/weak',
  name: 'Weak',
  // Less popular ⇒ dropped from the top-50% half.
  popularityRank: 1,
  pricing: { inputPerToken: '100', outputPerToken: '200' },
});
const STRONG = makeTextModel({
  id: 'demo/strong',
  name: 'Strong',
  // Most popular ⇒ the sole model in the top-50% half, so it derives as Strongest.
  popularityRank: 0,
  pricing: { inputPerToken: '10000', outputPerToken: '20000' },
});

function resetToSmartModelDefault(): void {
  useModelStore.setState({
    selections: {
      text: [{ id: DEFAULT_MODEL_ID, name: DEFAULT_MODEL_NAME }],
      image: [],
      audio: [],
      video: [],
    },
  });
}

beforeEach(() => {
  resetToSmartModelDefault();
});

describe('pickDemoTextModelEntry', () => {
  it('returns the strongest accessible text model as an {id,name} entry', () => {
    expect(pickDemoTextModelEntry([WEAK, STRONG], new Set())).toEqual({
      id: 'demo/strong',
      name: 'Strong',
    });
  });

  it('returns null when the catalog is empty so the Smart Model default is kept', () => {
    expect(pickDemoTextModelEntry([], new Set())).toBeNull();
  });
});

describe('seedDemoModelSelection', () => {
  it('seeds the text selection with the strongest model from the models cache', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(modelKeys.list(), {
      models: [WEAK, STRONG],
      premiumIds: new Set<string>(),
    });

    await seedDemoModelSelection(queryClient);

    expect(useModelStore.getState().selections.text).toEqual([
      { id: 'demo/strong', name: 'Strong' },
    ]);
  });

  it('leaves the Smart Model default when the catalog is empty', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(modelKeys.list(), { models: [], premiumIds: new Set<string>() });

    await seedDemoModelSelection(queryClient);

    expect(useModelStore.getState().selections.text[0]?.id).toBe(DEFAULT_MODEL_ID);
  });

  it('leaves the Smart Model default when the catalog fetch fails', async () => {
    const queryClient = new QueryClient();
    vi.spyOn(queryClient, 'fetchQuery').mockRejectedValue(new Error('offline'));

    await seedDemoModelSelection(queryClient);

    expect(useModelStore.getState().selections.text[0]?.id).toBe(DEFAULT_MODEL_ID);
  });
});
