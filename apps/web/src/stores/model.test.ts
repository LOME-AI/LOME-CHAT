import { describe, it, expect, beforeEach } from 'vitest';
import { useModelStore } from './model';

describe('useModelStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useModelStore.setState({
      selectedModelId: 'openai/gpt-4-turbo',
    });
  });

  it('has default selected model id', () => {
    const { selectedModelId } = useModelStore.getState();
    expect(selectedModelId).toBe('openai/gpt-4-turbo');
  });

  it('sets selected model id', () => {
    useModelStore.getState().setSelectedModelId('anthropic/claude-3.5-sonnet');
    const { selectedModelId } = useModelStore.getState();
    expect(selectedModelId).toBe('anthropic/claude-3.5-sonnet');
  });

  it('persists model selection across store calls', () => {
    useModelStore.getState().setSelectedModelId('google/gemini-pro-1.5');
    // Get fresh state
    const { selectedModelId } = useModelStore.getState();
    expect(selectedModelId).toBe('google/gemini-pro-1.5');
  });
});
