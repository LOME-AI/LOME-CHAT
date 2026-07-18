export interface EmphasisParts {
  before: string;
  /** The emphasis word, or '' when there is no emphasis to accent. */
  word: string;
  after: string;
}

/**
 * Split a caption into the text before the emphasis word, the word itself, and
 * the text after — so the word can render in the brand accent. Splits on the
 * first occurrence; an absent or unmatched emphasis leaves the whole caption in
 * `before` with no accent.
 */
export function splitEmphasis(text: string, emphasis?: string): EmphasisParts {
  if (emphasis === undefined || emphasis === '') {
    return { before: text, word: '', after: '' };
  }
  const index = text.indexOf(emphasis);
  if (index === -1) {
    return { before: text, word: '', after: '' };
  }
  return {
    before: text.slice(0, index),
    word: emphasis,
    after: text.slice(index + emphasis.length),
  };
}
