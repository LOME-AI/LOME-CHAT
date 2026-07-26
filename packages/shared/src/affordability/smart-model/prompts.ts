/**
 * Maximum total characters of conversation context to feed the classifier.
 * Balances signal vs cost — every char × num eligible models adds tokens.
 *
 * The classifier reserve prices this cap rather than the realized text, which
 * is what keeps the reserve valid whatever the caller ends up truncating to.
 */
export const MAX_CLASSIFIER_CONTEXT_CHARS = 4000;

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

export interface ClassifierEligibleModel {
  id: string;
  description: string;
}

/**
 * The classifier's requested dimensions: the model dimension is present iff
 * `eligibleModels` is supplied; the effort dimension iff `classifyEffort` is
 * true. At least one dimension must be requested — the classifier stage never
 * runs a dimensionless call.
 *
 * Model ids and catalog descriptions only. The conversation excerpt the
 * classifier reads is not part of this shape: it is content, so it is supplied
 * by the caller that assembles the messages, never by this layer.
 */
export interface ClassifierPromptDimensions {
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

/**
 * Render the classifier's system message for the requested dimensions.
 *
 * The one implementation of the classifier prompt template. It is exported
 * because two callers need exactly this string and must not drift: the caller
 * that assembles the outgoing messages around the conversation excerpt, and
 * {@link computeClassifierPromptOverhead}, which charges for the template.
 */
export function buildClassifierSystemPrompt(input: ClassifierPromptDimensions): string {
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
 * Exact character count of the classifier prompt template (everything the call
 * carries besides the conversation excerpt) when rendered against the supplied
 * eligible model list. Used by `classifierReserveChars` to size the worst-case
 * classifier overhead in char terms without relying on a guessed constant that
 * can drift from the prompt template.
 *
 * Implementation: render the actual template. This makes the helper a single
 * source of truth — if the template grows or shrinks, the overhead estimate
 * updates with it on the next call. The excerpt itself contributes no overhead:
 * it is charged separately at its full {@link MAX_CLASSIFIER_CONTEXT_CHARS}
 * budget, so the two terms sum without double-counting. No memoization: callers
 * run this once per Smart Model invocation, against a tiny model list (~tens of
 * entries).
 */
export function computeClassifierPromptOverhead(
  eligibleModels: readonly ClassifierEligibleModel[]
): number {
  // Rendered with BOTH dimensions requested — the longest composition, so the
  // reserve this feeds is an upper bound whichever dimensions a call classifies.
  return buildClassifierSystemPrompt({ eligibleModels, classifyEffort: true }).length;
}
