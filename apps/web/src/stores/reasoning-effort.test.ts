// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { useReasoningEffortStore, REASONING_EFFORT_STORAGE_KEY } from '@/stores/reasoning-effort';

describe('useReasoningEffortStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useReasoningEffortStore.setState({ preferredReasoningEffort: 'auto' });
  });

  it('defaults the preference to auto', () => {
    expect(useReasoningEffortStore.getState().preferredReasoningEffort).toBe('auto');
  });

  it('setReasoningEffort updates the preference', () => {
    useReasoningEffortStore.getState().setReasoningEffort('high');
    expect(useReasoningEffortStore.getState().preferredReasoningEffort).toBe('high');
  });

  it('persists under the reasoning-effort storage key', () => {
    expect(useReasoningEffortStore.persist.getOptions().name).toBe(REASONING_EFFORT_STORAGE_KEY);
  });
});
