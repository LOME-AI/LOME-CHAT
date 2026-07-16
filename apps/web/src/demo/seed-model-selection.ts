/**
 * Demo-only: boots the text model picker on the strongest accessible text model
 * instead of the product default (Smart Model). This is a DEMO override — it
 * never touches `stores/model.ts`'s product default. The store's `ensureTextNonEmpty`
 * subscriber guard only re-injects Smart Model when `selections.text` is EMPTY,
 * so pre-seeding a concrete strongest-model entry here is left untouched.
 */
import { getAccessibleModelIds, modelsQueryOptions } from '@/hooks/models/models';
import { useModelStore } from '@/stores/model';
import type { SelectedModelEntry } from '@/stores/model';
import type { QueryClient } from '@tanstack/react-query';
import type { Model } from '@hushbox/shared';

/**
 * The strongest accessible text model as a picker entry, or null when the
 * catalog can't resolve one (empty at boot, or the id isn't in the list) — in
 * which case the caller leaves the Smart Model default in place. The demo user
 * always reads as a paid tier (`getBalance` returns a large purchased balance),
 * so premium access is `true`.
 */
export function pickDemoTextModelEntry(
  models: Model[],
  premiumIds: Set<string>
): SelectedModelEntry | null {
  const { strongestId } = getAccessibleModelIds(models, premiumIds, true, 'text');
  const model = models.find((m) => m.id === strongestId);
  if (model === undefined) return null;
  return { id: model.id, name: model.name };
}

/**
 * Fetches the models catalog through the shared query (warming the same cache
 * `useModels` reads) and sets the demo's initial text selection to the strongest
 * accessible model. A catalog that's unavailable or empty at boot leaves the
 * store's Smart Model default in place.
 */
export async function seedDemoModelSelection(queryClient: QueryClient): Promise<void> {
  try {
    const { models, premiumIds } = await queryClient.fetchQuery(modelsQueryOptions());
    const entry = pickDemoTextModelEntry(models, premiumIds);
    if (entry === null) return;
    useModelStore.getState().setSelectedModels('text', [entry]);
  } catch {
    // Model catalog unavailable at boot → keep the Smart Model default.
  }
}
