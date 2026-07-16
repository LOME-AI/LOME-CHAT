import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCarryoverPulse } from '@/components/chat/media/use-carryover-pulse';
import type { PickerMode } from '@/stores/model';

interface Props {
  mode: PickerMode;
  ids: Set<string>;
  open: boolean;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useCarryoverPulse', () => {
  it('pulses the first selected model when the picker transitions single -> multi', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ mode, ids, open }: Props) => useCarryoverPulse(mode, ids, open),
      { initialProps: { mode: 'single' as PickerMode, ids: new Set(['a', 'b']), open: true } }
    );

    expect(result.current).toBeNull();

    rerender({ mode: 'multi', ids: new Set(['a', 'b']), open: true });
    expect(result.current).toBe('a');

    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current).toBeNull();
  });

  it('does not pulse when the transitioned selection is empty', () => {
    const { result, rerender } = renderHook(
      ({ mode, ids, open }: Props) => useCarryoverPulse(mode, ids, open),
      { initialProps: { mode: 'single' as PickerMode, ids: new Set<string>(), open: true } }
    );

    rerender({ mode: 'multi', ids: new Set<string>(), open: true });

    expect(result.current).toBeNull();
  });

  it('does not pulse when the transition is not single -> multi', () => {
    const { result, rerender } = renderHook(
      ({ mode, ids, open }: Props) => useCarryoverPulse(mode, ids, open),
      { initialProps: { mode: 'multi' as PickerMode, ids: new Set(['a']), open: true } }
    );

    rerender({ mode: 'multi', ids: new Set(['a']), open: true });

    expect(result.current).toBeNull();
  });

  it('resets the pulse when the modal closes', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ mode, ids, open }: Props) => useCarryoverPulse(mode, ids, open),
      { initialProps: { mode: 'single' as PickerMode, ids: new Set(['a']), open: true } }
    );

    rerender({ mode: 'multi', ids: new Set(['a']), open: true });
    expect(result.current).toBe('a');

    rerender({ mode: 'multi', ids: new Set(['a']), open: false });
    expect(result.current).toBeNull();
  });
});
