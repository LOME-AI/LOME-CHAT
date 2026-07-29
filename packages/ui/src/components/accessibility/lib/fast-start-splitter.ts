// The sentence-ordinal → word-threshold → pieces policy, shared by every
// caller that turns a sequence of sentences into speak-pieces (the chat stream
// feeder, the document reader, the DOM-observer fallback). It is shared because
// its correctness depends on being identical everywhere: a reader that split at
// a different threshold than chat would produce a different chunk stream for
// the same prose.
//
// What is deliberately NOT shared is the chunker-and-flush machinery around it.
// The feeder flushes at end-of-stream and the reader at end-of-block, and one
// chunker reused across a document would carry its code-fence flag between
// blocks (flush() clears the buffer, not the flag), so a stray fence in prose
// would swallow the rest of the text. Each caller keeps its own chunking
// lifecycle and shares only this policy.
//
// The counter spans one read: the "opening sentences" are the opening sentences
// of the whole stream or document, never of each block.

import { SPLIT_WORD_THRESHOLD, splitSentence } from './sentence-splitter';

/**
 * The opening sentences of a read use a halved word threshold so they split
 * more aggressively and the listener hears audio sooner. Downstream sentences
 * are synthesized in parallel with playback, so splitting past this count is
 * wasted overhead.
 */
export const FAST_START_SENTENCE_COUNT = 3;

export interface FastStartSplitter {
  /** Split one sentence into speak-pieces, counting it against the budget. */
  split(sentence: string): string[];
}

/** Create a splitter whose fast-start budget spans one stream or document. */
export function createFastStartSplitter(): FastStartSplitter {
  let sentenceCount = 0;
  return {
    split(sentence: string): string[] {
      const threshold =
        sentenceCount < FAST_START_SENTENCE_COUNT
          ? Math.ceil(SPLIT_WORD_THRESHOLD / 2)
          : SPLIT_WORD_THRESHOLD;
      sentenceCount += 1;
      return splitSentence(sentence, threshold);
    },
  };
}
