/**
 * Assembly of the classifier call's messages.
 *
 * The conversation excerpt is content, so the assembly lives here rather than in
 * the shared money layer, which is content-free by contract. The template it
 * wraps has exactly one implementation — {@link buildClassifierSystemPrompt} —
 * because the same string is what the classifier reserve is priced against.
 */
import { buildClassifierSystemPrompt } from '@hushbox/shared';

import type { ClassifierPromptDimensions } from '@hushbox/shared';

/**
 * Compatible with the `AIMessage` shape. Classifier prompts are always plain
 * text — no multimedia parts — so the narrowed type lets callers pass the
 * result directly to the AIClient (its `content: string | MessageContentPart[]`
 * accepts strings).
 */
export interface ClassifierMessage {
  role: 'system' | 'user';
  content: string;
}

export interface ClassifierMessagesInput extends ClassifierPromptDimensions {
  truncatedContext: string;
}

/**
 * Build the two-message prompt sent to the classifier model.
 *
 * The system message embeds the classifier marker (used by the mock AI client to
 * recognize classifier calls) and lists the budget-eligible models with their
 * descriptions. The user message carries the truncated conversation context.
 */
export function buildClassifierMessages(input: ClassifierMessagesInput): ClassifierMessage[] {
  return [
    { role: 'system', content: buildClassifierSystemPrompt(input) },
    { role: 'user', content: input.truncatedContext },
  ];
}
