import { describe, it, expect } from 'vitest';
import { MAX_SELECTED_MODELS, type Model, type LegacyModality } from '@hushbox/shared';
import {
  filterBySearch,
  resolveModality,
  sortModels,
  interlaceModels,
  modelSubtitle,
  expandedRowButtonLabel,
  buildModelResultList,
  getPinnedLabelForModel,
  toggleSortDirection,
  buildSelectedEntries,
  updateSelectedIds,
  initialFocusedId,
} from '@/components/chat/model-selector/model-selector-helpers';

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'm1',
    name: 'Model One',
    provider: 'Acme',
    modality: 'text',
    contextLength: 1000,
    pricePerInputToken: 1,
    pricePerOutputToken: 2,
    pricePerImage: 0,
    pricePerSecond: 0,
    pricePerSecondByResolution: {},
    ...overrides,
  } as Model;
}

describe('filterBySearch', () => {
  it('returns all models when query is blank', () => {
    const models = [makeModel({ id: 'a' }), makeModel({ id: 'b' })];
    expect(filterBySearch(models, '   ')).toEqual(models);
  });

  it('matches on model name case-insensitively', () => {
    const models = [makeModel({ id: 'a', name: 'GPT-4o' }), makeModel({ id: 'b', name: 'Claude' })];
    expect(filterBySearch(models, 'gpt')).toEqual([models[0]]);
  });

  it('matches on provider', () => {
    const models = [
      makeModel({ id: 'a', provider: 'OpenAI' }),
      makeModel({ id: 'b', provider: 'Anthropic' }),
    ];
    expect(filterBySearch(models, 'anthropic')).toEqual([models[1]]);
  });
});

describe('resolveModality', () => {
  it('defaults to text when modality is absent', () => {
    const absent: LegacyModality | undefined = undefined;
    expect(resolveModality(absent)).toBe('text');
  });

  it('returns the provided modality', () => {
    expect(resolveModality('image')).toBe('image');
  });
});

describe('sortModels', () => {
  it('returns input unchanged when no sort field', () => {
    const models = [makeModel({ id: 'a' }), makeModel({ id: 'b' })];
    expect(sortModels(models, null, 'asc', 'text')).toBe(models);
  });

  it('sorts by text price ascending', () => {
    const models = [
      makeModel({ id: 'a', pricePerInputToken: 5 }),
      makeModel({ id: 'b', pricePerInputToken: 1 }),
    ];
    expect(sortModels(models, 'price', 'asc', 'text').map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('sorts by context descending', () => {
    const models = [
      makeModel({ id: 'a', contextLength: 100 }),
      makeModel({ id: 'b', contextLength: 900 }),
    ];
    expect(sortModels(models, 'context', 'desc', 'text').map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('sorts image models by per-image price', () => {
    const models = [
      makeModel({ id: 'a', modality: 'image', pricePerImage: 5 }),
      makeModel({ id: 'b', modality: 'image', pricePerImage: 1 }),
    ];
    expect(sortModels(models, 'price', 'asc', 'image').map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('sorts video models by their cheapest per-second price', () => {
    const models = [
      makeModel({ id: 'a', modality: 'video', pricePerSecondByResolution: { '720p': 5 } }),
      makeModel({ id: 'b', modality: 'video', pricePerSecondByResolution: { '720p': 1 } }),
    ];
    expect(sortModels(models, 'price', 'asc', 'video').map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('treats video models with no resolution prices as zero', () => {
    const models = [
      makeModel({ id: 'a', modality: 'video', pricePerSecondByResolution: { '720p': 5 } }),
      makeModel({ id: 'b', modality: 'video', pricePerSecondByResolution: {} }),
    ];
    expect(sortModels(models, 'price', 'asc', 'video').map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('sorts audio models by per-second price', () => {
    const models = [
      makeModel({ id: 'a', modality: 'audio', pricePerSecond: 5 }),
      makeModel({ id: 'b', modality: 'audio', pricePerSecond: 1 }),
    ];
    expect(sortModels(models, 'price', 'asc', 'audio').map((m) => m.id)).toEqual(['b', 'a']);
  });
});

describe('interlaceModels', () => {
  it('returns input unchanged when premium access granted', () => {
    const models = [makeModel({ id: 'a' })];
    expect(interlaceModels(models, new Set(['a']), true)).toBe(models);
  });

  it('alternates basic and premium models when access denied', () => {
    const models = [makeModel({ id: 'b1' }), makeModel({ id: 'b2' }), makeModel({ id: 'p1' })];
    const result = interlaceModels(models, new Set(['p1']), false);
    expect(result.map((m) => m.id)).toEqual(['b1', 'p1', 'b2']);
  });
});

describe('modelSubtitle', () => {
  it('describes the smart model', () => {
    expect(modelSubtitle(makeModel({ isSmartModel: true }))).toBe('Auto-picks the best model');
  });

  it('shows provider and capacity for text models', () => {
    expect(modelSubtitle(makeModel({ provider: 'Acme', contextLength: 1000 }))).toContain('Acme •');
  });

  it('shows per-image price for image models', () => {
    expect(modelSubtitle(makeModel({ modality: 'image', pricePerImage: 0.02 }))).toBe(
      'Acme • $0.020/image'
    );
  });

  it('returns provider only for video with no resolution prices', () => {
    expect(modelSubtitle(makeModel({ modality: 'video', pricePerSecondByResolution: {} }))).toBe(
      'Acme'
    );
  });

  it('shows cheapest per-second video price', () => {
    expect(
      modelSubtitle(
        makeModel({ modality: 'video', pricePerSecondByResolution: { '720p': 0.5, '1080p': 0.9 } })
      )
    ).toBe('Acme • $0.50/s');
  });

  it('shows per-second price for audio models', () => {
    expect(modelSubtitle(makeModel({ modality: 'audio', pricePerSecond: 0.001 }))).toBe(
      'Acme • $0.001/s'
    );
  });
});

describe('expandedRowButtonLabel', () => {
  it('uses the model name in single mode', () => {
    expect(expandedRowButtonLabel('single', false, 'GPT-4o')).toContain('Use');
  });

  it('offers removal when selected in multi mode', () => {
    expect(expandedRowButtonLabel('multi', true, 'GPT-4o')).toBe('Remove from selection');
  });

  it('offers addition when unselected in multi mode', () => {
    expect(expandedRowButtonLabel('multi', false, 'GPT-4o')).toBe('Add to selection');
  });
});

describe('buildModelResultList', () => {
  it('prefixes the smart model and skips pinning when not default', () => {
    const interlaced = [makeModel({ id: 'a' })];
    const smart = makeModel({ id: 'smart', isSmartModel: true });
    const result = buildModelResultList({
      interlaced,
      smartModel: smart,
      strongestId: 'a',
      valueId: 'a',
      isDefault: false,
    });
    expect(result.map((m) => m.id)).toEqual(['smart', 'a']);
  });

  it('orders pinned models first in default view', () => {
    const interlaced = [
      makeModel({ id: 'other' }),
      makeModel({ id: 'strong' }),
      makeModel({ id: 'value' }),
    ];
    const result = buildModelResultList({
      interlaced,
      smartModel: undefined,
      strongestId: 'strong',
      valueId: 'value',
      isDefault: true,
    });
    expect(result.map((m) => m.id)).toEqual(['strong', 'value', 'other']);
  });
});

describe('getPinnedLabelForModel', () => {
  it('labels the strongest model', () => {
    expect(getPinnedLabelForModel('s', 's', 'v')).toBe('Strongest');
  });

  it('labels the value model', () => {
    expect(getPinnedLabelForModel('v', 's', 'v')).toBe('Best value');
  });

  it('returns undefined for unpinned models', () => {
    expect(getPinnedLabelForModel('x', 's', 'v')).toBeUndefined();
  });
});

describe('toggleSortDirection', () => {
  it('flips asc to desc', () => {
    expect(toggleSortDirection('asc')).toBe('desc');
  });

  it('flips desc to asc', () => {
    expect(toggleSortDirection('desc')).toBe('asc');
  });
});

describe('buildSelectedEntries', () => {
  it('maps selected ids to id/name entries, dropping unknown ids', () => {
    const models = [makeModel({ id: 'a', name: 'Alpha' })];
    expect(buildSelectedEntries(new Set(['a', 'missing']), models)).toEqual([
      { id: 'a', name: 'Alpha' },
    ]);
  });
});

describe('updateSelectedIds', () => {
  it('adds a missing id', () => {
    expect([...updateSelectedIds(new Set(), 'a')]).toEqual(['a']);
  });

  it('removes a present id', () => {
    expect([...updateSelectedIds(new Set(['a']), 'a')]).toEqual([]);
  });

  it('rejects additions past the max and returns the same reference', () => {
    const full = new Set(
      Array.from({ length: MAX_SELECTED_MODELS }, (_, index) => `m${String(index)}`)
    );
    expect(updateSelectedIds(full, 'overflow')).toBe(full);
  });
});

describe('initialFocusedId', () => {
  it('returns the first selected id when present', () => {
    expect(initialFocusedId(new Set(['sel']), [makeModel({ id: 'a' })])).toBe('sel');
  });

  it('falls back to the first model id', () => {
    expect(initialFocusedId(new Set(), [makeModel({ id: 'a' })])).toBe('a');
  });

  it('returns empty string when there are no models', () => {
    expect(initialFocusedId(new Set(), [])).toBe('');
  });
});
