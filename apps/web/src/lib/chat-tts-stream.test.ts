import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock kokoro-js itself so the model loader (and transformers.js / espeak-ng)
// never run inside vitest. The chunker/feeder are real; only the audio
// engine is faked.
const { speakMock, isLoadedMock, stopMock } = vi.hoisted(() => ({
  speakMock: vi.fn((): Promise<void> => Promise.resolve()),
  isLoadedMock: vi.fn(() => true),
  stopMock: vi.fn(),
}));

vi.mock('kokoro-js', () => ({
  KokoroTTS: {
    from_pretrained: vi.fn(() =>
      Promise.resolve({
        generate: vi.fn(() =>
          Promise.resolve({
            audio: new Float32Array(0),
            sampling_rate: 24_000,
          })
        ),
      })
    ),
  },
}));

// Override the TTS singleton so we can inspect speak() without exercising audio.
vi.mock('@hushbox/ui/accessibility/lib/tts-engine', () => ({
  getTtsService: () => ({
    load: vi.fn((): Promise<void> => Promise.resolve()),
    isLoaded: isLoadedMock,
    preloadVoice: vi.fn((): Promise<void> => Promise.resolve()),
    speak: speakMock,
    stop: stopMock,
    unlockAudio: vi.fn(),
  }),
}));

import { ACCESSIBILITY_PREFERENCES_DEFAULTS } from '@hushbox/shared';
import { useA11yStore, useTtsPlaybackStore } from '@hushbox/ui/accessibility/store';
import { startChatTtsStream, stopTtsForMessage } from './chat-tts-stream';

describe('startChatTtsStream', () => {
  beforeEach(() => {
    speakMock.mockReset();
    speakMock.mockImplementation((): Promise<void> => Promise.resolve());
    isLoadedMock.mockReset();
    isLoadedMock.mockReturnValue(true);
    stopMock.mockReset();
    useA11yStore.setState({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS });
    useTtsPlaybackStore.setState({
      speakingStreamId: null,
      stoppedStreamIds: new Set<string>(),
    });
  });

  afterEach(() => {
    useA11yStore.setState({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS });
    useTtsPlaybackStore.setState({
      speakingStreamId: null,
      stoppedStreamIds: new Set<string>(),
    });
  });

  it('returns null when ttsEnabled is false', async () => {
    useA11yStore.setState({ ttsEnabled: false, streamChatAloud: true });
    expect(await startChatTtsStream({ messageId: () => 'm1' })).toBeNull();
  });

  it('returns null when streamChatAloud is false', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: false });
    expect(await startChatTtsStream({ messageId: () => 'm1' })).toBeNull();
  });

  it('returns null when muteSounds is true (audio is muted)', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true, muteSounds: true });
    expect(await startChatTtsStream({ messageId: () => 'm1' })).toBeNull();
  });

  it('returns a feeder when ttsEnabled and streamChatAloud are both true', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
    const feeder = await startChatTtsStream({ messageId: () => 'm1' });
    expect(feeder).not.toBeNull();
    expect(typeof feeder?.feed).toBe('function');
    expect(typeof feeder?.end).toBe('function');
  });

  it('routes streamed sentences to TTS speak with current voice', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true, ttsVoice: 'bm_george' });
    const feeder = await startChatTtsStream({ messageId: () => 'm1' });
    feeder?.feed('Hello world. ');
    expect(speakMock).toHaveBeenCalledWith('Hello world.', 'bm_george');
  });

  it('end() flushes the buffer and speaks the trailing remainder', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true, ttsVoice: 'af_heart' });
    const feeder = await startChatTtsStream({ messageId: () => 'm1' });
    feeder?.feed('No boundary here');
    feeder?.end();
    expect(speakMock).toHaveBeenCalledWith('No boundary here', 'af_heart');
  });

  it('reads voice on each speak so toggles mid-stream are honored', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true, ttsVoice: 'af_heart' });
    const feeder = await startChatTtsStream({ messageId: () => 'm1' });
    feeder?.feed('First. ');
    useA11yStore.setState({ ttsVoice: 'bf_emma' });
    feeder?.feed('Second. ');
    expect(speakMock).toHaveBeenNthCalledWith(1, 'First.', 'af_heart');
    expect(speakMock).toHaveBeenNthCalledWith(2, 'Second.', 'bf_emma');
  });

  it('does not speak when the user disables streamChatAloud mid-stream', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
    const feeder = await startChatTtsStream({ messageId: () => 'm1' });
    feeder?.feed('First. ');
    expect(speakMock).toHaveBeenCalledTimes(1);
    useA11yStore.setState({ streamChatAloud: false });
    feeder?.feed('Second. ');
    expect(speakMock).toHaveBeenCalledTimes(1);
  });

  it('does not speak when mute is toggled on mid-stream', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true, muteSounds: false });
    const feeder = await startChatTtsStream({ messageId: () => 'm1' });
    feeder?.feed('First. ');
    expect(speakMock).toHaveBeenCalledTimes(1);
    useA11yStore.setState({ muteSounds: true });
    feeder?.feed('Second. ');
    expect(speakMock).toHaveBeenCalledTimes(1);
  });

  it('does not speak when TTS engine is not yet loaded', async () => {
    useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
    isLoadedMock.mockReturnValue(false);
    const feeder = await startChatTtsStream({ messageId: () => 'm1' });
    feeder?.feed('Hello. ');
    expect(speakMock).not.toHaveBeenCalled();
  });

  describe('playback store integration', () => {
    it('sets speakingStreamId on the first speak', async () => {
      useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
      const feeder = await startChatTtsStream({ messageId: () => 'msg-1' });
      feeder?.feed('Hi. ');
      expect(useTtsPlaybackStore.getState().speakingStreamId).toBe('msg-1');
    });

    it('does not set speakingStreamId before any speak occurs', async () => {
      useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
      await startChatTtsStream({ messageId: () => 'msg-1' });
      expect(useTtsPlaybackStore.getState().speakingStreamId).toBeNull();
    });

    it('clears speakingStreamId after end() once all speaks settle', async () => {
      useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
      const feeder = await startChatTtsStream({ messageId: () => 'msg-1' });
      feeder?.feed('Hi. ');
      feeder?.end();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(useTtsPlaybackStore.getState().speakingStreamId).toBeNull();
    });

    it('does not clobber the slot if a newer stream took it before end()', async () => {
      useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
      const feeder = await startChatTtsStream({ messageId: () => 'msg-1' });
      feeder?.feed('First. ');
      useTtsPlaybackStore.getState().setSpeakingStream('msg-2');
      feeder?.end();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(useTtsPlaybackStore.getState().speakingStreamId).toBe('msg-2');
    });

    it('is not muted (and speaks) while the message id is still null', async () => {
      // isStreamMuted short-circuits on the `id !== null` check when the id has
      // not arrived yet, so a not-yet-identified stream is never treated as
      // stopped and speech proceeds.
      useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
      const feeder = await startChatTtsStream({ messageId: () => null });
      feeder?.feed('Anonymous sentence. ');
      expect(speakMock).toHaveBeenCalledWith('Anonymous sentence.', expect.any(String));
    });

    it('suppresses speech for a stream marked stopped via the playback store', async () => {
      useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
      const feeder = await startChatTtsStream({ messageId: () => 'msg-1' });
      useTtsPlaybackStore.getState().markStreamStopped('msg-1');
      feeder?.feed('Should not be spoken. ');
      expect(speakMock).not.toHaveBeenCalled();
    });

    it('still speaks for a stream that was not stopped', async () => {
      useA11yStore.setState({ ttsEnabled: true, streamChatAloud: true });
      useTtsPlaybackStore.getState().markStreamStopped('other-msg');
      const feeder = await startChatTtsStream({ messageId: () => 'msg-1' });
      feeder?.feed('Hi. ');
      expect(speakMock).toHaveBeenCalledWith('Hi.', expect.any(String));
    });
  });
});

describe('stopTtsForMessage', () => {
  beforeEach(() => {
    stopMock.mockReset();
    useTtsPlaybackStore.setState({
      speakingStreamId: null,
      stoppedStreamIds: new Set<string>(),
    });
  });

  it('adds the message id to stoppedStreamIds', () => {
    stopTtsForMessage('msg-1');
    expect(useTtsPlaybackStore.getState().stoppedStreamIds.has('msg-1')).toBe(true);
  });

  it('clears the speakingStreamId when it matches the stopped id', () => {
    useTtsPlaybackStore.getState().setSpeakingStream('msg-1');
    stopTtsForMessage('msg-1');
    expect(useTtsPlaybackStore.getState().speakingStreamId).toBeNull();
  });

  it('leaves a non-matching speakingStreamId alone', () => {
    useTtsPlaybackStore.getState().setSpeakingStream('msg-other');
    stopTtsForMessage('msg-1');
    expect(useTtsPlaybackStore.getState().speakingStreamId).toBe('msg-other');
  });

  it('calls the TTS service stop method to flush the audio queue', async () => {
    stopTtsForMessage('msg-1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopMock).toHaveBeenCalledTimes(1);
  });
});
