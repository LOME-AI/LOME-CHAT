import { describe, it, expect } from 'vitest';
import { MAX_SELECTED_MODELS, type Model, type ChatModality } from '@hushbox/shared';
import {
  filterBySearch,
  resolveModality,
  sortModels,
  sortByPopularity,
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
    pricing: { inputPerToken: '1000000000', outputPerToken: '2000000000' },
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
    const absent: ChatModality | undefined = undefined;
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
      makeModel({ id: 'a', pricing: { inputPerToken: '5000000000' } }),
      makeModel({ id: 'b', pricing: { inputPerToken: '1000000000' } }),
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
      makeModel({ id: 'a', modality: 'image', pricing: { perImage: '5000000000' } }),
      makeModel({ id: 'b', modality: 'image', pricing: { perImage: '1000000000' } }),
    ];
    expect(sortModels(models, 'price', 'asc', 'image').map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('sorts video models by their cheapest per-second price', () => {
    const models = [
      makeModel({
        id: 'a',
        modality: 'video',
        pricing: { perSecondByResolution: { '720p': '5000000000' } },
      }),
      makeModel({
        id: 'b',
        modality: 'video',
        pricing: { perSecondByResolution: { '720p': '1000000000' } },
      }),
    ];
    expect(sortModels(models, 'price', 'asc', 'video').map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('treats video models with no resolution prices as zero', () => {
    const models = [
      makeModel({
        id: 'a',
        modality: 'video',
        pricing: { perSecondByResolution: { '720p': '5000000000' } },
      }),
      makeModel({ id: 'b', modality: 'video', pricing: {} }),
    ];
    expect(sortModels(models, 'price', 'asc', 'video').map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('leaves audio models in input order (no wire price dimension)', () => {
    const models = [
      makeModel({ id: 'a', modality: 'audio', pricing: {} }),
      makeModel({ id: 'b', modality: 'audio', pricing: {} }),
    ];
    // Audio carries no wire pricing, so every audio model sorts equal and the
    // stable sort preserves input order.
    expect(sortModels(models, 'price', 'asc', 'audio').map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('treats a text model with no input rate as zero-priced', () => {
    const models = [
      makeModel({ id: 'a', pricing: { outputPerToken: '2000000000' } }),
      makeModel({ id: 'b', pricing: { inputPerToken: '1000000000' } }),
    ];
    // 'a' omits inputPerToken, so its sort key falls back to 0n and sorts cheapest.
    expect(sortModels(models, 'price', 'asc', 'text').map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('treats an image model with no per-image rate as zero-priced', () => {
    const models = [
      makeModel({ id: 'a', modality: 'image', pricing: { perImage: '5000000000' } }),
      makeModel({ id: 'b', modality: 'image', pricing: {} }),
    ];
    // 'b' omits perImage, so its sort key falls back to 0n and sorts cheapest.
    expect(sortModels(models, 'price', 'asc', 'image').map((m) => m.id)).toEqual(['b', 'a']);
  });
});

describe('sortByPopularity', () => {
  it('orders models ascending by popularityRank', () => {
    const models = [
      makeModel({ id: 'a', popularityRank: 2 }),
      makeModel({ id: 'b', popularityRank: 0 }),
      makeModel({ id: 'c', popularityRank: 1 }),
    ];
    expect(sortByPopularity(models).map((m) => m.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts undefined ranks last', () => {
    const models = [
      makeModel({ id: 'a', popularityRank: undefined }),
      makeModel({ id: 'b', popularityRank: 3 }),
    ];
    expect(sortByPopularity(models).map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('is stable among equal ranks', () => {
    const models = [
      makeModel({ id: 'a', popularityRank: 1 }),
      makeModel({ id: 'b', popularityRank: 1 }),
      makeModel({ id: 'c', popularityRank: 1 }),
    ];
    expect(sortByPopularity(models).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('is stable among both-undefined ranks', () => {
    const models = [makeModel({ id: 'a' }), makeModel({ id: 'b' }), makeModel({ id: 'c' })];
    expect(sortByPopularity(models).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input array', () => {
    const models = [
      makeModel({ id: 'a', popularityRank: 2 }),
      makeModel({ id: 'b', popularityRank: 0 }),
    ];
    const snapshot = models.map((m) => m.id);
    sortByPopularity(models);
    expect(models.map((m) => m.id)).toEqual(snapshot);
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

  it('appends trailing premium models when premium outnumbers basic', () => {
    const models = [makeModel({ id: 'b1' }), makeModel({ id: 'p1' }), makeModel({ id: 'p2' })];
    const result = interlaceModels(models, new Set(['p1', 'p2']), false);
    // basic exhausts after b1; the loop skips the absent basic slot and keeps
    // pushing the remaining premium models.
    expect(result.map((m) => m.id)).toEqual(['b1', 'p1', 'p2']);
  });

  it('surfaces available-only models before interleaved pairs for the trial default view', () => {
    const models = [
      makeModel({ id: 'b1' }),
      makeModel({ id: 'b2' }),
      makeModel({ id: 'b3' }),
      makeModel({ id: 'p1' }),
    ];
    const result = interlaceModels(models, new Set(['p1']), false, true);
    // leftover available (b2, b3) first, then the interleaved pair (b1, p1).
    expect(result.map((m) => m.id)).toEqual(['b2', 'b3', 'b1', 'p1']);
  });

  it('has no leftover-available segment when premium outnumbers basic', () => {
    const models = [makeModel({ id: 'b1' }), makeModel({ id: 'p1' }), makeModel({ id: 'p2' })];
    const result = interlaceModels(models, new Set(['p1', 'p2']), false, true);
    // b1 pairs with p1, trailing premium p2 follows; no available-only leftover.
    expect(result.map((m) => m.id)).toEqual(['b1', 'p1', 'p2']);
  });

  it('returns input unchanged for paid users even with surfaceAvailableFirst', () => {
    const models = [makeModel({ id: 'b1' }), makeModel({ id: 'p1' })];
    expect(interlaceModels(models, new Set(['p1']), true, true)).toBe(models);
    expect(interlaceModels(models, new Set(), false, true)).toBe(models);
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
    // $0.020 base per-image → +15% customer markup → $0.023 displayed.
    expect(modelSubtitle(makeModel({ modality: 'image', pricing: { perImage: '20000000' } }))).toBe(
      'Acme • $0.023/image'
    );
  });

  it('shows a zero per-image price when an image model omits its rate', () => {
    // perImage absent → BigInt fallback of 0n → $0.000 displayed.
    expect(modelSubtitle(makeModel({ modality: 'image', pricing: {} }))).toBe(
      'Acme • $0.000/image'
    );
  });

  it('returns provider only for video with no resolution prices', () => {
    expect(modelSubtitle(makeModel({ modality: 'video', pricing: {} }))).toBe('Acme');
  });

  it('shows cheapest per-second video price', () => {
    expect(
      modelSubtitle(
        makeModel({
          modality: 'video',
          pricing: { perSecondByResolution: { '720p': '500000000', '1080p': '900000000' } },
        })
      )
      // $0.50 base cheapest per-second → +15% markup → $0.58 displayed.
    ).toBe('Acme • $0.58/s');
  });

  it('shows provider only for audio models (no wire price dimension)', () => {
    expect(modelSubtitle(makeModel({ modality: 'audio', pricing: {} }))).toBe('Acme');
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
