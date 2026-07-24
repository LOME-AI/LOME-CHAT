import { describe, expect, it } from 'vitest';

import { MAX_SEARCH_TOOL_CALLS, SEARCH_COST_PER_CALL } from '../constants.js';
import { applyMarkupCeil, usdToNanoUsd } from '../money.js';
import {
  WEB_SEARCH_RESERVATION_BASE_NANO_PER_MODEL,
  WEB_SEARCH_RESERVATION_NANO_PER_MODEL,
  webSearchLineItem,
} from './search-reservation.js';

describe('WEB_SEARCH_RESERVATION_BASE_NANO_PER_MODEL', () => {
  it('is MAX_SEARCH_TOOL_CALLS × the provider per-call rate in nano-USD', () => {
    expect(WEB_SEARCH_RESERVATION_BASE_NANO_PER_MODEL).toBe(
      BigInt(MAX_SEARCH_TOOL_CALLS) * usdToNanoUsd(SEARCH_COST_PER_CALL)
    );
    expect(WEB_SEARCH_RESERVATION_BASE_NANO_PER_MODEL).toBe(50_000_000n);
  });
});

describe('WEB_SEARCH_RESERVATION_NANO_PER_MODEL', () => {
  it('is the provider base made billable once, ceil-rounded, at definition', () => {
    expect(WEB_SEARCH_RESERVATION_NANO_PER_MODEL).toBe(
      applyMarkupCeil(WEB_SEARCH_RESERVATION_BASE_NANO_PER_MODEL)
    );
    expect(WEB_SEARCH_RESERVATION_NANO_PER_MODEL).toBe(57_500_000n);
  });
});

describe('webSearchLineItem', () => {
  it('reserves the billable per-model worst case as a fixed provider item', () => {
    const item = webSearchLineItem(1);
    expect(item.label).toBe('web-search-reservation');
    expect(item.fixedNano).toBe(57_500_000n);
    expect(item.kind).toBe('provider');
  });

  it('scales the reservation by the model count (legacy × modelCount)', () => {
    expect(webSearchLineItem(3).fixedNano).toBe(172_500_000n);
  });

  it('rejects a non-positive or non-integer model count', () => {
    expect(() => webSearchLineItem(0)).toThrow(RangeError);
    expect(() => webSearchLineItem(-1)).toThrow(RangeError);
    expect(() => webSearchLineItem(2.5)).toThrow(RangeError);
  });
});
