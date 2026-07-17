import { describe, it, expect, beforeEach } from 'vitest';
import { SMART_MODEL_ID, MAX_SELECTED_MODELS } from '@hushbox/shared';
import { useModelStore, DEFAULT_MODEL_ID, DEFAULT_MODEL_NAME, getPrimaryModel } from './model';
import type { LegacyModality } from '@hushbox/shared';
import type { SelectedModelEntry } from './model';

const VEO_30 = 'google/veo-3.0-generate-001';
const VEO_31 = 'google/veo-3.1-generate-001';

const defaultTextEntry: SelectedModelEntry = { id: DEFAULT_MODEL_ID, name: DEFAULT_MODEL_NAME };

function emptySelections(): Record<LegacyModality, SelectedModelEntry[]> {
  return { text: [defaultTextEntry], image: [], audio: [], video: [] };
}

function resetStore(): void {
  useModelStore.setState({
    activeModality: 'text',
    selections: emptySelections(),
    pickerMode: { text: 'single', image: 'single', audio: 'single', video: 'single' },
    imageConfig: { aspectRatio: '1:1' },
    videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
  });
}

describe('useModelStore', () => {
  beforeEach(() => {
    resetStore();
  });

  describe('defaults', () => {
    it('exports default model id as the Smart Model', () => {
      expect(DEFAULT_MODEL_ID).toBe(SMART_MODEL_ID);
    });

    it('exports default model name as Smart Model', () => {
      expect(DEFAULT_MODEL_NAME).toBe('Smart Model');
    });

    it('has default text selection with Smart Model', () => {
      const { selections } = useModelStore.getState();
      expect(selections.text).toEqual([defaultTextEntry]);
    });

    it('has empty selections for image, audio, and video by default', () => {
      const { selections } = useModelStore.getState();
      expect(selections.image).toEqual([]);
      expect(selections.audio).toEqual([]);
      expect(selections.video).toEqual([]);
    });

    it('defaults activeModality to text', () => {
      expect(useModelStore.getState().activeModality).toBe('text');
    });

    it('has default imageConfig', () => {
      expect(useModelStore.getState().imageConfig).toEqual({ aspectRatio: '1:1' });
    });

    it('has default videoConfig', () => {
      expect(useModelStore.getState().videoConfig).toEqual({
        aspectRatio: '16:9',
        durationSeconds: 4,
        resolution: '720p',
      });
    });
  });

  describe('setActiveModality', () => {
    it('switches modality without resetting selections', () => {
      useModelStore.setState({
        selections: {
          text: [{ id: 'model-a', name: 'Model A' }],
          image: [{ id: 'image-1', name: 'Image 1' }],
          audio: [],
          video: [],
        },
      });
      useModelStore.getState().setActiveModality('image');
      const state = useModelStore.getState();
      expect(state.activeModality).toBe('image');
      expect(state.selections.text).toEqual([{ id: 'model-a', name: 'Model A' }]);
      expect(state.selections.image).toEqual([{ id: 'image-1', name: 'Image 1' }]);
    });

    it('is a no-op when modality is unchanged', () => {
      const before = useModelStore.getState();
      useModelStore.getState().setActiveModality('text');
      expect(useModelStore.getState().selections).toBe(before.selections);
    });

    it('supports switching to audio and video', () => {
      useModelStore.getState().setActiveModality('audio');
      expect(useModelStore.getState().activeModality).toBe('audio');
      useModelStore.getState().setActiveModality('video');
      expect(useModelStore.getState().activeModality).toBe('video');
    });
  });

  describe('setSelectedModels', () => {
    it('replaces the array for the given modality only', () => {
      useModelStore.getState().setSelectedModels('text', [{ id: 'claude', name: 'Claude' }]);
      expect(useModelStore.getState().selections.text).toEqual([{ id: 'claude', name: 'Claude' }]);
      expect(useModelStore.getState().selections.image).toEqual([]);
    });

    it('does not cross-pollinate between modalities', () => {
      useModelStore.getState().setSelectedModels('image', [{ id: 'imagen', name: 'Imagen' }]);
      const state = useModelStore.getState();
      expect(state.selections.text).toEqual([defaultTextEntry]);
      expect(state.selections.image).toEqual([{ id: 'imagen', name: 'Imagen' }]);
    });

    it('preserves the selections reference when next entries are structurally equal', () => {
      useModelStore.setState({
        selections: {
          text: [{ id: 'a', name: 'A' }],
          image: [],
          audio: [],
          video: [],
        },
      });
      const before = useModelStore.getState().selections;
      useModelStore.getState().setSelectedModels('text', [{ id: 'a', name: 'NewName' }]);
      expect(useModelStore.getState().selections).toBe(before);
    });

    it('updates the selections reference when ids change', () => {
      useModelStore.setState({
        selections: {
          text: [{ id: 'a', name: 'A' }],
          image: [],
          audio: [],
          video: [],
        },
      });
      const before = useModelStore.getState().selections;
      useModelStore.getState().setSelectedModels('text', [{ id: 'b', name: 'B' }]);
      expect(useModelStore.getState().selections).not.toBe(before);
      expect(useModelStore.getState().selections.text).toEqual([{ id: 'b', name: 'B' }]);
    });

    it('updates the selections reference when length differs', () => {
      useModelStore.setState({
        selections: {
          text: [{ id: 'a', name: 'A' }],
          image: [],
          audio: [],
          video: [],
        },
      });
      const before = useModelStore.getState().selections;
      useModelStore.getState().setSelectedModels('text', [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ]);
      expect(useModelStore.getState().selections).not.toBe(before);
    });
  });

  describe('toggleModel', () => {
    it('adds a model to the given modality when absent', () => {
      useModelStore.getState().toggleModel('text', { id: 'claude', name: 'Claude' });
      expect(useModelStore.getState().selections.text).toHaveLength(2);
    });

    it('removes a model from the given modality when present and > 1 selected', () => {
      useModelStore.setState({
        selections: {
          text: [
            { id: 'a', name: 'A' },
            { id: 'b', name: 'B' },
          ],
          image: [],
          audio: [],
          video: [],
        },
      });
      useModelStore.getState().toggleModel('text', { id: 'b', name: 'B' });
      expect(useModelStore.getState().selections.text).toEqual([{ id: 'a', name: 'A' }]);
    });

    it('never removes the last text model', () => {
      useModelStore.getState().toggleModel('text', defaultTextEntry);
      expect(useModelStore.getState().selections.text).toEqual([defaultTextEntry]);
    });

    it('allows removing the last image model (image can be empty)', () => {
      useModelStore.setState({
        selections: {
          text: [defaultTextEntry],
          image: [{ id: 'imagen', name: 'Imagen' }],
          audio: [],
          video: [],
        },
      });
      useModelStore.getState().toggleModel('image', { id: 'imagen', name: 'Imagen' });
      expect(useModelStore.getState().selections.image).toEqual([]);
    });

    it('respects MAX_SELECTED_MODELS per modality', () => {
      const models: SelectedModelEntry[] = Array.from(
        { length: MAX_SELECTED_MODELS },
        (_, index) => ({ id: `m${String(index)}`, name: `M${String(index)}` })
      );
      useModelStore.setState({
        selections: { text: models, image: [], audio: [], video: [] },
      });
      useModelStore.getState().toggleModel('text', { id: 'extra', name: 'Extra' });
      expect(useModelStore.getState().selections.text).toHaveLength(MAX_SELECTED_MODELS);
    });

    it('applies the cap per-modality (text full does not block image)', () => {
      const textModels: SelectedModelEntry[] = Array.from(
        { length: MAX_SELECTED_MODELS },
        (_, index) => ({ id: `t${String(index)}`, name: `T${String(index)}` })
      );
      useModelStore.setState({
        selections: { text: textModels, image: [], audio: [], video: [] },
      });
      useModelStore.getState().toggleModel('image', { id: 'imagen', name: 'Imagen' });
      expect(useModelStore.getState().selections.image).toEqual([{ id: 'imagen', name: 'Imagen' }]);
    });
  });

  describe('removeModel', () => {
    it('removes a model from the given modality', () => {
      useModelStore.setState({
        selections: {
          text: [
            { id: 'a', name: 'A' },
            { id: 'b', name: 'B' },
          ],
          image: [],
          audio: [],
          video: [],
        },
      });
      useModelStore.getState().removeModel('text', 'a');
      expect(useModelStore.getState().selections.text).toEqual([{ id: 'b', name: 'B' }]);
    });

    it('never empties text', () => {
      useModelStore.getState().removeModel('text', DEFAULT_MODEL_ID);
      expect(useModelStore.getState().selections.text).toEqual([defaultTextEntry]);
    });

    it('allows emptying image', () => {
      useModelStore.setState({
        selections: {
          text: [defaultTextEntry],
          image: [{ id: 'imagen', name: 'Imagen' }],
          audio: [],
          video: [],
        },
      });
      useModelStore.getState().removeModel('image', 'imagen');
      expect(useModelStore.getState().selections.image).toEqual([]);
    });

    it('does nothing when the id is not present', () => {
      useModelStore.getState().removeModel('text', 'nonexistent');
      expect(useModelStore.getState().selections.text).toEqual([defaultTextEntry]);
    });
  });

  describe('resetForUnauthenticated', () => {
    it('forces activeModality back to text', () => {
      useModelStore.setState({ activeModality: 'image' });
      useModelStore.getState().resetForUnauthenticated();
      expect(useModelStore.getState().activeModality).toBe('text');
    });

    it('resets text selection to the default Smart Model entry', () => {
      useModelStore.setState({
        selections: {
          text: [{ id: 'a', name: 'A' }],
          image: [{ id: 'imagen', name: 'Imagen' }],
          audio: [],
          video: [],
        },
      });
      useModelStore.getState().resetForUnauthenticated();
      expect(useModelStore.getState().selections.text).toEqual([defaultTextEntry]);
    });

    it('clears non-text modalities', () => {
      useModelStore.setState({
        selections: {
          text: [defaultTextEntry],
          image: [{ id: 'imagen', name: 'Imagen' }],
          audio: [{ id: 'audio-m', name: 'Audio' }],
          video: [{ id: 'veo', name: 'Veo' }],
        },
      });
      useModelStore.getState().resetForUnauthenticated();
      const state = useModelStore.getState();
      expect(state.selections.image).toEqual([]);
      expect(state.selections.audio).toEqual([]);
      expect(state.selections.video).toEqual([]);
    });

    it('forces text modality even when starting from video', () => {
      useModelStore.setState({ activeModality: 'video' });
      useModelStore.getState().resetForUnauthenticated();
      expect(useModelStore.getState().activeModality).toBe('text');
    });
  });

  describe('clearSelection', () => {
    it('reduces text selection to only the primary entry', () => {
      useModelStore.setState({
        selections: {
          text: [
            { id: 'a', name: 'A' },
            { id: 'b', name: 'B' },
          ],
          image: [],
          audio: [],
          video: [],
        },
      });
      useModelStore.getState().clearSelection('text');
      expect(useModelStore.getState().selections.text).toEqual([{ id: 'a', name: 'A' }]);
    });

    it('empties image selection', () => {
      useModelStore.setState({
        selections: {
          text: [defaultTextEntry],
          image: [
            { id: 'a', name: 'A' },
            { id: 'b', name: 'B' },
          ],
          audio: [],
          video: [],
        },
      });
      useModelStore.getState().clearSelection('image');
      expect(useModelStore.getState().selections.image).toEqual([]);
    });
  });

  describe('setImageConfig', () => {
    it('merges partial config', () => {
      useModelStore.getState().setImageConfig({ aspectRatio: '16:9' });
      expect(useModelStore.getState().imageConfig).toEqual({ aspectRatio: '16:9' });
    });
  });

  describe('setVideoConfig', () => {
    it('merges partial config', () => {
      useModelStore.getState().setVideoConfig({ durationSeconds: 6 });
      expect(useModelStore.getState().videoConfig).toEqual({
        aspectRatio: '16:9',
        durationSeconds: 6,
        resolution: '720p',
      });
    });

    it('overrides all config fields when all provided', () => {
      useModelStore
        .getState()
        .setVideoConfig({ aspectRatio: '9:16', durationSeconds: 8, resolution: '1080p' });
      expect(useModelStore.getState().videoConfig).toEqual({
        aspectRatio: '9:16',
        durationSeconds: 8,
        resolution: '1080p',
      });
    });
  });

  describe('setAudioConfig', () => {
    it('merges partial audio config', () => {
      useModelStore.getState().setAudioConfig({ format: 'wav' });
      expect(useModelStore.getState().audioConfig.format).toBe('wav');
    });
  });

  describe('removeModel no-op paths', () => {
    it('returns the same state when the id is not in the selection', () => {
      useModelStore.setState({
        selections: {
          ...useModelStore.getState().selections,
          image: [{ id: 'google/imagen-4.0-generate-001', name: 'Imagen 4' }],
        },
      });
      const before = useModelStore.getState().selections;
      useModelStore.getState().removeModel('image', 'not-selected');
      expect(useModelStore.getState().selections).toBe(before);
    });
  });

  describe('clearSelection no-op paths', () => {
    it('returns the same state when clearing an already-empty non-text modality', () => {
      const before = useModelStore.getState().selections;
      useModelStore.getState().clearSelection('image');
      expect(useModelStore.getState().selections).toBe(before);
    });
  });

  describe('agreedVideoOptions edge cases (via video re-snap)', () => {
    it('intersects durations across two selected video models (skips unknown models)', () => {
      // One real model + one unknown model: the unknown is skipped, the real one
      // supplies [4,6,8]; a stale duration of 5 snaps to 4.
      useModelStore.setState({
        videoConfig: { aspectRatio: '16:9', durationSeconds: 5, resolution: '720p' },
      });
      useModelStore.getState().setSelectedModels('video', [
        { id: VEO_30, name: 'Veo 3.0' },
        { id: 'unknown/video-model', name: 'Unknown' },
      ]);
      expect(useModelStore.getState().videoConfig.durationSeconds).toBe(4);
    });

    it('intersects across two real video models where both advertise capabilities', () => {
      // Both VEO_30 and VEO_31 advertise durations, so the reducer walks the
      // non-empty `rest` set; a stale 5 snaps to the shared 4.
      useModelStore.setState({
        videoConfig: { aspectRatio: '16:9', durationSeconds: 5, resolution: '1080p' },
      });
      useModelStore.getState().setSelectedModels('video', [
        { id: VEO_30, name: 'Veo 3.0' },
        { id: VEO_31, name: 'Veo 3.1' },
      ]);
      expect(useModelStore.getState().videoConfig.durationSeconds).toBe(4);
    });

    it('leaves the config unchanged when no selected video model is in the capability map', () => {
      const before = useModelStore.getState().videoConfig;
      useModelStore
        .getState()
        .setSelectedModels('video', [{ id: 'unknown/video-model', name: 'Unknown' }]);
      // agreedVideoOptions collects no supported sets, so every field keeps its value.
      expect(useModelStore.getState().videoConfig).toEqual(before);
    });
  });

  describe('persist migrate', () => {
    interface MigratePersistHandle {
      persist: {
        getOptions: () => {
          migrate: (persisted: unknown, version: number) => unknown;
        };
      };
    }
    const getMigrate = (): ((persisted: unknown, version: number) => unknown) =>
      (useModelStore as unknown as MigratePersistHandle).persist.getOptions().migrate;

    it('passes a non-object persisted value through unchanged', () => {
      expect(getMigrate()('legacy-string', 0)).toBe('legacy-string');
    });

    it('passes a null persisted value through unchanged', () => {
      expect(getMigrate()(null, 0)).toBeNull();
    });

    it('returns an already-current (version >= 1) payload unchanged', () => {
      const payload = { selections: { text: [defaultTextEntry] }, videoConfig: { foo: 1 } };
      expect(getMigrate()(payload, 1)).toBe(payload);
    });

    it('strips stale per-modality config keys when migrating from version 0', () => {
      const migrated = getMigrate()(
        {
          activeModality: 'text',
          videoConfig: { durationSeconds: 99 },
          imageConfig: { aspectRatio: 'bogus' },
          audioConfig: { format: 'bogus' },
        },
        0
      ) as Record<string, unknown>;
      expect(migrated).toEqual({ activeModality: 'text' });
      expect(migrated).not.toHaveProperty('videoConfig');
      expect(migrated).not.toHaveProperty('imageConfig');
      expect(migrated).not.toHaveProperty('audioConfig');
    });
  });

  describe('empty state guard', () => {
    it('restores default text entry when text is set to empty', () => {
      useModelStore.setState({
        selections: { text: [], image: [], audio: [], video: [] },
      });
      expect(useModelStore.getState().selections.text).toEqual([defaultTextEntry]);
    });

    it('does not restore image when set to empty', () => {
      useModelStore.setState({
        selections: { text: [defaultTextEntry], image: [], audio: [], video: [] },
      });
      expect(useModelStore.getState().selections.image).toEqual([]);
    });

    it('restores default text when setSelectedModels empties the text slot', () => {
      useModelStore.getState().setSelectedModels('text', []);
      expect(useModelStore.getState().selections.text).toEqual([defaultTextEntry]);
    });

    it('merge restores default text entry when rehydrating with empty text', () => {
      interface MergePersistHandle {
        persist: {
          getOptions: () => {
            merge: (
              persisted: unknown,
              current: unknown
            ) => {
              selections: Record<LegacyModality, SelectedModelEntry[]>;
            };
          };
        };
      }
      const merge = (useModelStore as unknown as MergePersistHandle).persist.getOptions().merge;
      const current = useModelStore.getState();
      const merged = merge(
        {
          activeModality: 'text',
          selections: { text: [], image: [], audio: [], video: [] },
        },
        current
      );
      expect(merged.selections.text).toEqual([defaultTextEntry]);
    });
  });

  describe('pickerMode', () => {
    it('defaults pickerMode to single for every modality', () => {
      const { pickerMode } = useModelStore.getState();
      expect(pickerMode.text).toBe('single');
      expect(pickerMode.image).toBe('single');
      expect(pickerMode.audio).toBe('single');
      expect(pickerMode.video).toBe('single');
    });

    it('setPickerMode updates only the given modality', () => {
      useModelStore.getState().setPickerMode('text', 'multi');
      const state = useModelStore.getState();
      expect(state.pickerMode.text).toBe('multi');
      expect(state.pickerMode.image).toBe('single');
      expect(state.pickerMode.audio).toBe('single');
      expect(state.pickerMode.video).toBe('single');
    });

    it('setPickerMode supports independent modes per modality', () => {
      useModelStore.getState().setPickerMode('text', 'multi');
      useModelStore.getState().setPickerMode('image', 'single');
      useModelStore.getState().setPickerMode('video', 'multi');
      const state = useModelStore.getState();
      expect(state.pickerMode.text).toBe('multi');
      expect(state.pickerMode.image).toBe('single');
      expect(state.pickerMode.video).toBe('multi');
      expect(state.pickerMode.audio).toBe('single');
    });

    it('setPickerMode preserves the pickerMode reference when value is unchanged', () => {
      const before = useModelStore.getState().pickerMode;
      useModelStore.getState().setPickerMode('text', 'single');
      expect(useModelStore.getState().pickerMode).toBe(before);
    });

    it('setPickerMode produces a new pickerMode reference on actual change', () => {
      const before = useModelStore.getState().pickerMode;
      useModelStore.getState().setPickerMode('text', 'multi');
      expect(useModelStore.getState().pickerMode).not.toBe(before);
    });

    it('resetForUnauthenticated resets pickerMode to single across modalities', () => {
      useModelStore.getState().setPickerMode('text', 'multi');
      useModelStore.getState().setPickerMode('image', 'multi');
      useModelStore.getState().resetForUnauthenticated();
      const { pickerMode } = useModelStore.getState();
      expect(pickerMode.text).toBe('single');
      expect(pickerMode.image).toBe('single');
      expect(pickerMode.audio).toBe('single');
      expect(pickerMode.video).toBe('single');
    });
  });

  describe('getPrimaryModel helper', () => {
    it('returns the first entry of the given list', () => {
      const entries: SelectedModelEntry[] = [
        { id: 'claude', name: 'Claude' },
        { id: 'gpt-4', name: 'GPT-4' },
      ];
      expect(getPrimaryModel(entries)).toEqual({ id: 'claude', name: 'Claude' });
    });

    it('falls back to the default text entry when list is empty and modality is text', () => {
      expect(getPrimaryModel([], 'text')).toEqual(defaultTextEntry);
    });

    it('falls back to the default text entry when list is empty and modality is omitted', () => {
      expect(getPrimaryModel([])).toEqual(defaultTextEntry);
    });

    it('falls back to a blank entry when list is empty and modality is image', () => {
      expect(getPrimaryModel([], 'image')).toEqual({ id: '', name: '' });
    });

    it('falls back to a blank entry when list is empty and modality is video', () => {
      expect(getPrimaryModel([], 'video')).toEqual({ id: '', name: '' });
    });
  });

  describe('video model selection re-snaps videoConfig', () => {
    // Previously the duration / resolution / aspect-ratio snap lived inside an
    // effect in modality-config-panel.tsx, which only fired when the panel was
    // mounted. A user who selected Veo 3.0 (supports 5s), closed the panel,
    // then switched to Veo 3.1 (does not support 5s) and hit Send sent the
    // stale `5` to the gateway and got a runtime "Unsupported duration" error.
    // The snap now lives in the store so it always runs.

    it('snaps duration to nearest supported when video model changes via setSelectedModels', () => {
      useModelStore.setState({
        videoConfig: { aspectRatio: '16:9', durationSeconds: 5, resolution: '720p' },
      });

      useModelStore.getState().setSelectedModels('video', [{ id: VEO_31, name: 'Veo 3.1' }]);

      // Veo 3.1 supports [4, 6, 8]; 5 snaps to 4 (floor on tie).
      expect(useModelStore.getState().videoConfig.durationSeconds).toBe(4);
    });

    it('snaps duration when video model changes via toggleModel', () => {
      // Select Veo 3.0 first, then user moves duration to 5 (its native default).
      useModelStore.getState().setSelectedModels('video', [{ id: VEO_30, name: 'Veo 3.0' }]);
      useModelStore.setState({
        videoConfig: { aspectRatio: '16:9', durationSeconds: 5, resolution: '720p' },
      });

      // Switch to Veo 3.1 via toggle: deselect old, select new.
      useModelStore.getState().toggleModel('video', { id: VEO_30, name: 'Veo 3.0' });
      useModelStore.getState().toggleModel('video', { id: VEO_31, name: 'Veo 3.1' });

      expect(useModelStore.getState().videoConfig.durationSeconds).toBe(4);
    });

    it('snaps duration when removeModel changes the video selection', () => {
      useModelStore.setState({
        selections: {
          ...useModelStore.getState().selections,
          video: [
            { id: VEO_31, name: 'Veo 3.1' },
            { id: VEO_30, name: 'Veo 3.0' },
          ],
        },
        videoConfig: { aspectRatio: '16:9', durationSeconds: 5, resolution: '720p' },
      });

      // Remove Veo 3.0; only Veo 3.1 left.
      useModelStore.getState().removeModel('video', VEO_30);

      expect(useModelStore.getState().videoConfig.durationSeconds).toBe(4);
    });

    it('does not re-snap when the value is already supported', () => {
      useModelStore.setState({
        videoConfig: { aspectRatio: '16:9', durationSeconds: 6, resolution: '720p' },
      });

      useModelStore.getState().setSelectedModels('video', [{ id: VEO_31, name: 'Veo 3.1' }]);

      expect(useModelStore.getState().videoConfig.durationSeconds).toBe(6);
    });

    it('snaps resolution when video model changes to one that does not support the current resolution', () => {
      // 4k is Veo 3.1 only; switching to Veo 3.0 must snap it to a supported value.
      useModelStore.setState({
        videoConfig: { aspectRatio: '16:9', durationSeconds: 6, resolution: '4k' },
      });

      useModelStore.getState().setSelectedModels('video', [{ id: VEO_30, name: 'Veo 3.0' }]);

      // Veo 3.0 supports ['720p', '1080p']; 4k isn't in the set so falls back
      // to the first supported resolution.
      expect(useModelStore.getState().videoConfig.resolution).toBe('720p');
    });

    it('leaves videoConfig untouched when no video model is selected', () => {
      const before = useModelStore.getState().videoConfig;
      useModelStore.getState().setSelectedModels('video', []);
      expect(useModelStore.getState().videoConfig).toEqual(before);
    });

    it('does not touch videoConfig when a non-video modality selection changes', () => {
      useModelStore.setState({
        videoConfig: { aspectRatio: '16:9', durationSeconds: 5, resolution: '720p' },
      });
      useModelStore
        .getState()
        .setSelectedModels('image', [{ id: 'google/imagen-4.0-generate-001', name: 'Imagen 4' }]);
      expect(useModelStore.getState().videoConfig.durationSeconds).toBe(5);
    });
  });
});
