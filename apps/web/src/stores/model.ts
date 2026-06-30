import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  SMART_MODEL_ID,
  MAX_SELECTED_MODELS,
  MAX_AUDIO_DURATION_SECONDS,
  getSupportedVideoDurations,
  getSupportedVideoResolutions,
  getSupportedVideoAspectRatios,
} from '@hushbox/shared';
import { snapToNearest } from '@/lib/multi-model-agreement';
import type {
  LegacyModality,
  ImageConfig,
  VideoConfig,
  AudioConfig,
  VideoAspectRatio,
  VideoResolution,
} from '@hushbox/shared';

export const DEFAULT_MODEL_ID = SMART_MODEL_ID;
export const DEFAULT_MODEL_NAME = 'Smart Model';

export interface SelectedModelEntry {
  id: string;
  name: string;
}

export type PickerMode = 'single' | 'multi';

export interface ModelStoreState {
  activeModality: LegacyModality;
  selections: Record<LegacyModality, SelectedModelEntry[]>;
  /**
   * Per-modality picker mode preference. Stored per-modality so a user can
   * prefer single-select for text (fast swap) and multi-select for image
   * (compare visual styles). Persisted via the model store's persist middleware.
   */
  pickerMode: Record<LegacyModality, PickerMode>;
  imageConfig: ImageConfig;
  videoConfig: VideoConfig;
  audioConfig: AudioConfig;

  setActiveModality: (modality: LegacyModality) => void;
  setSelectedModels: (modality: LegacyModality, entries: SelectedModelEntry[]) => void;
  toggleModel: (modality: LegacyModality, entry: SelectedModelEntry) => void;
  removeModel: (modality: LegacyModality, modelId: string) => void;
  clearSelection: (modality: LegacyModality) => void;
  setPickerMode: (modality: LegacyModality, mode: PickerMode) => void;
  /**
   * Resets state for an unauthenticated user: forces text modality (so the
   * trial chat page never lands with image/video/audio active and all icons
   * disabled), clears every modality selection, and resets pickerMode to
   * single across modalities so the next picker open is in the simpler mode.
   */
  resetForUnauthenticated: () => void;
  setImageConfig: (config: Partial<ImageConfig>) => void;
  setVideoConfig: (config: Partial<VideoConfig>) => void;
  setAudioConfig: (config: Partial<AudioConfig>) => void;
}

const DEFAULT_TEXT_ENTRY: SelectedModelEntry = {
  id: DEFAULT_MODEL_ID,
  name: DEFAULT_MODEL_NAME,
};
const BLANK_ENTRY: SelectedModelEntry = { id: '', name: '' };

const DEFAULT_IMAGE_CONFIG: ImageConfig = { aspectRatio: '1:1' };
const DEFAULT_VIDEO_CONFIG: VideoConfig = {
  aspectRatio: '16:9',
  durationSeconds: 4,
  resolution: '720p',
};
const DEFAULT_AUDIO_CONFIG: AudioConfig = {
  format: 'mp3',
  maxDurationSeconds: MAX_AUDIO_DURATION_SECONDS,
};

function defaultSelections(): Record<LegacyModality, SelectedModelEntry[]> {
  return { text: [DEFAULT_TEXT_ENTRY], image: [], audio: [], video: [] };
}

function defaultPickerMode(): Record<LegacyModality, PickerMode> {
  return { text: 'single', image: 'single', audio: 'single', video: 'single' };
}

/**
 * Guarantees `selections.text` always has at least one entry. Returns the input
 * unchanged when text is non-empty so callers can use reference equality to skip
 * unnecessary state updates.
 */
function ensureTextNonEmpty(
  selections: Record<LegacyModality, SelectedModelEntry[]>
): Record<LegacyModality, SelectedModelEntry[]> {
  if (selections.text.length > 0) return selections;
  return { ...selections, text: [DEFAULT_TEXT_ENTRY] };
}

export function getPrimaryModel(
  entries: SelectedModelEntry[],
  modality: LegacyModality = 'text'
): SelectedModelEntry {
  const entry = entries[0];
  if (entry) return entry;
  return modality === 'text' ? DEFAULT_TEXT_ENTRY : BLANK_ENTRY;
}

function entriesEqual(a: SelectedModelEntry[], b: SelectedModelEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => entry.id === b[index]?.id);
}

// Intersection of a per-model option list across every selected video model.
// Returns `undefined` when at least one model is missing from the capability
// map — that lets the caller leave the user-chosen value alone rather than
// snapping to a possibly-empty intersection.
function agreedVideoOptions<T extends string | number>(
  selected: readonly SelectedModelEntry[],
  pluck: (modelId: string) => readonly T[] | undefined
): readonly T[] | undefined {
  if (selected.length === 0) return undefined;
  const supportedSets: (readonly T[])[] = [];
  for (const entry of selected) {
    const supported = pluck(entry.id);
    if (supported === undefined) continue;
    supportedSets.push(supported);
  }
  if (supportedSets.length === 0) return undefined;
  const [firstSet, ...rest] = supportedSets;
  if (firstSet === undefined) return undefined;
  return firstSet.filter((option) => rest.every((set) => set.includes(option)));
}

/**
 * Returns a new `VideoConfig` whose duration / resolution / aspect ratio are
 * guaranteed to be in the agreed supported set across `selected`. Snaps each
 * field independently — duration via nearest-neighbour (Veo's discrete set is
 * non-uniform), resolution / aspect ratio via "first supported if current
 * isn't in the set". When `selected` is empty or none of the models advertise
 * capabilities, the existing config is returned unchanged so the user keeps
 * their last input.
 *
 * Lives at the store level so it always fires on selection change, regardless
 * of whether the modality config panel is mounted — a panel-effect snap can
 * miss switches that happen elsewhere in the UI.
 */
function snapDuration(current: number, supported: readonly number[] | undefined): number {
  if (supported === undefined || supported.length === 0 || supported.includes(current)) {
    return current;
  }
  return snapToNearest(supported, current) ?? current;
}

function snapToFirstSupported<T extends string>(
  current: T,
  supported: readonly T[] | undefined
): T {
  if (supported === undefined || supported.length === 0 || supported.includes(current)) {
    return current;
  }
  return supported[0] ?? current;
}

function snapVideoConfigToSelection(
  current: VideoConfig,
  selected: readonly SelectedModelEntry[]
): VideoConfig {
  if (selected.length === 0) return current;
  const durationSeconds = snapDuration(
    current.durationSeconds,
    agreedVideoOptions(selected, getSupportedVideoDurations)
  );
  const resolution = snapToFirstSupported<VideoResolution>(
    current.resolution,
    agreedVideoOptions(selected, getSupportedVideoResolutions)
  );
  const aspectRatio = snapToFirstSupported<VideoAspectRatio>(
    current.aspectRatio,
    agreedVideoOptions(selected, getSupportedVideoAspectRatios)
  );
  if (
    durationSeconds === current.durationSeconds &&
    resolution === current.resolution &&
    aspectRatio === current.aspectRatio
  ) {
    return current;
  }
  return { ...current, aspectRatio, durationSeconds, resolution };
}

// Returning the same `state` reference when the next entries are structurally
// equal short-circuits Zustand's subscriber broadcast; this is the bottom-layer
// defense against effect loops in callers like `useModelValidation` that may
// re-derive a structurally identical replacement on every render.
function updateModalitySelection(
  state: ModelStoreState,
  modality: LegacyModality,
  next: SelectedModelEntry[]
): ModelStoreState | Partial<ModelStoreState> {
  if (entriesEqual(state.selections[modality], next)) return state;
  const patch: Partial<ModelStoreState> = {
    selections: { ...state.selections, [modality]: next },
  };
  // Re-snap videoConfig whenever the video selection changes, so values that
  // were valid for the old model but not the new one never reach the gateway.
  // No-op for other modalities and for empty selections.
  if (modality === 'video') {
    const nextVideoConfig = snapVideoConfigToSelection(state.videoConfig, next);
    if (nextVideoConfig !== state.videoConfig) {
      patch.videoConfig = nextVideoConfig;
    }
  }
  return patch;
}

export const useModelStore = create<ModelStoreState>()(
  persist(
    (set) => ({
      activeModality: 'text',
      selections: defaultSelections(),
      pickerMode: defaultPickerMode(),
      imageConfig: { ...DEFAULT_IMAGE_CONFIG },
      videoConfig: { ...DEFAULT_VIDEO_CONFIG },
      audioConfig: { ...DEFAULT_AUDIO_CONFIG },

      setActiveModality: (modality) =>
        set((state) => {
          if (state.activeModality === modality) return state;
          return { activeModality: modality };
        }),

      setSelectedModels: (modality, entries) =>
        set((state) => updateModalitySelection(state, modality, entries)),

      toggleModel: (modality, entry) =>
        set((state) => {
          const current = state.selections[modality];
          const existingIndex = current.findIndex((m) => m.id === entry.id);
          if (existingIndex !== -1) {
            // Already selected — remove. Text must keep at least one entry.
            if (modality === 'text' && current.length <= 1) return state;
            return updateModalitySelection(
              state,
              modality,
              current.filter((_, index) => index !== existingIndex)
            );
          }
          if (current.length >= MAX_SELECTED_MODELS) return state;
          return updateModalitySelection(state, modality, [...current, entry]);
        }),

      removeModel: (modality, modelId) =>
        set((state) => {
          const current = state.selections[modality];
          if (modality === 'text' && current.length <= 1) return state;
          const filtered = current.filter((m) => m.id !== modelId);
          if (filtered.length === current.length) return state;
          return updateModalitySelection(state, modality, filtered);
        }),

      clearSelection: (modality) =>
        set((state) => {
          const current = state.selections[modality];
          if (modality === 'text') {
            return updateModalitySelection(state, modality, [getPrimaryModel(current, 'text')]);
          }
          if (current.length === 0) return state;
          return updateModalitySelection(state, modality, []);
        }),

      setPickerMode: (modality, mode) =>
        set((state) => {
          if (state.pickerMode[modality] === mode) return state;
          return { pickerMode: { ...state.pickerMode, [modality]: mode } };
        }),

      resetForUnauthenticated: () =>
        set(() => ({
          activeModality: 'text',
          selections: defaultSelections(),
          pickerMode: defaultPickerMode(),
        })),

      setImageConfig: (config) =>
        set((state) => ({ imageConfig: { ...state.imageConfig, ...config } })),

      setVideoConfig: (config) =>
        set((state) => ({ videoConfig: { ...state.videoConfig, ...config } })),

      setAudioConfig: (config) =>
        set((state) => ({ audioConfig: { ...state.audioConfig, ...config } })),
    }),
    {
      name: 'hushbox-model-storage',
      version: 1,
      partialize: (state) => ({
        activeModality: state.activeModality,
        selections: state.selections,
        pickerMode: state.pickerMode,
      }),
      // Pre-v1 builds persisted `videoConfig` / `imageConfig` / `audioConfig`
      // alongside selections. Carrying those across a model switch could leave
      // the stored value invalid for the newly selected model. Strip them so
      // the in-memory defaults win.
      migrate: (persisted, version) => {
        if (typeof persisted !== 'object' || persisted === null) return persisted;
        if (version >= 1) return persisted;
        const staleKeys = new Set(['videoConfig', 'imageConfig', 'audioConfig']);
        return Object.fromEntries(
          Object.entries(persisted as Record<string, unknown>).filter(
            ([key]) => !staleKeys.has(key)
          )
        );
      },
      merge: (persisted, current) => {
        const merged: ModelStoreState = {
          ...current,
          ...(persisted as Partial<ModelStoreState>),
        };
        merged.selections = ensureTextNonEmpty(merged.selections);
        return merged;
      },
    }
  )
);

// Guard: text selection must never be empty. Image/audio/video may legitimately be empty.
// `ensureTextNonEmpty` returns the same reference when text is non-empty, so setState
// is only called when a restoration is actually needed.
useModelStore.subscribe((state) => {
  const next = ensureTextNonEmpty(state.selections);
  if (next !== state.selections) {
    useModelStore.setState({ selections: next });
  }
});

export { type ImageConfig, type VideoConfig, type AudioConfig } from '@hushbox/shared';
