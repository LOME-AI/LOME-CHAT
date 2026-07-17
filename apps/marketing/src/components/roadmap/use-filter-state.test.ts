import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFilterState, ALL_STATUSES, ALL_TYPES } from './use-filter-state';

const byString = (a: string, b: string): number => a.localeCompare(b);

describe('useFilterState', () => {
  beforeEach(() => {
    globalThis.history.replaceState(null, '', '/roadmap');
  });

  it('defaults to all statuses and types selected', () => {
    const { result } = renderHook(() => useFilterState());
    expect([...result.current.statuses].toSorted(byString)).toEqual(
      [...ALL_STATUSES].toSorted(byString)
    );
    expect([...result.current.types].toSorted(byString)).toEqual([...ALL_TYPES].toSorted(byString));
  });

  it('reads initial state from the URL when present', () => {
    globalThis.history.replaceState(null, '', '/roadmap?status=in_progress&type=feature');
    const { result } = renderHook(() => useFilterState());
    expect([...result.current.statuses]).toEqual(['in_progress']);
    expect([...result.current.types]).toEqual(['feature']);
  });

  it('ignores unknown URL values gracefully (falls back to all-on)', () => {
    globalThis.history.replaceState(null, '', '/roadmap?status=garbage');
    const { result } = renderHook(() => useFilterState());
    expect(result.current.statuses.size).toBe(ALL_STATUSES.length);
  });

  it('toggleStatus removes a present status', () => {
    const { result } = renderHook(() => useFilterState());
    act(() => {
      result.current.toggleStatus('shipped');
    });
    expect(result.current.statuses.has('shipped')).toBe(false);
    expect(result.current.statuses.has('in_progress')).toBe(true);
  });

  it('toggleStatus snaps to all-on when the last status is removed', () => {
    const { result } = renderHook(() => useFilterState());
    act(() => {
      result.current.toggleStatus('in_progress');
    });
    act(() => {
      result.current.toggleStatus('planned');
    });
    act(() => {
      result.current.toggleStatus('shipped');
    });
    expect(result.current.statuses.size).toBe(ALL_STATUSES.length);
  });

  it('toggleType removes a present type', () => {
    const { result } = renderHook(() => useFilterState());
    act(() => {
      result.current.toggleType('bug');
    });
    expect(result.current.types.has('bug')).toBe(false);
    expect(result.current.types.has('feature')).toBe(true);
  });

  it('toggleType re-adds a type that was previously removed', () => {
    const { result } = renderHook(() => useFilterState());
    act(() => {
      result.current.toggleType('feature');
    });
    expect(result.current.types.has('feature')).toBe(false);
    act(() => {
      result.current.toggleType('feature');
    });
    expect(result.current.types.has('feature')).toBe(true);
    expect(result.current.types.has('bug')).toBe(true);
  });

  it('toggleType snaps to all-on when the last type is removed', () => {
    const { result } = renderHook(() => useFilterState());
    act(() => {
      result.current.toggleType('feature');
    });
    act(() => {
      result.current.toggleType('bug');
    });
    expect(result.current.types.size).toBe(ALL_TYPES.length);
  });

  it('writes non-default selections to the URL', () => {
    const { result } = renderHook(() => useFilterState());
    act(() => {
      result.current.toggleStatus('shipped');
    });
    expect(globalThis.location.search).toContain('status=');
  });

  it('removes the URL param when state returns to default', () => {
    const { result } = renderHook(() => useFilterState());
    act(() => {
      result.current.toggleStatus('shipped');
    });
    act(() => {
      result.current.toggleStatus('shipped');
    });
    expect(globalThis.location.search).not.toContain('status=');
  });

  it('reset() restores both axes to all-on and clears URL params', () => {
    globalThis.history.replaceState(null, '', '/roadmap?status=in_progress&type=feature');
    const { result } = renderHook(() => useFilterState());
    expect(result.current.statuses.size).toBe(1);
    act(() => {
      result.current.reset();
    });
    expect(result.current.statuses.size).toBe(ALL_STATUSES.length);
    expect(result.current.types.size).toBe(ALL_TYPES.length);
    expect(globalThis.location.search).toBe('');
  });

  it('isDefault is true when both axes are all-on', () => {
    const { result } = renderHook(() => useFilterState());
    expect(result.current.isDefault).toBe(true);
  });

  it('isDefault is false when any axis has a non-default selection', () => {
    const { result } = renderHook(() => useFilterState());
    act(() => {
      result.current.toggleStatus('shipped');
    });
    expect(result.current.isDefault).toBe(false);
  });
});
