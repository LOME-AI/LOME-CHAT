/**
 * Marker embedded at the start of the classifier system prompt. Lets the
 * mock AI client detect classifier calls without coupling to the prompt
 * wording. Real gateway providers ignore it.
 */
export const CLASSIFIER_SYSTEM_PROMPT_MARKER = '[HUSHBOX_CLASSIFIER]';

/**
 * Dimension markers appended to the marker line, one per classified
 * dimension. They let the mock AI client answer each requested dimension
 * deterministically (model line and/or effort line) without coupling to the
 * prompt wording — the same contract as the base marker. Real gateway
 * providers ignore them.
 */
export const CLASSIFIER_MODEL_DIMENSION_MARKER = '[MODEL]';
export const CLASSIFIER_EFFORT_DIMENSION_MARKER = '[EFFORT]';

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

/**
 * The classifier's requested dimensions (D3, dimension-composed): the model
 * dimension is present iff `eligibleModels` is supplied; the effort dimension
 * iff `classifyEffort` is true. At least one dimension must be requested —
 * the classifier stage never runs a dimensionless call.
 */
export interface ClassifierPromptInput {
  truncatedContext: string;
  /** The model dimension: the candidates to route among. */
  eligibleModels?: readonly ClassifierEligibleModel[];
  /** The effort dimension: classify canonical low | medium | high. */
  classifyEffort?: boolean;
}

function truncateDescription(description: string): string {
  if (description.length <= CLASSIFIER_MAX_DESCRIPTION_CHARS) return description;
  return description.slice(0, CLASSIFIER_MAX_DESCRIPTION_CHARS - 1) + '…';
}

const MODEL_SECTION = `Choose the single best AI model for the user's next message. Consider
task complexity, domain (coding, math, creative writing, general knowledge),
and whether the user needs deep reasoning or a quick reply.`;

function modelList(eligibleModels: readonly ClassifierEligibleModel[]): string {
  const lines = eligibleModels
    .map((m) => `- ${m.id} — ${truncateDescription(m.description)}`)
    .join('\n');
  return `Available models:\n${lines}`;
}

const EFFORT_SECTION = `Choose how much reasoning effort the next reply needs: low (simple or
factual), medium (moderate analysis), or high (deep multi-step reasoning).
Answer with one of exactly: low, medium, or high.`;

/**
 * The output-format instruction per dimension composition. Both dimensions
 * classify in ONE generation: the reply is line 1 = model id, line 2 =
 * effort level.
 */
function outputInstruction(hasModel: boolean, hasEffort: boolean): string {
  if (hasModel && hasEffort) {
    return `Reply with exactly two lines and nothing else. Line 1: ONLY the model id
from the list. Line 2: ONLY the effort level (low, medium, or high). Do not
explain. Do not quote. Do not add commentary.`;
  }
  if (hasEffort) {
    return `Reply with ONLY the effort level: low, medium, or high. Do not explain.
Do not quote. Output one word and nothing else.`;
  }
  return `Reply with ONLY the model id from the list below. Do not explain. Do not
quote. Do not add commentary. Output one model id and nothing else.`;
}

function buildSystemPrompt(input: ClassifierPromptInput): string {
  const hasModel = input.eligibleModels !== undefined;
  const hasEffort = input.classifyEffort === true;
  const markerLine =
    CLASSIFIER_SYSTEM_PROMPT_MARKER +
    (hasModel ? CLASSIFIER_MODEL_DIMENSION_MARKER : '') +
    (hasEffort ? CLASSIFIER_EFFORT_DIMENSION_MARKER : '');
  // The model list renders LAST so a runaway description can never push the
  // output instruction out of a context-trimmed prompt tail.
  const sections = [
    `You are a request router for HushBox, judging a recent excerpt of the
user's conversation.`,
    ...(hasModel ? [MODEL_SECTION] : []),
    ...(hasEffort ? [EFFORT_SECTION] : []),
    outputInstruction(hasModel, hasEffort),
    ...(input.eligibleModels === undefined ? [] : [modelList(input.eligibleModels)]),
  ];
  return `${markerLine}\n${sections.join('\n\n')}`;
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
    { role: 'system', content: buildSystemPrompt(input) },
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
  // Rendered with BOTH dimensions requested — the longest composition, so the
  // reserve this feeds is an upper bound whichever dimensions a call classifies.
  const messages = buildClassifierMessages({
    truncatedContext: '',
    eligibleModels,
    classifyEffort: true,
  });
  let total = 0;
  for (const message of messages) {
    total += message.content.length;
  }
  return total;
}
