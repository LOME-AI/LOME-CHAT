import type { Page } from '@playwright/test';

export interface CapturedRoutePayload {
  /**
   * The parsed JSON body of the most recent intercepted request, or
   * `undefined` if no matching request has been observed yet. Stable across
   * calls — pass it directly to `expect.poll`.
   */
  get: () => unknown;
}

/**
 * Registers a Playwright `page.route` handler that intercepts chat requests
 * (URL pattern `*` `*` `/chat/` `*` `*`) and captures the JSON-decoded
 * post body of the most recent one. Tests use the returned `.get()` accessor
 * to assert that user-facing config (aspect ratio, resolution, etc.) flows
 * through to the request payload.
 *
 * Returns immediately after the route is registered; subsequent matching
 * requests are continued unmodified and their body is parsed in the
 * background. Callers typically poll for the captured value:
 *
 * ```ts
 * const captured = await captureChatRoutePayload(page);
 * await chatPage.sendNewChatMessage(prompt);
 * await chatPage.waitForConversation();
 * await expect.poll(captured.get, { timeout: TIMEOUTS.ASSERT }).toBeDefined();
 * expect(JSON.stringify(captured.get())).toContain('1080p');
 * ```
 *
 * Multi-request safe: each interception overwrites the previous capture, so
 * the accessor reflects the latest matching request. Tests that need every
 * payload should build their own collector instead.
 */
export async function captureChatRoutePayload(page: Page): Promise<CapturedRoutePayload> {
  let payload: unknown;
  await page.route('**/chat/**', async (route) => {
    const postData = route.request().postData();
    if (postData) {
      payload = JSON.parse(postData) as unknown;
    }
    await route.continue();
  });
  return { get: (): unknown => payload };
}
