import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { type Model } from '@hushbox/shared';
import { useFilteredModels } from '@/components/chat/model-selector/use-filtered-models';

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

// available basics b1..b3, premium p1; strongest = b1, value = b2.
const trialModels = [
  makeModel({ id: 'b1', name: 'Basic One' }),
  makeModel({ id: 'b2', name: 'Basic Two' }),
  makeModel({ id: 'b3', name: 'Basic Three' }),
  makeModel({ id: 'p1', name: 'Premium One' }),
];

describe('useFilteredModels — trial ordering', () => {
  it('orders trial default view: pins, then available-only, then interleaved pairs', () => {
    const { result } = renderHook(() =>
      useFilteredModels({
        models: trialModels,
        searchQuery: '',
        sortField: null,
        sortDirection: 'asc',
        premiumIds: new Set(['p1']),
        canAccessPremium: false,
        strongestId: 'b1',
        valueId: 'b2',
      })
    );
    // Strongest (b1) + Value (b2) pinned first, then leftover-available (b3),
    // then the interleaved pair remainder (p1). b1/b2 are not duplicated.
    expect(result.current.map((m) => m.id)).toEqual(['b1', 'b2', 'b3', 'p1']);
  });

  it('handles premium outnumbering basic without a leftover-available segment', () => {
    const models = [makeModel({ id: 'b1' }), makeModel({ id: 'p1' }), makeModel({ id: 'p2' })];
    const { result } = renderHook(() =>
      useFilteredModels({
        models,
        searchQuery: '',
        sortField: null,
        sortDirection: 'asc',
        premiumIds: new Set(['p1', 'p2']),
        canAccessPremium: false,
        strongestId: 'b1',
        valueId: 'p1',
      })
    );
    // b1 (strongest) + p1 (value) pinned, then trailing premium p2. No dupes.
    expect(result.current.map((m) => m.id)).toEqual(['b1', 'p1', 'p2']);
  });

  it('leaves the paid/authenticated default order identical to the un-interlaced list', () => {
    const paid = renderHook(() =>
      useFilteredModels({
        models: trialModels,
        searchQuery: '',
        sortField: null,
        sortDirection: 'asc',
        premiumIds: new Set(['p1']),
        canAccessPremium: true,
        strongestId: 'b1',
        valueId: 'b2',
      })
    );
    // Pins first, then remaining in original order — no interlacing, no reorder.
    expect(paid.result.current.map((m) => m.id)).toEqual(['b1', 'b2', 'b3', 'p1']);

    // Same expectation when there are no premium ids at all (the other paid branch).
    const noPremium = renderHook(() =>
      useFilteredModels({
        models: trialModels,
        searchQuery: '',
        sortField: null,
        sortDirection: 'asc',
        premiumIds: new Set(),
        canAccessPremium: false,
        strongestId: 'b1',
        valueId: 'b2',
      })
    );
    expect(noPremium.result.current.map((m) => m.id)).toEqual(['b1', 'b2', 'b3', 'p1']);
  });

  it('orders the non-pinned remainder by popularityRank in the default view', () => {
    // strongest = s, value = v (both pinned first); remainder r1/r2/r3 have
    // distinct ranks that invert their input order.
    const models = [
      makeModel({ id: 's', name: 'Strongest', popularityRank: 9 }),
      makeModel({ id: 'v', name: 'Value', popularityRank: 8 }),
      makeModel({ id: 'r1', name: 'Rank Two', popularityRank: 2 }),
      makeModel({ id: 'r2', name: 'Rank Zero', popularityRank: 0 }),
      makeModel({ id: 'r3', name: 'Rank One', popularityRank: 1 }),
    ];
    const { result } = renderHook(() =>
      useFilteredModels({
        models,
        searchQuery: '',
        sortField: null,
        sortDirection: 'asc',
        premiumIds: new Set(),
        canAccessPremium: true,
        strongestId: 's',
        valueId: 'v',
      })
    );
    // Pins (s, v) first, then remainder by popularity asc (r2=0, r3=1, r1=2).
    expect(result.current.map((m) => m.id)).toEqual(['s', 'v', 'r2', 'r3', 'r1']);
  });

  it('keeps the legacy interlaced order for a trial user in a non-default (search) view', () => {
    const { result } = renderHook(() =>
      useFilteredModels({
        models: trialModels,
        searchQuery: 'acme',
        sortField: null,
        sortDirection: 'asc',
        premiumIds: new Set(['p1']),
        canAccessPremium: false,
        strongestId: 'b1',
        valueId: 'b2',
      })
    );
    // Non-default: no pinning, classic interlace (b1,p1,b2,b3) with basics trailing.
    expect(result.current.map((m) => m.id)).toEqual(['b1', 'p1', 'b2', 'b3']);
  });
});
