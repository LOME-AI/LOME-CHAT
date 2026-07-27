/**
 * Every reason a model is kept out of the sellable catalog, in the order the
 * refresh summary lists them (quiet, expected exclusions first; the loud
 * fail-closed defects last). `unclassifiable-modality`, `unknown-pricing-unit`,
 * and `missing-release-date` are fail-closed defects that alert; `deprecated`,
 * `token-priced-image`, `token-priced-video`, `megapixel-priced-image`,
 * `missing-pricing`, `non-zdr` (only ZDR-reachable models are persisted),
 * `non-conversational` (specialty code-tooling and moderation models),
 * `non-runnable-shape` (a merged descriptor no turn can run — multi-output, or
 * no text input), and the three commercial reasons `zero-priced`,
 * `below-price-floor` and `too-old` (BILLING.md §Catalog Admission — a model
 * that cannot be sold profitably) are expected shapes — counted, never paged.
 *
 * The single authority for three consumers that must not drift: the
 * {@link ExcludeReason} union, the per-reason refresh summary breakdown, and
 * the `model_exclude_reason` pgEnum behind `model_catalog.excluded_reason`.
 * It lives here rather than in the models slice because the database package
 * cannot import application code, and a second list is exactly the sync
 * contract CODE-RULES bans.
 */
export const EXCLUDE_REASONS = [
  'token-priced-image',
  'token-priced-video',
  'megapixel-priced-image',
  'missing-pricing',
  'zero-priced',
  'below-price-floor',
  'too-old',
  'deprecated',
  'non-zdr',
  'non-conversational',
  'non-runnable-shape',
  'unclassifiable-modality',
  'missing-release-date',
  'unknown-pricing-unit',
] as const;

export type ExcludeReason = (typeof EXCLUDE_REASONS)[number];
