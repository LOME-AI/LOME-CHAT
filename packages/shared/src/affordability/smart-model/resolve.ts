import { levenshtein } from '../levenshtein.js';

/**
 * Maximum acceptable Levenshtein distance, expressed as a fraction of the
 * trimmed classifier output length. Tight enough to catch typos and minor
 * formatting drift (dropped dot, dot-to-hyphen) while rejecting wholesale
 * model substitutions like haiku→opus or sonnet-3→sonnet-4. Anything beyond
 * this we treat as classifier failure rather than guessing.
 */
const LEVENSHTEIN_TOLERANCE = 0.15;

function findExactMatch(trimmed: string, eligibleIds: readonly string[]): string | null {
  for (const id of eligibleIds) {
    if (id === trimmed) return id;
  }
  return null;
}

function findCaseInsensitiveMatch(lower: string, eligibleIds: readonly string[]): string | null {
  for (const id of eligibleIds) {
    if (id.toLowerCase() === lower) return id;
  }
  return null;
}

function findSubstringMatch(lower: string, eligibleIds: readonly string[]): string | null {
  for (const id of eligibleIds) {
    const idLower = id.toLowerCase();
    if (idLower.includes(lower) || lower.includes(idLower)) return id;
  }
  return null;
}

function findLevenshteinMatch(lower: string, eligibleIds: readonly string[]): string | null {
  let best: { id: string; distance: number } | null = null;
  for (const id of eligibleIds) {
    const distance = levenshtein(id.toLowerCase(), lower);
    if (best === null || distance < best.distance) {
      best = { id, distance };
    }
  }
  if (best === null) return null;
  return best.distance <= Math.floor(lower.length * LEVENSHTEIN_TOLERANCE) ? best.id : null;
}

/**
 * Resolve a classifier's free-form output to a model id from the eligible set.
 *
 * Match attempts in order:
 *   1. Exact equality
 *   2. Case-insensitive equality
 *   3. Bidirectional substring (classifier wrote the id inside prose, OR dropped
 *      the provider prefix and the eligible id contains what they wrote)
 *   4. Levenshtein within {@link LEVENSHTEIN_TOLERANCE} × output length
 *
 * Returns the matched eligible id, or `null` if no candidate is close enough.
 */
export function resolveClassifierOutput(
  raw: string,
  eligibleIds: readonly string[]
): string | null {
  if (eligibleIds.length === 0) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const lower = trimmed.toLowerCase();

  return (
    findExactMatch(trimmed, eligibleIds) ??
    findCaseInsensitiveMatch(lower, eligibleIds) ??
    findSubstringMatch(lower, eligibleIds) ??
    findLevenshteinMatch(lower, eligibleIds)
  );
}
