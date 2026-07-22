import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ReasoningEffortSelection } from '@hushbox/shared';

/**
 * Store-local persist key (no cross-package consumer yet; promote to
 * `packages/shared/src/storage-keys.ts` when e2e needs to seed it).
 */
export const REASONING_EFFORT_STORAGE_KEY = 'hushbox-reasoning-effort-storage';

interface ReasoningEffortState {
  /**
   * The user's raw persisted choice (default `auto`). Consumers never send
   * this directly: the effective value clamps per model through
   * `useReasoningEffort`, so a preference kept across a model switch can
   * never produce a request the server would refuse.
   */
  preferredReasoningEffort: ReasoningEffortSelection;
  setReasoningEffort: (selection: ReasoningEffortSelection) => void;
}

export const useReasoningEffortStore = create<ReasoningEffortState>()(
  persist(
    (set) => ({
      preferredReasoningEffort: 'auto',
      setReasoningEffort: (selection) => set({ preferredReasoningEffort: selection }),
    }),
    { name: REASONING_EFFORT_STORAGE_KEY }
  )
);
