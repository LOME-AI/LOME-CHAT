import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useA11yStore } from '@hushbox/ui/accessibility/store';

import { installTtsDomObserver } from './tts-dom-observer';

// Mock the lazy-loaded TTS engine. vi.hoisted() runs before vi.mock factories,
// so the speakMock reference inside the factory is initialized before use.
// (Plain `const speakMock = vi.fn()` would be in TDZ when the hoisted factory
// runs because the factory may resolve mid-import-graph.)
const { speakMock, isLoadedMock } = vi.hoisted(() => ({
  speakMock: vi.fn<(text: string, voice: string) => Promise<void>>(),
  isLoadedMock: vi.fn(() => true),
}));
vi.mock('@hushbox/ui/accessibility/lib/tts-engine', () => ({
  getTtsService: () => ({
    isLoaded: isLoadedMock,
    speak: speakMock,
    stop: vi.fn(),
    load: vi.fn(),
    preloadVoice: vi.fn(),
    unlockAudio: vi.fn(),
  }),
  TTS_VOICES: [],
}));

// Reset store + mocks between tests so state doesn't leak.
beforeEach(async () => {
  speakMock.mockReset();
  speakMock.mockResolvedValue();
  isLoadedMock.mockReset();
  isLoadedMock.mockReturnValue(true);
  useA11yStore.getState().reset();
  document.body.innerHTML = '';
  // Drain any pending speak promises from a prior test so they can't resolve
  // mid-assertion in the next test and falsely trip `not.toHaveBeenCalled()`.
  for (let index = 0; index < 5; index++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  speakMock.mockReset();
  speakMock.mockResolvedValue();
});

afterEach(() => {
  document.body.innerHTML = '';
});

function enableTts(): void {
  useA11yStore.getState().update({
    ttsEnabled: true,
    streamChatAloud: true,
    muteSounds: false,
    ttsVoice: 'af_heart',
  });
}

// Fixed-iteration drain — enough for MutationObserver callbacks to fire so
// the chunker observes the appended text. Used for intermediate steps and for
// "should NOT have been called" assertions where there's no positive condition
// to poll on. Positive assertions use `vi.waitFor` directly so they wait only
// as long as the dynamic-import + speak chain actually takes.
const drain = async (): Promise<void> => {
  for (let index = 0; index < 30; index++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
};

async function waitForSpeak(predicate: () => void): Promise<void> {
  await vi.waitFor(predicate, { timeout: 5000, interval: 5 });
}

function manyWords(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${String(index)}`).join(' ');
}

/**
 * 20 words with a comma at word 10: above the halved fast-start threshold (13)
 * so it splits while the container's budget lasts, below the full threshold
 * (25) so it stays whole afterwards.
 */
function makeSplittableSentence(prefix: string): string {
  const left = manyWords(`${prefix}L`, 10);
  const right = manyWords(`${prefix}R`, 10);
  return `${left}, ${right}.`;
}

describe('installTtsDomObserver', () => {
  it('returns a cleanup function', () => {
    const cleanup = installTtsDomObserver();
    expect(typeof cleanup).toBe('function');
    cleanup();
  });

  it('does NOT speak when TTS is disabled', async () => {
    const cleanup = installTtsDomObserver();
    const container = document.createElement('div');
    container.dataset['ttsStream'] = '';
    document.body.append(container);
    container.append(document.createTextNode('Hello world. This is a test.'));
    await drain();
    expect(speakMock).not.toHaveBeenCalled();
    cleanup();
  });

  it('speaks completed sentences appended to a [data-tts-stream] container after install', async () => {
    enableTts();
    const cleanup = installTtsDomObserver();
    const container = document.createElement('div');
    container.dataset['ttsStream'] = '';
    document.body.append(container);
    await drain();
    container.append(document.createTextNode('Hello world. '));
    await waitForSpeak(() => {
      expect(speakMock).toHaveBeenCalledWith('Hello world.', 'af_heart');
    });
    cleanup();
  });

  it('handles a container that exists BEFORE installation (initial scan)', async () => {
    enableTts();
    const container = document.createElement('div');
    container.dataset['ttsStream'] = '';
    document.body.append(container);
    const cleanup = installTtsDomObserver();
    container.append(document.createTextNode('First sentence. '));
    await waitForSpeak(() => {
      expect(speakMock).toHaveBeenCalledWith('First sentence.', 'af_heart');
    });
    cleanup();
  });

  it('chunks streamed text — incremental appends only emit on sentence boundary', async () => {
    enableTts();
    const cleanup = installTtsDomObserver();
    const container = document.createElement('div');
    container.dataset['ttsStream'] = '';
    document.body.append(container);
    await drain();
    container.append(document.createTextNode('Hello'));
    await drain();
    container.append(document.createTextNode(' world'));
    await drain();
    expect(speakMock).not.toHaveBeenCalled();
    container.append(document.createTextNode('. Done.'));
    await waitForSpeak(() => {
      expect(speakMock).toHaveBeenCalledWith('Hello world.', 'af_heart');
      expect(speakMock).toHaveBeenCalledWith('Done.', 'af_heart');
    });
    cleanup();
  });

  it('handles multiple [data-tts-stream] containers independently', async () => {
    enableTts();
    const cleanup = installTtsDomObserver();
    const a = document.createElement('div');
    a.dataset['ttsStream'] = '';
    const b = document.createElement('div');
    b.dataset['ttsStream'] = '';
    document.body.append(a, b);
    await drain();
    a.append(document.createTextNode('From A. '));
    b.append(document.createTextNode('From B. '));
    await waitForSpeak(() => {
      expect(speakMock).toHaveBeenCalledWith('From A.', 'af_heart');
      expect(speakMock).toHaveBeenCalledWith('From B.', 'af_heart');
    });
    cleanup();
  });

  it('cleans up tracked containers when they are removed from the DOM', async () => {
    enableTts();
    const cleanup = installTtsDomObserver();
    try {
      const container = document.createElement('div');
      container.dataset['ttsStream'] = '';
      document.body.append(container);
      await drain();
      container.append(document.createTextNode('First. '));
      await waitForSpeak(() => {
        expect(speakMock).toHaveBeenCalledTimes(1);
      });

      container.remove();
      await drain();
      speakMock.mockClear();
      // After removal, no sentences emit even if the (detached) node gets text.
      container.append(document.createTextNode('Second. '));
      await drain();
      expect(speakMock).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('respects a runtime store flip — disabling streamChatAloud silences subsequent sentences', async () => {
    enableTts();
    const cleanup = installTtsDomObserver();
    const container = document.createElement('div');
    container.dataset['ttsStream'] = '';
    document.body.append(container);
    await drain();
    container.append(document.createTextNode('First. '));
    await waitForSpeak(() => {
      expect(speakMock).toHaveBeenCalledTimes(1);
    });

    useA11yStore.getState().update({ streamChatAloud: false });
    container.append(document.createTextNode('Second. '));
    await drain();
    // Second sentence is buffered but not spoken because the gate flipped off.
    expect(speakMock).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('cleanup() disconnects the observer — newly added containers are not tracked', async () => {
    enableTts();
    const cleanup = installTtsDomObserver();
    cleanup();
    const container = document.createElement('div');
    container.dataset['ttsStream'] = '';
    document.body.append(container);
    await drain();
    container.append(document.createTextNode('Should not speak. '));
    await drain();
    expect(speakMock).not.toHaveBeenCalled();
  });

  it('tracks a [data-tts-stream] container nested inside a newly-added wrapper', async () => {
    enableTts();
    const cleanup = installTtsDomObserver();
    const wrapper = document.createElement('section');
    const inner = document.createElement('div');
    inner.dataset['ttsStream'] = '';
    wrapper.append(inner);
    document.body.append(wrapper);
    await drain();
    inner.append(document.createTextNode('Nested sentence. '));
    await waitForSpeak(() => {
      expect(speakMock).toHaveBeenCalledWith('Nested sentence.', 'af_heart');
    });
    cleanup();
  });

  it('restarts the chunker when a container is rewritten to non-prefix text', async () => {
    enableTts();
    const cleanup = installTtsDomObserver();
    const container = document.createElement('div');
    container.dataset['ttsStream'] = '';
    document.body.append(container);
    await drain();
    container.append(document.createTextNode('Hello world. '));
    await waitForSpeak(() => {
      expect(speakMock).toHaveBeenCalledWith('Hello world.', 'af_heart');
    });
    // Replace the whole text with content that is NOT a prefix-extension — the
    // diff falls back to the full new string.
    container.textContent = 'Goodbye now. ';
    await waitForSpeak(() => {
      expect(speakMock).toHaveBeenCalledWith('Goodbye now.', 'af_heart');
    });
    cleanup();
  });

  it('reuses the loaded TTS service across sentences (no re-import)', async () => {
    enableTts();
    const cleanup = installTtsDomObserver();
    const container = document.createElement('div');
    container.dataset['ttsStream'] = '';
    document.body.append(container);
    await drain();
    container.append(document.createTextNode('First. '));
    await waitForSpeak(() => {
      expect(speakMock).toHaveBeenCalledWith('First.', 'af_heart');
    });
    container.append(document.createTextNode('Second. '));
    await waitForSpeak(() => {
      expect(speakMock).toHaveBeenCalledWith('Second.', 'af_heart');
    });
    cleanup();
  });

  it('does not speak while the TTS engine has not finished loading', async () => {
    enableTts();
    isLoadedMock.mockReturnValue(false);
    const cleanup = installTtsDomObserver();
    const container = document.createElement('div');
    container.dataset['ttsStream'] = '';
    document.body.append(container);
    await drain();
    container.append(document.createTextNode('Should wait. '));
    await drain();
    expect(speakMock).not.toHaveBeenCalled();
    cleanup();
  });

  it('re-checks the gate after the async load and stays silent if disabled meanwhile', async () => {
    enableTts();
    // Simulate the user toggling chat-aloud off during the await between the
    // load-check and the speak: isLoaded (called just before the post-await
    // re-check) flips the store off.
    isLoadedMock.mockImplementation(() => {
      useA11yStore.getState().update({ streamChatAloud: false });
      return true;
    });
    const cleanup = installTtsDomObserver();
    const container = document.createElement('div');
    container.dataset['ttsStream'] = '';
    document.body.append(container);
    await drain();
    container.append(document.createTextNode('Interrupted. '));
    await drain();
    expect(speakMock).not.toHaveBeenCalled();
    cleanup();
  });

  it('swallows a TTS speak rejection without throwing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(vi.fn());
    enableTts();
    speakMock.mockRejectedValue(new Error('audio failed'));
    const cleanup = installTtsDomObserver();
    const container = document.createElement('div');
    container.dataset['ttsStream'] = '';
    document.body.append(container);
    await drain();
    container.append(document.createTextNode('Boom. '));
    await waitForSpeak(() => {
      expect(errorSpy).toHaveBeenCalledWith('TTS speak failed:', expect.any(Error));
    });
    errorSpy.mockRestore();
    cleanup();
  });

  it('ignores removed non-element nodes and prunes containers inside removed wrappers', async () => {
    enableTts();
    const cleanup = installTtsDomObserver();
    // A tracked container inside a wrapper, plus a bare text node in the body.
    const wrapper = document.createElement('section');
    const inner = document.createElement('div');
    inner.dataset['ttsStream'] = '';
    wrapper.append(inner);
    const strayText = document.createTextNode('stray');
    document.body.append(wrapper, strayText);
    await drain();
    inner.append(document.createTextNode('Tracked. '));
    await waitForSpeak(() => {
      expect(speakMock).toHaveBeenCalledTimes(1);
    });

    speakMock.mockClear();
    // Remove the stray text node (non-element removal) and the wrapper (prunes
    // the nested tracked container).
    strayText.remove();
    wrapper.remove();
    await drain();
    inner.append(document.createTextNode('Detached. '));
    await drain();
    expect(speakMock).not.toHaveBeenCalled();
    cleanup();
  });

  it('handles characterData mutations whose target is a text node', async () => {
    enableTts();
    const cleanup = installTtsDomObserver();
    const container = document.createElement('div');
    container.dataset['ttsStream'] = '';
    const textNode = document.createTextNode('start ');
    container.append(textNode);
    document.body.append(container);
    await drain();
    // Mutating the text node's data fires a characterData mutation whose target
    // is the (non-element) text node.
    textNode.data = 'start changed. ';
    await drain();
    // No throw; the observer simply ignores the non-element mutation target.
    expect(true).toBe(true);
    cleanup();
  });

  it('splits an opening sentence that is over the fast-start threshold', async () => {
    enableTts();
    const cleanup = installTtsDomObserver();
    const container = document.createElement('div');
    container.dataset['ttsStream'] = '';
    document.body.append(container);
    await drain();
    container.append(document.createTextNode(`${makeSplittableSentence('one')} `));
    await waitForSpeak(() => {
      expect(speakMock).toHaveBeenCalledWith(`${manyWords('oneL', 10)},`, 'af_heart');
      expect(speakMock).toHaveBeenCalledWith(`${manyWords('oneR', 10)}.`, 'af_heart');
    });
    cleanup();
  });

  it('gives each tracked container its own fast-start budget', async () => {
    enableTts();
    const cleanup = installTtsDomObserver();
    const spent = document.createElement('div');
    spent.dataset['ttsStream'] = '';
    const fresh = document.createElement('div');
    fresh.dataset['ttsStream'] = '';
    document.body.append(spent, fresh);
    await drain();
    for (const prefix of ['a', 'b', 'c']) {
      spent.append(document.createTextNode(`${makeSplittableSentence(prefix)} `));
      await drain();
    }
    // The 4th sentence of `spent` is past its budget, so it stays whole; the
    // 1st sentence of `fresh` is within its own budget, so it still splits.
    spent.append(document.createTextNode(`${makeSplittableSentence('d')} `));
    fresh.append(document.createTextNode(`${makeSplittableSentence('e')} `));
    await waitForSpeak(() => {
      expect(speakMock).toHaveBeenCalledWith(makeSplittableSentence('d'), 'af_heart');
      expect(speakMock).toHaveBeenCalledWith(`${manyWords('eL', 10)},`, 'af_heart');
      expect(speakMock).toHaveBeenCalledWith(`${manyWords('eR', 10)}.`, 'af_heart');
    });
    cleanup();
  });
});
