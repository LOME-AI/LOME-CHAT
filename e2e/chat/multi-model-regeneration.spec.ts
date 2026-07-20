import { test, expect } from '../fixtures.js';
import { TEST_IDS } from '@hushbox/shared';
import { ChatPage } from '../pages/index.js';
import { BudgetHelper } from '../helpers/budget.js';
import { expectConversationChargeMatchesDisplay } from '../helpers/cost-display.js';
import { TIMEOUTS } from '../config/timeouts.js';
import type { Page, Request } from '../fixtures.js';

/**
 * Read the cost badge for a specific persisted message by data-message-id.
 * Returns micros (millionths of a dollar) — sub-cent tile costs (e.g. cheap
 * models like GPT-5 nano at ~$0.00003) round to 0 in cents and break
 * `toBeGreaterThan(0)` checks. Micros preserve those values exactly.
 */
async function getMessageCostMicros(page: Page, messageId: string): Promise<number> {
  const badge = new ChatPage(page).messageById(messageId).getByTestId(TEST_IDS.messageCost);
  const text = (await badge.textContent()) ?? '';
  const match = /\$?([\d.]+)/.exec(text);
  return match ? Math.round(Number.parseFloat(match[1] ?? '0') * 1_000_000) : 0;
}

/** Collect the (id, modelName) of every persisted assistant message currently rendered. */
async function snapshotAssistantTiles(page: Page): Promise<{ id: string; modelName: string }[]> {
  const tiles = new ChatPage(page).assistantTilesWithId();
  const count = await tiles.count();
  const out: { id: string; modelName: string }[] = [];
  for (let index = 0; index < count; index++) {
    const tile = tiles.nth(index);
    const id = (await tile.getAttribute('data-message-id')) ?? '';
    const nametag = (await tile.getByTestId(TEST_IDS.modelNametag).textContent()) ?? '';
    if (id) out.push({ id, modelName: nametag.trim() });
  }
  return out;
}

interface RegenerateRequestBody {
  models?: string[];
  replaceAssistantId?: string;
  action?: string;
  targetMessageId?: string;
}

/** Capture and parse the next POST to /regenerate. Times out at 15s. */
function captureNextRegenerateRequest(page: Page): Promise<Request> {
  return page.waitForRequest(
    (req) => req.url().includes('/regenerate') && req.method() === 'POST',
    { timeout: TIMEOUTS.STREAM }
  );
}

function parseRegenerateBody(req: Request): RegenerateRequestBody {
  return JSON.parse(req.postData() ?? '{}') as RegenerateRequestBody;
}

test.describe('Multi-Model Regeneration', () => {
  // eslint-disable-next-line no-restricted-syntax -- serial: both tests assert the shared Alice wallet balance before/after a regenerate; running them concurrently would interleave debits and corrupt the per-test delta.
  test.describe.configure({ mode: 'serial' });

  // Retry on the user message of a multi-model turn fans out to ALL selected
  // models, deleting every existing sibling and creating one new tile per
  // model. Wallet debit must equal the sum of the new tiles' displayed costs.
  test('retry-all replaces every sibling and charges the sum of all new costs', async ({
    authenticatedPage,
    multiModelConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    const budgetHelper = new BudgetHelper(authenticatedPage.request);

    const tilesBefore = await snapshotAssistantTiles(authenticatedPage);
    expect(tilesBefore).toHaveLength(2);
    const beforeIds = new Set(tilesBefore.map((t) => t.id));

    let body: RegenerateRequestBody = {};
    await test.step('click retry on the user message — capture the request body', async () => {
      const requestPromise = captureNextRegenerateRequest(authenticatedPage);
      // Index 0 in the fixture is always the user prompt.
      await chatPage.clickRetry(0);
      body = parseRegenerateBody(await requestPromise);
    });

    await test.step('request shape: models is the full sibling set, no replaceAssistantId', () => {
      expect(body.action).toBe('retry');
      expect(body.models?.length).toBe(2);
      expect(body.replaceAssistantId).toBeUndefined();
    });

    await test.step('wait for both new responses + their cost badges', async () => {
      await chatPage.waitForStreamComplete(TIMEOUTS.MEDIA_DECODE);
      await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
        timeout: TIMEOUTS.ROUTE,
      });
      await expect(chatPage.messageList).toHaveAttribute('data-cost-count', '2', {
        timeout: TIMEOUTS.ROUTE,
      });
    });

    await test.step('both pre-existing tiles are gone, two brand-new tiles took their place', async () => {
      // `data-assistant-count='2'` alone is also true of the pre-regen state,
      // so it would silently pass if pruning failed. Compare ids directly.
      const tilesAfter = await snapshotAssistantTiles(authenticatedPage);
      expect(tilesAfter).toHaveLength(2);
      for (const tile of tilesAfter) {
        expect(beforeIds.has(tile.id)).toBe(false);
      }
    });

    await test.step('charge for the new tiles equals their displayed cost', async () => {
      // After retry-all the only surviving tiles are the new ones.
      await expectConversationChargeMatchesDisplay(
        budgetHelper,
        multiModelConversation.id,
        chatPage.messageList
      );
    });
  });

  // Per-tile Regenerate on ONE assistant of a multi-model turn replaces just
  // that tile. Surviving siblings keep their existing row, model nametag,
  // and cost badge — and the wallet only sees the new tile's cost.
  test('regenerate-one replaces just the clicked tile and preserves siblings', async ({
    authenticatedPage,
    multiModelConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    const budgetHelper = new BudgetHelper(authenticatedPage.request);

    const tilesBefore = await snapshotAssistantTiles(authenticatedPage);
    expect(tilesBefore).toHaveLength(2);

    // Pick the second tile to regenerate; the first stays put.
    const survivor = tilesBefore[0]!;
    const toReplace = tilesBefore[1]!;
    const survivorCostBefore = await getMessageCostMicros(authenticatedPage, survivor.id);
    expect(survivorCostBefore).toBeGreaterThan(0);

    let body: RegenerateRequestBody = {};
    await test.step('click Regenerate on the second tile — capture the request body', async () => {
      const requestPromise = captureNextRegenerateRequest(authenticatedPage);
      // Index 2 = second assistant in the rendered list (0=user, 1=first assistant, 2=second).
      await chatPage.clickRegenerate(2);
      body = parseRegenerateBody(await requestPromise);
    });

    await test.step('request shape: models is exactly the clicked tile, replaceAssistantId set', () => {
      expect(body.action).toBe('retry');
      expect(body.models?.length).toBe(1);
      expect(body.replaceAssistantId).toBe(toReplace.id);
    });

    await test.step('wait for the replacement to stream + persist', async () => {
      await chatPage.waitForStreamComplete(TIMEOUTS.MEDIA_DECODE);
      await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
        timeout: TIMEOUTS.ROUTE,
      });
    });

    await test.step('survivor row is unchanged (same id, same cost)', async () => {
      const tilesAfter = await snapshotAssistantTiles(authenticatedPage);
      const survivorAfter = tilesAfter.find((t) => t.id === survivor.id);
      expect(survivorAfter).toBeDefined();
      expect(survivorAfter?.modelName).toBe(survivor.modelName);

      const survivorCostAfter = await getMessageCostMicros(authenticatedPage, survivor.id);
      expect(survivorCostAfter).toBe(survivorCostBefore);
    });

    await test.step('replaced row is gone, exactly one new row appeared', async () => {
      const tilesAfter = await snapshotAssistantTiles(authenticatedPage);
      const replacedStillThere = tilesAfter.some((t) => t.id === toReplace.id);
      expect(replacedStillThere).toBe(false);
      // The only id that's different from `before` is the new tile.
      const newTiles = tilesAfter.filter((t) => !tilesBefore.some((b) => b.id === t.id));
      expect(newTiles).toHaveLength(1);
    });

    await test.step('charge equals the displayed total (survivor not re-charged)', async () => {
      // Surviving tiles = untouched survivor + one new tile; a survivor
      // re-charge would push the charged total above the displayed sum.
      await expectConversationChargeMatchesDisplay(
        budgetHelper,
        multiModelConversation.id,
        chatPage.messageList
      );
    });
  });
});
