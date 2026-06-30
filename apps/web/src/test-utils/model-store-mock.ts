import { vi } from 'vitest';
import type { LegacyModality } from '@hushbox/shared';
import type {
  AudioConfig,
  ImageConfig,
  PickerMode,
  SelectedModelEntry,
  VideoConfig,
} from '@/stores/model';

/**
 * A shape-compatible stand-in for the real `useModelStore` state. Every action
 * defaults to a fresh `vi.fn()`; override any field via `createModelStoreStub(overrides)`.
 */
export interface ModelStoreStub {
  activeModality: LegacyModality;
  selections: Record<LegacyModality, SelectedModelEntry[]>;
  pickerMode: Record<LegacyModality, PickerMode>;
  imageConfig: ImageConfig;
  videoConfig: VideoConfig;
  audioConfig: AudioConfig;
  setActiveModality: ReturnType<typeof vi.fn>;
  setSelectedModels: ReturnType<typeof vi.fn>;
  toggleModel: ReturnType<typeof vi.fn>;
  removeModel: ReturnType<typeof vi.fn>;
  clearSelection: ReturnType<typeof vi.fn>;
  setPickerMode: ReturnType<typeof vi.fn>;
  setImageConfig: ReturnType<typeof vi.fn>;
  setVideoConfig: ReturnType<typeof vi.fn>;
  setAudioConfig: ReturnType<typeof vi.fn>;
}

/**
 * Build a `ModelStoreState`-shaped stub with sensible defaults (text-mode, one
 * test model selected) and fresh `vi.fn()` action mocks. Any field can be overridden;
 * the returned object can be mutated between tests or rebuilt in `beforeEach`.
 */
export function createModelStoreStub(overrides: Partial<ModelStoreStub> = {}): ModelStoreStub {
  return {
    activeModality: 'text',
    selections: {
      text: [{ id: 'test-model', name: 'Test Model' }],
      image: [],
      audio: [],
      video: [],
    },
    pickerMode: { text: 'single', image: 'single', audio: 'single', video: 'single' },
    imageConfig: { aspectRatio: '1:1' },
    videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
    audioConfig: { format: 'mp3', maxDurationSeconds: 600 },
    setActiveModality: vi.fn(),
    setSelectedModels: vi.fn(),
    toggleModel: vi.fn(),
    removeModel: vi.fn(),
    clearSelection: vi.fn(),
    setPickerMode: vi.fn(),
    setImageConfig: vi.fn(),
    setVideoConfig: vi.fn(),
    setAudioConfig: vi.fn(),
    ...overrides,
  };
}

/**
 * Wrap a state object as a zustand-style selector function. Call with `(selector)`
 * to select a slice, or with no argument to return the whole state — matching the
 * real `useModelStore((state) => ...)` / `useModelStore()` call patterns.
 */
export function selectorFromState<T>(state: T): (selector?: (s: T) => unknown) => unknown {
  return (selector) => (selector ? selector(state) : state);
}

/**
 * Attach static `getState` and `setState` methods to a selector function so it can
 * stand in for `useModelStore` in tests that use those zustand static APIs.
 */
export function attachStaticMethods<T>(
  function_: (selector?: (s: T) => unknown) => unknown,
  state: T
): (selector?: (s: T) => unknown) => unknown {
  const target = function_ as unknown as { getState: () => T; setState: ReturnType<typeof vi.fn> };
  target.getState = () => state;
  target.setState = vi.fn();
  return function_;
}
