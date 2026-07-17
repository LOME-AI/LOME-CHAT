/**
 * Cross-model capability agreement.
 *
 * Multi-model media requests dispatch the same `imageConfig` / `videoConfig`
 * to every selected model. The UI can only honestly expose a value when ALL
 * selected models support it — otherwise we'd silently route a request that
 * one of the providers will reject (`UNSUPPORTED_RESOLUTION`, etc.).
 *
 * `agreedOptions` computes the intersection of per-model supported values for
 * one axis (resolution, aspect ratio, duration, …). `snapToNearest` is the
 * companion for the duration slider — Veo's discrete duration set is
 * non-uniform (`{4, 6, 8}` for 3.1, `{5, 6, 7, 8}` for 3.0) so native HTML
 * range `step` can't enforce it.
 */

interface SelectedModelEntry {
  readonly id: string;
}

/**
 * Returns the intersection of `pluck`-extracted option sets across all selected
 * models, preserving the first-model ordering. Models missing from the catalog
 * or returning `undefined` from `pluck` are skipped (we can't fail closed
 * without knowing what they support — the backend's per-model validator is the
 * authoritative gate).
 */
export function agreedOptions<TModel extends { id: string }, T extends string | number>(
  selectedModels: readonly SelectedModelEntry[],
  modelCatalog: readonly TModel[] | undefined,
  pluck: (model: TModel) => readonly T[] | undefined
): readonly T[] {
  if (selectedModels.length === 0) return [];
  if (modelCatalog === undefined) return [];

  const supportedSets: (readonly T[])[] = [];
  for (const selected of selectedModels) {
    const catalogEntry = modelCatalog.find((m) => m.id === selected.id);
    if (!catalogEntry) return [];
    const supported = pluck(catalogEntry);
    if (supported === undefined) continue;
    supportedSets.push(supported);
  }

  if (supportedSets.length === 0) return [];

  const [firstSet, ...rest] = supportedSets;
  /* v8 ignore next -- supportedSets is non-empty here (guarded above), so firstSet is always defined; this guard is unreachable. */
  if (firstSet === undefined) return [];
  return firstSet.filter((option) => rest.every((set) => set.includes(option)));
}

/**
 * Snap `raw` to the nearest entry in `allowed`. Ties resolve toward the lower
 * value (floor). Out-of-range values clamp to the nearest boundary. Returns
 * `undefined` when `allowed` is empty.
 */
export function snapToNearest(allowed: readonly number[], raw: number): number | undefined {
  const first = allowed[0];
  if (first === undefined) return undefined;

  let best = first;
  let bestDistance = Math.abs(raw - best);
  for (let index = 1; index < allowed.length; index++) {
    const candidate = allowed[index];
    /* v8 ignore next -- `index` iterates valid indices of `allowed`, so `candidate` is never undefined; this guard is unreachable. */
    if (candidate === undefined) continue;
    const distance = Math.abs(raw - candidate);
    // Strict `<` keeps the earlier (typically lower) value on ties — floor on tie.
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
