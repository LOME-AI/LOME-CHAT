/**
 * The ONE prompt measurement shared by the client composer preview and the
 * server's admission budget: both count the identical prompt the language
 * adapter sends — the built system prompt (`buildTurnSystemPrompt` output,
 * base preamble + optional custom instructions), every resent history turn's
 * content, and the current input. Counts are UTF-16 code units (`.length`),
 * the same unit storage billing counts stored content in.
 */

/** Sums the content length of every resent history turn. */
export function historyCharacterCount(history: readonly { readonly content: string }[]): number {
  return history.reduce((total, message) => total + message.content.length, 0);
}

export interface PromptMeasurement {
  /** The exact system prompt the send carries — always `buildTurnSystemPrompt` output. */
  readonly systemPrompt: string;
  readonly historyCharacters: number;
  /** The current turn's user input. */
  readonly prompt: string;
}

export function promptCharacterCount(input: PromptMeasurement): number {
  return input.systemPrompt.length + input.historyCharacters + input.prompt.length;
}
