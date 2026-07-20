/**
 * Mock webhook sender for local development.
 * Sends properly-signed webhooks to the local webhook endpoint
 * to test the full payment flow without real Helcim.
 */

import { signHmacSha256Webhook } from '@hushbox/crypto';

const WEBHOOK_PAYMENT_PATH = '/api/webhooks/payment';
const MOCK_WEBHOOK_DELAY_MS = 1000;

export interface MockWebhookConfig {
  webhookUrl: string;
  webhookVerifier: string;
  transactionId: string;
  delayMs?: number;
}

interface MockWebhookPayload {
  type: 'cardTransaction';
  id: string;
}

/**
 * Schedule mock webhook delivery after a delay.
 * Fire-and-forget - does not block the caller.
 */
export function scheduleMockWebhook(config: MockWebhookConfig): void {
  const { webhookUrl, webhookVerifier, transactionId, delayMs = MOCK_WEBHOOK_DELAY_MS } = config;

  setTimeout(() => {
    void sendMockWebhook(webhookUrl, webhookVerifier, transactionId);
  }, delayMs);
}

async function sendMockWebhook(
  webhookUrl: string,
  webhookVerifier: string,
  transactionId: string
): Promise<void> {
  const payload: MockWebhookPayload = {
    type: 'cardTransaction',
    id: transactionId,
  };
  const payloadString = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const webhookId = `mock-webhook-${crypto.randomUUID()}`;

  const signature = await signHmacSha256Webhook({
    secret: webhookVerifier,
    payload: payloadString,
    timestamp,
    webhookId,
  });

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'webhook-signature': signature,
        'webhook-timestamp': timestamp,
        'webhook-id': webhookId,
      },
      body: payloadString,
    });

    if (response.ok) {
      console.log(`[MockWebhook] Delivered for transactionId=${transactionId}`);
    } else {
      console.error(`[MockWebhook] Failed: ${String(response.status)} ${response.statusText}`);
    }
  } catch (error) {
    console.error('[MockWebhook] Error:', error);
  }
}

export { WEBHOOK_PAYMENT_PATH, MOCK_WEBHOOK_DELAY_MS };
