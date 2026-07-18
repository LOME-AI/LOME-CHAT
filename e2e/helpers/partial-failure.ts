import { type Page, expect } from '@playwright/test';
import { requireEnv } from './env.js';
import { withRequestRetry } from './resilient-request.js';

interface ContentItemRow {
  modelName: string | null;
  cost: string | null;
}

interface ConversationApiResponse {
  messages: { senderType: string; contentItems: ContentItemRow[] }[];
}

interface AssertParams {
  /** Model id that must have persisted content_items with positive cost. */
  succeededModelId: string;
  /** Model id that must have zero persisted content_items. */
  failedModelId: string;
  /** Exact succeeded-item count to assert. Defaults to "at least one". */
  expectedSucceededCount?: number;
}

const apiUrl = requireEnv('VITE_API_URL');

/**
 * After a partial-failure send (one successful model, one failing model),
 * fetch the conversation via the API and assert that:
 *
 * - The failing model wrote zero `content_items` rows.
 * - The successful model has `content_items` with non-null, positive `cost`.
 *
 * Pass `expectedSucceededCount` to assert an exact count instead of the
 * default "at least one" — useful for the text-flow case where one
 * successful model emits exactly one content_item.
 */
export async function assertPartialFailurePersistence(
  page: Page,
  params: AssertParams
): Promise<void> {
  const conversationId = page.url().split('/chat/')[1]?.split('?')[0];
  if (!conversationId) throw new Error('conversation id should be in URL');

  const response = await withRequestRetry(page.request).get(
    `${apiUrl}/conversations/${conversationId}/messages`
  );
  expect(response.ok()).toBe(true);
  const { messages } = (await response.json()) as ConversationApiResponse;

  const aiContentItems = messages
    .filter((m) => m.senderType === 'assistant')
    .flatMap((m) => m.contentItems);

  const failed = aiContentItems.filter((ci) => ci.modelName === params.failedModelId);
  expect(failed.length).toBe(0);

  const succeeded = aiContentItems.filter((ci) => ci.modelName === params.succeededModelId);
  if (params.expectedSucceededCount === undefined) {
    expect(succeeded.length).toBeGreaterThan(0);
  } else {
    expect(succeeded.length).toBe(params.expectedSucceededCount);
  }
  for (const item of succeeded) {
    expect(item.cost).not.toBeNull();
    expect(Number.parseFloat(item.cost ?? '0')).toBeGreaterThan(0);
  }
}
