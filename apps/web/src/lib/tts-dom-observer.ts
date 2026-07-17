// DOM-observer fallback for streaming TTS.
//
// `chat-tts-stream.ts` wires the existing chat SSE pipeline directly into the
// TTS feeder — that's the fast path. This file is the *self-applying* path
// described in the accessibility plan ("Maintainability automation"): any
// surface that renders streamed text into a [data-tts-stream] container gets
// chat-aloud for free, without a per-feature wiring step.
//
// Mount once at app root via `installTtsDomObserver()`. The observer:
//   - scans existing [data-tts-stream] containers at install time
//   - tracks new ones inserted later via MutationObserver
//   - per container, accumulates text via SentenceChunker and speaks completed
//     sentences through the same TTS service used by the explicit path
//   - drops a container when it's removed from the DOM
//   - re-checks the store gate (ttsEnabled / streamChatAloud / muteSounds) on
//     every sentence boundary so flipping the toggle mid-stream silences output
//
// Like chat-tts-stream.ts, the heavy kokoro-js bundle is only imported once a
// user has actually opted into chat-aloud.

import { SentenceChunker } from '@hushbox/ui/accessibility/lib/sentence-chunker';
import { useA11yStore } from '@hushbox/ui/accessibility/store';
import type { TtsService, TtsVoice } from '@hushbox/ui/accessibility/lib/tts-engine';

const TARGET_SELECTOR = '[data-tts-stream]';

interface TrackedContainer {
  chunker: SentenceChunker;
  lastText: string;
}

function isStreamEnabled(): boolean {
  const state = useA11yStore.getState();
  return state.ttsEnabled && state.streamChatAloud && !state.muteSounds;
}

function speak(tts: TtsService, sentence: string, voice: TtsVoice): void {
  void (async () => {
    try {
      await tts.speak(sentence, voice);
    } catch (error: unknown) {
      console.error('TTS speak failed:', error);
    }
  })();
}

function diffText(previous: string, current: string): string {
  // The container's textContent is the source of truth on every mutation, but
  // the chunker only wants the NEW characters (not a re-feed of the whole
  // string). When the new text is a strict prefix-extension we can take the
  // suffix; otherwise the container was rewritten and we restart.
  if (current.startsWith(previous)) return current.slice(previous.length);
  return current;
}

/**
 * Install the DOM-observer fallback for streaming TTS. Returns a cleanup
 * function that disconnects the observer and clears tracked containers.
 */
export function installTtsDomObserver(): () => void {
  const tracked = new WeakMap<Element, TrackedContainer>();
  let ttsService: TtsService | null = null;
  let ttsServicePromise: Promise<TtsService> | null = null;

  async function getOrLoadTtsService(): Promise<TtsService> {
    if (ttsService !== null) return ttsService;
    ttsServicePromise ??= (async () => {
      const { getTtsService } = await import('@hushbox/ui/accessibility/lib/tts-engine');
      const service = getTtsService();
      ttsService = service;
      return service;
    })();
    return ttsServicePromise;
  }

  function trackContainer(el: Element): void {
    // A container is only ever tracked once: the MutationObserver never
    // re-delivers an already-attached node as an addedNode (a move fires a
    // removal first, which untracks it), so this double-track guard is a
    // defensive no-op that cannot be reached through the observer.
    /* v8 ignore next */
    if (tracked.has(el)) return;
    tracked.set(el, { chunker: new SentenceChunker(), lastText: el.textContent });
  }

  function processContainer(el: Element): void {
    const entry = tracked.get(el);
    // `dirty` is built only from tracked containers still attached to the
    // document, and an attached container cannot also have been untracked in the
    // same batch (untracking requires removal), so `entry` is always defined here.
    /* v8 ignore next */
    if (entry === undefined) return;
    const current = el.textContent;
    const delta = diffText(entry.lastText, current);
    entry.lastText = current;
    if (delta.length === 0) return;
    const sentences = entry.chunker.feed(delta);
    if (sentences.length === 0) return;
    if (!isStreamEnabled()) return;
    void (async () => {
      const tts = await getOrLoadTtsService();
      if (!tts.isLoaded()) return;
      // Re-check the gate after the await — user may have toggled mid-stream.
      if (!isStreamEnabled()) return;
      const voice = useA11yStore.getState().ttsVoice;
      for (const sentence of sentences) speak(tts, sentence, voice);
    })();
  }

  function handleAddedNode(node: Node): void {
    if (!(node instanceof Element)) return;
    if (node.matches(TARGET_SELECTOR)) trackContainer(node);
    for (const nested of node.querySelectorAll(TARGET_SELECTOR)) trackContainer(nested);
  }

  function handleRemovedNode(node: Node): void {
    if (!(node instanceof Element)) return;
    tracked.delete(node);
    for (const nested of node.querySelectorAll(TARGET_SELECTOR)) tracked.delete(nested);
  }

  function findDirtyContainers(target: EventTarget | null, dirty: Set<Element>): void {
    if (!(target instanceof Element)) return;
    for (const el of document.querySelectorAll(TARGET_SELECTOR)) {
      if (tracked.has(el) && (el === target || el.contains(target))) dirty.add(el);
    }
  }

  function handleMutation(mutation: MutationRecord, dirty: Set<Element>): void {
    for (const added of mutation.addedNodes) handleAddedNode(added);
    for (const removed of mutation.removedNodes) handleRemovedNode(removed);
    findDirtyContainers(mutation.target, dirty);
  }

  // Initial scan — pick up containers that exist before install.
  for (const el of document.querySelectorAll(TARGET_SELECTOR)) {
    trackContainer(el);
  }

  const observer = new MutationObserver((mutations) => {
    const dirty = new Set<Element>();
    for (const mutation of mutations) handleMutation(mutation, dirty);
    for (const el of dirty) processContainer(el);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  return () => {
    observer.disconnect();
  };
}
