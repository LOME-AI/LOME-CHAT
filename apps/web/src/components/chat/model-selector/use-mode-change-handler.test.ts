import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useModeChangeHandler } from '@/components/chat/model-selector/use-mode-change-handler';
import type { Model } from '@hushbox/shared';

function makeModel(id: string): Model {
  return { id, name: `Model ${id}` } as unknown as Model;
}

describe('useModeChangeHandler', () => {
  it('collapses local + committed selection to the first model on multi -> single with many selected', () => {
    const setPickerMode = vi.fn();
    const setLocalSelectedIds = vi.fn();
    const onSelect = vi.fn();
    const models = [makeModel('a'), makeModel('b')];

    const { result } = renderHook(() =>
      useModeChangeHandler({
        setPickerMode,
        resolvedModality: 'text',
        localSelectedIds: new Set(['a', 'b']),
        setLocalSelectedIds,
        models,
        onSelect,
      })
    );

    result.current('single');

    expect(setLocalSelectedIds).toHaveBeenCalledWith(new Set(['a']));
    expect(onSelect).toHaveBeenCalledWith([{ id: 'a', name: 'Model a' }]);
    expect(setPickerMode).toHaveBeenCalledWith('text', 'single');
  });

  it('does not collapse when switching to multi', () => {
    const setPickerMode = vi.fn();
    const setLocalSelectedIds = vi.fn();
    const onSelect = vi.fn();

    const { result } = renderHook(() =>
      useModeChangeHandler({
        setPickerMode,
        resolvedModality: 'text',
        localSelectedIds: new Set(['a', 'b']),
        setLocalSelectedIds,
        models: [makeModel('a')],
        onSelect,
      })
    );

    result.current('multi');

    expect(setLocalSelectedIds).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(setPickerMode).toHaveBeenCalledWith('text', 'multi');
  });

  it('does not collapse when only one model is selected', () => {
    const setPickerMode = vi.fn();
    const setLocalSelectedIds = vi.fn();
    const onSelect = vi.fn();

    const { result } = renderHook(() =>
      useModeChangeHandler({
        setPickerMode,
        resolvedModality: 'text',
        localSelectedIds: new Set(['a']),
        setLocalSelectedIds,
        models: [makeModel('a')],
        onSelect,
      })
    );

    result.current('single');

    expect(setLocalSelectedIds).not.toHaveBeenCalled();
    expect(setPickerMode).toHaveBeenCalledWith('text', 'single');
  });
});
