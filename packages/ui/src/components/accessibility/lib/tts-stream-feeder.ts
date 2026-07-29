// Streaming TTS feeder. Adapts the SentenceChunker to a streamed
// AI chat response: caller pumps tokens via feed(); the feeder emits
// completed sentences to the TTS service. When the stream ends,
// end() flushes the chunker and speaks any trailing buffered text.
//
// Decoupled from React/Zustand so it can be unit-tested in isolation.
// Wire-up uses callbacks (`isEnabled`, `voice`) so the caller can pull
// reactive state from any source (Zustand store, React state, etc.).
//
// Stream lifecycle hooks (`onStreamStart` / `onStreamEnd`) and the
// per-stream `isStreamMuted` gate exist so callers can drive an in-UI
// "Stop reading" affordance: mark a stream as muted to suppress any
// further sentences mid-flight, and observe start/end to track which
// message's audio is currently active.

import { createFastStartSplitter } from './fast-start-splitter';
import { SentenceChunker } from './sentence-chunker';
import type { TtsService, TtsVoice } from './tts-engine';

export interface TtsStreamFeeder {
  /** Feed a streamed token chunk. Speaks any newly-completed sentences. */
  feed(chunk: string): void;
  /** End-of-stream. Flushes the chunker and speaks any trailing remainder. */
  end(): void;
}

export interface CreateTtsStreamFeederOptions {
  readonly tts: TtsService;
  /** Voice id, or a callback that returns the current voice (for live updates). */
  readonly voice: TtsVoice | (() => TtsVoice);
  /**
   * Callback returning whether the feeder should be active. Called on every
   * sentence boundary so the user can flip the toggle mid-stream.
   */
  readonly isEnabled: () => boolean;
  /**
   * Optional per-stream short-circuit. Returning true suppresses speaking
   * without disabling the global toggle. Used by the chat-aloud Stop
   * button to silence a single message while leaving auto-read on.
   */
  readonly isStreamMuted?: () => boolean;
  /** Fires once, just before the first speak() of the stream. */
  readonly onStreamStart?: () => void;
  /**
   * Fires from end() after every issued speak() promise has settled
   * (or synchronously from end() if none were ever issued).
   */
  readonly onStreamEnd?: () => void;
}

/**
 * Create a feeder that bridges streamed AI tokens to the TTS service.
 * Caller is responsible for invoking feed() and end() at the right moments.
 */
export function createTtsStreamFeeder(options: CreateTtsStreamFeederOptions): TtsStreamFeeder {
  const { tts, voice, isEnabled, isStreamMuted, onStreamStart, onStreamEnd } = options;
  const chunker = new SentenceChunker();
  // One splitter per feeder: the fast-start budget is spent on the opening
  // sentences of this stream.
  const splitter = createFastStartSplitter();
  let started = false;
  let endCalled = false;
  let pendingSpeaks = 0;

  function tryFinish(): void {
    if (endCalled && pendingSpeaks === 0) {
      onStreamEnd?.();
    }
  }

  function speakSplit(sentence: string): void {
    for (const piece of splitter.split(sentence)) {
      attemptSpeak(piece);
    }
  }

  function attemptSpeak(text: string): void {
    if (!isEnabled() || !tts.isLoaded()) return;
    if (isStreamMuted?.()) return;
    if (!started) {
      started = true;
      onStreamStart?.();
    }
    const resolvedVoice = typeof voice === 'function' ? voice() : voice;
    pendingSpeaks += 1;
    // Speak failures must not break the chat stream — surface to console only.
    void (async (): Promise<void> => {
      try {
        await tts.speak(text, resolvedVoice);
      } catch (error: unknown) {
        console.error('TTS speak failed:', error);
      } finally {
        pendingSpeaks -= 1;
        tryFinish();
      }
    })();
  }

  return {
    feed(chunk: string): void {
      // Always feed so the chunker stays in sync, but only speak when active.
      const sentences = chunker.feed(chunk);
      for (const sentence of sentences) {
        speakSplit(sentence);
      }
    },
    end(): void {
      const remainder = chunker.flush();
      if (remainder !== null) speakSplit(remainder);
      endCalled = true;
      tryFinish();
    },
  };
}
