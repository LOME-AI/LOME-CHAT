/**
 * Specialty (non-conversational) model exclusions applied at catalog-normalize
 * time, so these models are never persisted — belt-and-suspenders over the
 * read-time exposure gate. Two providers ship only code-tooling models, and
 * moderation/guard models are not conversational chat surfaces; both are
 * excluded here. Data only (a provider set, a denylist, and a name heuristic) —
 * adding a future one-off exclusion is a denylist edit, never new code.
 */

/** Providers whose entire catalog is non-conversational code tooling. Matched
 * against a model id's first path segment (the descriptor `provider`). */
export const NON_CONVERSATIONAL_PROVIDERS: ReadonlySet<string> = new Set(['relace', 'morph']);

/** Explicit non-conversational model ids: belt-and-suspenders over the provider
 * and name heuristics, and the mechanism for future one-off exclusions. */
export const NON_CONVERSATIONAL_MODEL_IDS: readonly string[] = [
  'morph/morph-v3-fast',
  'morph/morph-v3-large',
  'relace/relace-apply-3',
  'relace/relace-search',
  'meta-llama/llama-guard-4-12b',
  'openai/gpt-oss-safeguard-20b',
];

const DENYLIST: ReadonlySet<string> = new Set(NON_CONVERSATIONAL_MODEL_IDS);

/**
 * Moderation-model name heuristic. `safeguard` contains `guard`, so a single
 * `guard` match on the id-or-name catches both `llama-guard` and
 * `gpt-oss-safeguard`; the alternation is kept for readability. Small
 * false-positive risk: a genuinely conversational model whose id or name merely
 * contains "guard" (e.g. "guardian") would be excluded — accepted, and a false
 * positive is corrected by trimming the offending model from a future denylist,
 * not by loosening the heuristic.
 */
const MODERATION_NAME_PATTERN = /guard|safeguard/i;

/**
 * Whether a model is a non-conversational specialty model: from a banned
 * code-tooling provider, a moderation/guard id-or-name, or an explicit
 * denylist member.
 */
export function isNonConversational(
  id: string,
  provider: string,
  name: string | undefined
): boolean {
  if (NON_CONVERSATIONAL_PROVIDERS.has(provider)) return true;
  if (DENYLIST.has(id)) return true;
  if (MODERATION_NAME_PATTERN.test(id)) return true;
  if (name !== undefined && MODERATION_NAME_PATTERN.test(name)) return true;
  return false;
}
