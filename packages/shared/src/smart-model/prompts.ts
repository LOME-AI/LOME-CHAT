/**
 * Marker embedded at the start of the classifier system prompt. Lets the
 * mock AI client detect classifier calls without coupling to the prompt
 * wording. Real gateway providers ignore it.
 */
export const CLASSIFIER_SYSTEM_PROMPT_MARKER = '[HUSHBOX_CLASSIFIER]';

/**
 * Cap each model's description to keep the classifier prompt small. The
 * gateway-provided descriptions are short already; this is a defense against
 * unexpectedly verbose entries inflating token counts.
 */
export const CLASSIFIER_MAX_DESCRIPTION_CHARS = 100;

/**
 * Compatible with the API-side `AIMessage` shape. Classifier prompts are
 * always plain text — no multimedia parts — so we narrow the type here in
 * `@hushbox/shared` and let API consumers pass the result directly to the
 * AIClient (its `content: string | MessageContentPart[]` accepts strings).
 */
export interface ClassifierMessage {
  role: 'system' | 'user';
  content: string;
}

export interface ClassifierEligibleModel {
  id: string;
  description: string;
}

export interface ClassifierPromptInput {
  truncatedContext: string;
  eligibleModels: readonly ClassifierEligibleModel[];
}

function truncateDescription(description: string): string {
  if (description.length <= CLASSIFIER_MAX_DESCRIPTION_CHARS) return description;
  return description.slice(0, CLASSIFIER_MAX_DESCRIPTION_CHARS - 1) + '…';
}

function buildSystemPrompt(eligibleModels: readonly ClassifierEligibleModel[]): string {
  const modelList = eligibleModels
    .map((m) => `- ${m.id} — ${truncateDescription(m.description)}`)
    .join('\n');

  return `${CLASSIFIER_SYSTEM_PROMPT_MARKER}
You are a model router for HushBox. Given a recent excerpt of the user's
conversation, choose the single best AI model for the user's next message.
Consider task complexity, domain (coding, math, creative writing, general
knowledge), and whether the user needs deep reasoning or a quick reply.

Reply with ONLY the model id from the list below. Do not explain. Do not
quote. Do not add commentary. Output one model id and nothing else.

Available models:
${modelList}`;
}

/**
 * Build the two-message prompt sent to the classifier model.
 *
 * The system message embeds the {@link CLASSIFIER_SYSTEM_PROMPT_MARKER}
 * (used by the mock AI client to recognize classifier calls) and lists the
 * budget-eligible models with their descriptions. The user message carries
 * the truncated conversation context.
 *
 * Returned shape is compatible with `AIClient.stream({ messages })` — the
 * API-side `AIMessage` type accepts string content directly.
 */
export function buildClassifierMessages(input: ClassifierPromptInput): ClassifierMessage[] {
  return [
    { role: 'system', content: buildSystemPrompt(input.eligibleModels) },
    { role: 'user', content: input.truncatedContext },
  ];
}

/**
 * Exact character count of the classifier prompt template (system message
 * plus user-message wrapping) when rendered against the supplied eligible
 * model list and an EMPTY truncated context. Used by `classifierReserveChars`
 * to size the worst-case classifier overhead in char terms without
 * relying on a guessed constant that can drift from the prompt template.
 *
 * Implementation: render the actual prompt with empty context and concat
 * each role's content. This makes the helper a single source of truth — if
 * the prompt template grows or shrinks, the overhead estimate updates with
 * it on the next call. No memoization: callers run this once per Smart
 * Model invocation, against a tiny model list (~tens of entries).
 */
export function computeClassifierPromptOverhead(
  eligibleModels: readonly ClassifierEligibleModel[]
): number {
  const messages = buildClassifierMessages({
    truncatedContext: '',
    eligibleModels,
  });
  let total = 0;
  for (const message of messages) {
    total += message.content.length;
  }
  return total;
}
