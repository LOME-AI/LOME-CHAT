/**
 * Canonical inline reasoning format: an assistant message's text field may
 * embed the model's reasoning ahead of the answer as
 * `<think>reasoning</think>\n\nanswer` — the de-facto convention reasoning
 * models themselves emit. This module is the ONLY code that reads or writes
 * the delimiter; client display, optimistic-message assembly, and server
 * history-replay stripping all import it. The delimiter strings deliberately
 * stay module-private to enforce that.
 *
 * A literal delimiter token inside the reasoning or answer payloads is outside
 * the round-trip contract: parsing is anchored to the first close delimiter
 * (required by the streaming-partial grammar, where the close tag may not have
 * arrived yet), so a payload-embedded token would shift the split.
 */

const OPEN_DELIMITER = '<think>';
const CLOSE_DELIMITER = '</think>';
const ANSWER_SEPARATOR = '\n\n';

export interface ParsedReasoningText {
  /**
   * Reasoning text between the delimiters. Undefined when the text carried no
   * leading delimiter; empty string when a delimiter opened with nothing
   * (yet) inside it.
   */
  reasoning?: string;
  answer: string;
}

/**
 * Splits assistant text into reasoning and answer. Tolerant by design:
 * - no leading delimiter (mid-text occurrences do not count) → all answer;
 * - leading whitespace before a natively-emitted delimiter is accepted;
 * - unclosed delimiter (streaming partial) → everything after the open tag is
 *   reasoning-so-far, answer is empty;
 * - exactly one serializer-emitted separator after the close delimiter is
 *   stripped, so serialize→parse round-trips byte-exactly.
 */
export function parseReasoningText(text: string): ParsedReasoningText {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(OPEN_DELIMITER)) {
    return { answer: text };
  }
  const afterOpen = trimmed.slice(OPEN_DELIMITER.length);
  const closeIndex = afterOpen.indexOf(CLOSE_DELIMITER);
  if (closeIndex === -1) {
    return { reasoning: afterOpen, answer: '' };
  }
  const reasoning = afterOpen.slice(0, closeIndex);
  const afterClose = afterOpen.slice(closeIndex + CLOSE_DELIMITER.length);
  const answer = afterClose.startsWith(ANSWER_SEPARATOR)
    ? afterClose.slice(ANSWER_SEPARATOR.length)
    : afterClose;
  return { reasoning, answer };
}

/**
 * Embeds reasoning ahead of the answer in the canonical format. Empty
 * reasoning returns the answer verbatim (never rewrites received bytes). An
 * answer that natively begins with the delimiter is merged rather than
 * double-wrapped: its own reasoning joins ours, its answer becomes the answer.
 */
export function serializeReasoningText(reasoning: string, answer: string): string {
  if (reasoning === '') {
    return answer;
  }
  const nested = parseReasoningText(answer);
  const merged =
    nested.reasoning === undefined || nested.reasoning === ''
      ? reasoning
      : `${reasoning}\n${nested.reasoning}`;
  return `${OPEN_DELIMITER}${merged}${CLOSE_DELIMITER}${ANSWER_SEPARATOR}${nested.answer}`;
}
