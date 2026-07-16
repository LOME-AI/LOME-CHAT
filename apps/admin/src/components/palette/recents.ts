/** What a palette selection does when re-run from Recents. */
export type PaletteAction =
  | { readonly kind: 'screen'; readonly to: string }
  | { readonly kind: 'op'; readonly name: string }
  | { readonly kind: 'user'; readonly q: string };

export interface RecentEntry {
  readonly id: string;
  readonly label: string;
  readonly action: PaletteAction;
}

const MAX_RECENTS = 5;

// Deliberately in-memory: recents reset per tab session, nothing persists.
let recents: readonly RecentEntry[] = [];

export function getRecents(): readonly RecentEntry[] {
  return recents;
}

export function pushRecent(entry: RecentEntry): void {
  recents = [entry, ...recents.filter((existing) => existing.id !== entry.id)].slice(
    0,
    MAX_RECENTS
  );
}

export function clearRecents(): void {
  recents = [];
}
