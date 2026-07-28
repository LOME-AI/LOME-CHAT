import { z } from 'zod';
import { CANONICAL_REASONING_EFFORTS, REASONING_OFF, parseReasoningText } from '@hushbox/shared';
import {
  cheapestClassifierEffort,
  parseClassifierAnswer,
  resolveClassifiedEffort,
} from '@hushbox/shared/affordability/smart-model/effort-dimension';

/**
 * The turn's decision envelope: the value a classifier generation's answer
 * becomes on its way to the nodes that act on it.
 *
 * A classifier is an ordinary `modelCall`, so its answer leaves it as text on an
 * ordinary edge. `decideTurn` is the registered reducer that joins that text to
 * the turn's prompt and produces this envelope, and every consumer reads it
 * through its own single input port (`docs/BILLING.md` §How the decision reaches
 * the answer). Keeping the decision on an edge is what makes the definition that
 * is priced the definition that executes: nothing recompiles after the
 * classifier answers.
 */

/** The registered `json<…>` schema name a decision-consuming input port carries. */
export const TURN_DECISION_SCHEMA_NAME = 'turnDecision';

export const TurnDecision = z.object({
  /**
   * The turn's prompt. It rides the envelope because a consumer declares one
   * input port: a node reading the decision would otherwise have no channel
   * left for the text it must send.
   */
  prompt: z.string(),
  /**
   * The classifier's model-dimension answer, verbatim and unresolved. Only a
   * node holding the candidate set can resolve it, so resolution stays there;
   * empty means the classifier named no model and the consumer applies its own
   * declared fallback.
   */
  modelText: z.string(),
  /**
   * The canonical effort the turn runs at, already resolved onto the closed
   * ladder. `auto` is a SELECTION, not a choice — by the time a decision exists
   * auto has been resolved — so the domain here is the two authorities that make
   * up a real choice and never the wider selection enum.
   */
  effort: z.enum([...CANONICAL_REASONING_EFFORTS, REASONING_OFF]),
});

export type TurnDecision = z.infer<typeof TurnDecision>;

/**
 * The decision a node was handed, or `undefined` when it was handed raw text.
 * Consumers read the envelope through their ordinary single input port, so this
 * is the one place the two input shapes are told apart.
 */
export function decisionOf(input: unknown): TurnDecision | undefined {
  const parsed = TurnDecision.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

/**
 * What a node actually sends: the envelope's prompt when it was handed a
 * decision, the value itself otherwise. One place tells the two input shapes
 * apart, so no consumer has to carry the branch.
 */
export function callInputOf(input: unknown): unknown {
  return decisionOf(input)?.prompt ?? input;
}

/**
 * The effort axis's declared fallback: what an auto turn runs at when the
 * classifier named no level it could resolve, and when no classifier answered at
 * all.
 *
 * §Reasoning Effort 8 makes the fallback the CHEAPEST PRESENTED option, so it is
 * read off the dimension's own domain order rather than named here — a second
 * number would be a mirrored constant, free to drift from the rule the rest of
 * the system applies. The domain is ascending, so its first entry is the
 * cheapest; the envelope's own schema validates it, which fails loudly if the
 * axis ever starts somewhere the envelope cannot carry.
 *
 * Per-model resolution then maps it onto each model's ladder: a model that can
 * disable reasoning runs at Min, and a mandatory-reasoning model runs at its
 * lowest offered rung (the one ruled upward exception, §Effort 4). So the
 * cheapest option the axis has resolves to the cheapest option each model
 * presents, with no per-model fallback of its own.
 */
function cheapestEffortOption(): TurnDecision['effort'] {
  return TurnDecision.shape.effort.parse(cheapestClassifierEffort());
}

/**
 * Parse one classifier answer into the turn's decision, applying the declared
 * fallback for anything it did not resolve. Pure: the same answer always yields
 * the same envelope, and an absent answer is an ordinary input rather than a
 * caught failure.
 */
export function decideTurn(prompt: string, classifierAnswer?: string): TurnDecision {
  if (classifierAnswer === undefined) {
    return { prompt, modelText: '', effort: cheapestEffortOption() };
  }
  // A reasoning-capable classifier returns its thinking inline in the same
  // field; only the answer is routing output.
  const answer = parseReasoningText(classifierAnswer).answer;
  // Labelled lines only, on every axis. The classifier prompt asks for one
  // labelled line per dimension, so a dimension with no line of its own is an
  // unanswered dimension rather than a positional guess — which is what lets a
  // dimension be added without moving what the others read.
  const parts = parseClassifierAnswer(answer, LABELLED_DIMENSIONS);
  const effort = resolveClassifiedEffort(parts.effortText);
  return {
    prompt,
    modelText: parts.modelText,
    effort: effort ?? cheapestEffortOption(),
  };
}

/**
 * Both axes labelled: the arm of {@link parseClassifierAnswer} that reads a
 * dimension's own line and nothing else. The envelope is produced identically
 * however many dimensions a given turn opened, so the reducer never needs to be
 * told which ones were asked.
 */
const LABELLED_DIMENSIONS = { model: true, effort: true } as const;
