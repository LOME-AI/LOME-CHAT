import { describe, expect, it } from 'vitest';
import { okAsync } from '../../../lib/result/index.js';
import { getMessageHistory } from './history.js';
import { fakeStores, memberRecord } from './test-fixtures.js';
import type { ContentItemRow, HistoryMessageRow } from '../ports/index.js';

function contentItemRow(overrides: Partial<ContentItemRow> = {}): ContentItemRow {
  return {
    id: 'ci-1',
    messageId: 'msg-1',
    position: 0,
    contentType: 'text',
    mimeType: null,
    sizeBytes: null,
    encryptedBlob: new Uint8Array([1, 2, 3]),
    costNanoUsd: null,
    modelId: null,
    isSmartModel: false,
    ...overrides,
  };
}

function historyRow(items: ContentItemRow[]): HistoryMessageRow {
  return {
    id: 'msg-1',
    parentMessageId: null,
    sequenceNumber: 1,
    epochNumber: 1,
    senderType: 'assistant',
    senderId: null,
    wrappedContentKey: new Uint8Array([9]),
    batchId: 'batch-1',
    contentItems: items,
  };
}

function historyStores(items: ContentItemRow[]) {
  return fakeStores({
    members: { activeByUser: () => okAsync(memberRecord({ visibleFromEpoch: 1 })) },
    messages: { history: () => okAsync([historyRow(items)]) },
  });
}

describe('getMessageHistory content-item projection', () => {
  it('surfaces the billed cost, model name, and smart-model flag for an AI content item', async () => {
    const stores = historyStores([
      contentItemRow({ costNanoUsd: 1_360_000n, modelId: 'anthropic/claude', isSmartModel: true }),
    ]);
    const result = await getMessageHistory(stores, {
      conversationId: 'c1',
      caller: { kind: 'user', userId: 'owner' },
    });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    const item = view.messages[0]?.contentItems[0];
    expect(item?.cost).toBe('1360000');
    expect(item?.modelName).toBe('anthropic/claude');
    expect(item?.isSmartModel).toBe(true);
  });

  it('serializes a null cost/model as null and defaults the smart flag to false', async () => {
    const stores = historyStores([contentItemRow()]);
    const result = await getMessageHistory(stores, {
      conversationId: 'c1',
      caller: { kind: 'user', userId: 'owner' },
    });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    const item = view.messages[0]?.contentItems[0];
    expect(item?.cost).toBeNull();
    expect(item?.modelName).toBeNull();
    expect(item?.isSmartModel).toBe(false);
  });
});
