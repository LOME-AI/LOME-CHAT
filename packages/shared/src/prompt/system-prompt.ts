/**
 * The server-owned base system prompt sent on every language turn (paid and
 * trial). A lean, inference-time builder distinct from `buildSystemPrompt`
 * (which estimates token budgets against the deferred code-execution capability
 * blocks): this one carries only the base preamble and, when the client supplies them, the
 * user's custom instructions. The python/javascript code-execution capability
 * blocks are deliberately omitted — that capability is deferred.
 *
 * The date is passed in, never read from the wall clock, so the assembled
 * prompt (and therefore the provider request hash) is deterministic under test.
 * Custom instructions are E2E-encrypted at rest, so the server cannot decrypt
 * the stored blob — the plaintext arrives client-supplied per request, exactly
 * like conversation history.
 */
import { BASE_SYSTEM_PREAMBLE } from './base-preamble.js';

export interface SystemPromptInput {
  /** Reference instant; the prompt renders its UTC calendar date (YYYY-MM-DD). */
  readonly now: Date;
  /** Client-supplied plaintext custom instructions, when present. */
  readonly customInstructions?: string;
}

export function buildTurnSystemPrompt(input: SystemPromptInput): string {
  const currentDate = input.now.toISOString().slice(0, 10);
  const sections: string[] = [`${BASE_SYSTEM_PREAMBLE}\nCurrent date: ${currentDate}`];

  // Whitespace-only instructions are treated as absent — a bare "   " must not
  // emit a dangling, content-free section.
  const customInstructions = input.customInstructions?.trim();
  if (customInstructions !== undefined && customInstructions.length > 0) {
    sections.push(`## User's Custom Instructions\n${customInstructions}`);
  }

  return sections.join('\n\n');
}
