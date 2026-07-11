import { describe, it, expect, vi } from 'vitest';
import { processStartEvent } from './multi-model-stream';
import type { StartEventData } from '@/hooks/chat/use-chat-stream';

vi.mock('./chat-messages', () => ({
  createAssistantMessage: (
    conversationId: string,
    id: string,
    modelName: string | undefined,
    parentMessageId: string | null
  ) => ({
    id,
    conversationId,
    role: 'assistant',
    content: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...(modelName !== undefined && { modelName }),
    parentMessageId,
  }),
}));

describe('processStartEvent', () => {
  it('builds a model map from start event data', () => {
    const data: StartEventData = {
      userMessageId: 'user-1',
      models: [
        { modelId: 'gpt-4', assistantMessageId: 'ast-1' },
        { modelId: 'claude-3', assistantMessageId: 'ast-2' },
      ],
    };

    const result = processStartEvent(data, 'conv-1', 'user-1');

    expect(result.modelMap.get('gpt-4')).toBe('ast-1');
    expect(result.modelMap.get('claude-3')).toBe('ast-2');
    expect(result.modelMap.size).toBe(2);
  });

  it('creates assistant messages with model IDs for consistent color hashing', () => {
    const data: StartEventData = {
      userMessageId: 'user-1',
      models: [
        { modelId: 'gpt-4', assistantMessageId: 'ast-1' },
        { modelId: 'claude-3', assistantMessageId: 'ast-2' },
      ],
    };

    const result = processStartEvent(data, 'conv-1', 'user-1');

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toEqual(
      expect.objectContaining({
        id: 'ast-1',
        conversationId: 'conv-1',
        modelName: 'gpt-4',
        parentMessageId: 'user-1',
      })
    );
    expect(result.messages[1]).toEqual(
      expect.objectContaining({
        id: 'ast-2',
        conversationId: 'conv-1',
        modelName: 'claude-3',
        parentMessageId: 'user-1',
      })
    );
  });

  it('returns all assistant message IDs', () => {
    const data: StartEventData = {
      userMessageId: 'user-1',
      models: [
        { modelId: 'gpt-4', assistantMessageId: 'ast-1' },
        { modelId: 'claude-3', assistantMessageId: 'ast-2' },
      ],
    };

    const result = processStartEvent(data, 'conv-1', 'user-1');

    expect(result.assistantMessageIds).toEqual(['ast-1', 'ast-2']);
  });

  it('returns empty assistantMessageIds when no models', () => {
    const data: StartEventData = {
      userMessageId: 'user-1',
      models: [],
    };

    const result = processStartEvent(data, 'conv-1', 'user-1');

    expect(result.assistantMessageIds).toEqual([]);
    expect(result.messages).toEqual([]);
    expect(result.modelMap.size).toBe(0);
  });

  it('handles model not found in selectedModels gracefully', () => {
    const data: StartEventData = {
      userMessageId: 'user-1',
      models: [{ modelId: 'unknown-model', assistantMessageId: 'ast-1' }],
    };

    const result = processStartEvent(data, 'conv-1', 'user-1');

    expect(result.messages[0]).toEqual(
      expect.objectContaining({
        id: 'ast-1',
        conversationId: 'conv-1',
        modelName: 'unknown-model',
        parentMessageId: 'user-1',
      })
    );
  });

  it('works with single model (common case)', () => {
    const data: StartEventData = {
      userMessageId: 'user-1',
      models: [{ modelId: 'gpt-4', assistantMessageId: 'ast-1' }],
    };

    const result = processStartEvent(data, 'conv-1', 'user-1');

    expect(result.modelMap.size).toBe(1);
    expect(result.messages).toHaveLength(1);
    expect(result.assistantMessageIds).toEqual(['ast-1']);
  });

  it('sets parentMessageId to null when null is passed', () => {
    const data: StartEventData = {
      userMessageId: 'user-1',
      models: [{ modelId: 'gpt-4', assistantMessageId: 'ast-1' }],
    };

    const result = processStartEvent(data, 'conv-1', null);

    expect(result.messages[0]?.parentMessageId).toBeNull();
  });
});
