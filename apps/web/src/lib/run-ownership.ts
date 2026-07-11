/**
 * Tracks which runs THIS tab started, so the remote-streaming hook can tell
 * a local run's frames (already rendered by the send path) from another
 * member's. Frames can land before the run-start POST resolves with the
 * runId, so a conversation is marked "pending local" for the POST's duration
 * and any run observed in that window is treated as local — one run per
 * conversation makes the ambiguity harmless (a lost 409 race at worst hides
 * a remote stream until the run-finished refetch).
 */
const pendingByConversation = new Map<string, number>();
const localRuns = new Map<string, Set<string>>();

export function markPendingLocalRun(conversationId: string): void {
  pendingByConversation.set(conversationId, (pendingByConversation.get(conversationId) ?? 0) + 1);
}

export function clearPendingLocalRun(conversationId: string): void {
  const count = pendingByConversation.get(conversationId) ?? 0;
  if (count <= 1) {
    pendingByConversation.delete(conversationId);
    return;
  }
  pendingByConversation.set(conversationId, count - 1);
}

export function resolvePendingLocalRun(conversationId: string, runId: string): void {
  clearPendingLocalRun(conversationId);
  const runs = localRuns.get(conversationId) ?? new Set<string>();
  runs.add(runId);
  localRuns.set(conversationId, runs);
}

export function releaseLocalRun(conversationId: string, runId: string): void {
  const runs = localRuns.get(conversationId);
  if (!runs) return;
  runs.delete(runId);
  if (runs.size === 0) localRuns.delete(conversationId);
}

export function isLocalRun(conversationId: string, runId: string): boolean {
  if ((pendingByConversation.get(conversationId) ?? 0) > 0) return true;
  return localRuns.get(conversationId)?.has(runId) ?? false;
}

/** Test-only reset. */
export function resetRunOwnershipForTests(): void {
  pendingByConversation.clear();
  localRuns.clear();
}
