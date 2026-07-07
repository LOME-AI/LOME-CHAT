/**
 * The unified parent-chain module — the single place that walks message
 * ancestry (`parentMessageId`) and assembles the epoch key chain. The legacy
 * system reassembled these chains in several places with the risk of rule
 * divergence; every consumer (fork semantics here, turn-context assembly in
 * the chat slice) must come through this module's barrel export instead of
 * re-walking rows itself.
 */

export interface ParentChainRow {
  readonly id: string;
  readonly parentMessageId: string | null;
}

/** id → parent id (null at a root). One query's rows, walked in memory. */
export type ParentIndex = ReadonlyMap<string, string | null>;

export function buildParentIndex(rows: readonly ParentChainRow[]): ParentIndex {
  return new Map(rows.map((row) => [row.id, row.parentMessageId]));
}

/**
 * Tip-to-root ancestry. Defensive stops: a tip absent from the index yields
 * an empty chain; a dangling or cyclic parent reference terminates the walk
 * (data corruption must bound reads, never hang them).
 */
export function collectAncestorChain(index: ParentIndex, tipId: string | null): string[] {
  const chain: string[] = [];
  const visited = new Set<string>();
  let current = tipId;
  while (current !== null && index.has(current) && !visited.has(current)) {
    chain.push(current);
    visited.add(current);
    current = index.get(current) ?? null;
  }
  return chain;
}

/**
 * Messages whose only path to any fork tip runs through `targetTip` — the
 * set a fork deletion orphans. Pure set algebra over one parent index.
 */
export function exclusiveMessageIds(
  index: ParentIndex,
  targetTip: string | null,
  otherTips: readonly (string | null)[]
): string[] {
  const shared = new Set<string>();
  for (const tip of otherTips) {
    for (const id of collectAncestorChain(index, tip)) {
      shared.add(id);
    }
  }
  return collectAncestorChain(index, targetTip).filter((id) => !shared.has(id));
}

/**
 * The tail of a fork a regenerate may delete: the messages between `tipId` and
 * `anchorId` (exclusive of the anchor) whose entire subtree lies within that
 * tail. A candidate with a child OUTSIDE the tail is a branch point another
 * fork still depends on (the shared-message-protection case) — it is kept, so
 * regenerating one branch never orphans a sibling.
 *
 * This is the childrenMap counterpart to `exclusiveMessageIds` (which excludes
 * relative to a set of OTHER tips): here the protected set is derived from the
 * out-of-tail children in the same parent index, so the caller needs only the
 * fork's own tip and the regenerate anchor. Pure set algebra over one index;
 * order is tip→anchor, deterministic for the delete.
 */
export function regenerableTailIds(
  index: ParentIndex,
  tipId: string | null,
  anchorId: string
): string[] {
  const chain = collectAncestorChain(index, tipId);
  const anchorIndex = chain.indexOf(anchorId);
  const candidateList = anchorIndex === -1 ? chain : chain.slice(0, anchorIndex);
  const candidates = new Set(candidateList);
  if (candidates.size === 0) return [];

  const childrenByParent = new Map<string, string[]>();
  for (const [id, parentId] of index) {
    if (parentId === null) continue;
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(id);
    childrenByParent.set(parentId, siblings);
  }

  return candidateList.filter((id) =>
    (childrenByParent.get(id) ?? []).every((childId) => candidates.has(childId))
  );
}

export interface KeyChainAssembly<W, L> {
  readonly wraps: W[];
  readonly chainLinks: L[];
  readonly currentEpoch: number;
}

/**
 * The member-visibility filter over epoch material: the floor is the lowest
 * `visibleFromEpoch` across the member's wraps; wraps at or above the floor
 * stay, chain links strictly above it stay (the link INTO the floor epoch
 * would reveal the pre-membership key). Null when the member holds no wraps —
 * the caller treats that as "not an epoch member".
 */
export function assembleKeyChain<
  W extends { readonly epochNumber: number; readonly visibleFromEpoch: number },
  L extends { readonly epochNumber: number },
>(
  wraps: readonly W[],
  chainLinks: readonly L[],
  currentEpoch: number
): KeyChainAssembly<W, L> | null {
  if (wraps.length === 0) return null;
  const floor = Math.min(...wraps.map((w) => w.visibleFromEpoch));
  return {
    wraps: wraps.filter((w) => w.epochNumber >= floor),
    chainLinks: chainLinks.filter((l) => l.epochNumber > floor),
    currentEpoch,
  };
}
