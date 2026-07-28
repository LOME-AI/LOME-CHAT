import { renderDimensionSection } from '../dimensions/derive.js';
import { EFFORT_DIMENSION, effortDomainOptions } from '../dimensions/effort.js';
import { MODEL_DIMENSION } from '../dimensions/model.js';
import type { DimensionOption } from '../dimensions/types.js';

/**
 * Maximum total characters of conversation excerpt to feed the classifier.
 * Balances signal vs cost — every char × num eligible models adds tokens.
 *
 * The classifier reserve prices this cap rather than the realized text, so the
 * reserve stays valid whatever a caller truncates to — provided the caller emits
 * no more than the cap. The emitter therefore counts its own section labels and
 * separators inside this budget rather than adding them on top of it, and a test
 * where it lives pins that.
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
  /**
   * The effort dimension. The options presented are the dimension's own declared
   * domain in the user's labels, so this is a request for the axis rather than a
   * choice of scale.
   */
  classifyEffort?: boolean;
  /**
   * The effort options this TURN actually presents, when they are narrower than
   * the declared domain — a turn's models rarely offer every rung, and
   * §Reasoning Effort 6 presents the classifier exactly the options the user
   * saw. Omitted falls back to the declared domain, which is what
   * {@link computeClassifierPromptOverhead} prices: narrowing can only make the
   * rendered prompt shorter than the amount reserved for it.
   */
  effortOptions?: readonly DimensionOption[];
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

/**
 * The effort dimension's section, generated from its registry entry over the
 * dimension's declared option domain: the declared sentence, the options by
 * user-facing LABEL, and the dimension's own answer line. Nothing about the
 * ladder is restated here — adding or renaming a rung changes this section with
 * no edit to this file (`docs/BILLING.md` §Reasoning Effort 1, 6).
 */
function effortSection(presented: readonly DimensionOption[] | undefined): string {
  return renderDimensionSection(EFFORT_DIMENSION, presented ?? effortDomainOptions());
}

/**
 * The answer-format instruction. Each dimension answers on its OWN LABELLED
 * line, never a positional one: that is what lets a dimension be added without
 * breaking the parsing of the lines already there, and it is the format
 * `parseClassifierAnswer` reads. The effort dimension's line is named by its own
 * generated section, so only the model dimension's is named here.
 */
function outputInstruction(hasModel: boolean, hasEffort: boolean): string {
  const modelLine = `Answer on its own line as \`${MODEL_DIMENSION.id}: <choice>\`, naming a model id from the list.`;
  const shape =
    hasModel && hasEffort
      ? 'Reply with one labelled line per choice and nothing else.'
      : 'Reply with that one labelled line and nothing else.';
  const closing = `${shape} Do not explain. Do not quote. Do not add commentary.`;
  return hasModel ? `${modelLine}\n${closing}` : closing;
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
    ...(hasEffort ? [effortSection(input.effortOptions)] : []),
    outputInstruction(hasModel, hasEffort),
    ...(input.eligibleModels === undefined ? [] : [modelList(input.eligibleModels)]),
  ];
  return `${markerLine}\n${sections.join('\n\n')}`;
}

/**
 * Worst-case character count of the classifier prompt template (everything the
 * call carries besides the conversation excerpt) for the supplied model list.
 * `classifierReserveChars` sizes the classifier's input leg from this, so it has
 * to be an upper bound BY CONSTRUCTION rather than by measurement.
 *
 * Two things make it one. It renders the ACTUAL template, so a template that
 * grows or shrinks moves the reserve with it on the next call rather than
 * drifting from a guessed constant. And it prices each model's description leg
 * at {@link CLASSIFIER_MAX_DESCRIPTION_CHARS} — the declared maximum a render
 * can emit, since `truncateDescription` clamps every description to exactly
 * that — so it takes no description at all. That is deliberate: the money layer
 * consumes counts, rates and identifiers, never catalog free text, and a
 * description passed in as `?? ''` priced the leg at zero while the executor
 * rendered the real one.
 *
 * The excerpt itself contributes no overhead: it is charged separately at its
 * full {@link MAX_CLASSIFIER_CONTEXT_CHARS} budget, so the two terms sum without
 * double-counting. No memoization: callers run this once per Smart Model
 * invocation, against a tiny model list (~tens of entries).
 */
export function computeClassifierPromptOverhead(
  eligibleModels: readonly { readonly id: string }[]
): number {
  // Rendered with BOTH dimensions requested — the longest composition, so the
  // reserve this feeds is an upper bound whichever dimensions a call classifies.
  return buildClassifierSystemPrompt({
    eligibleModels: eligibleModels.map((model) => ({
      id: model.id,
      description: WORST_CASE_DESCRIPTION,
    })),
    classifyEffort: true,
  }).length;
}

/** The longest description a render can emit — the cap, exactly. */
const WORST_CASE_DESCRIPTION = 'x'.repeat(CLASSIFIER_MAX_DESCRIPTION_CHARS);
