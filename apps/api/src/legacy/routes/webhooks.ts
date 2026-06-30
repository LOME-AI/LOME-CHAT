import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { payments, recordServiceEvidence, SERVICE_NAMES, type Database } from '@hushbox/db';
import {
  createEnvUtilities,
  ERROR_CODE_UNAUTHORIZED,
  ERROR_CODE_INVALID_SIGNATURE,
  ERROR_CODE_INVALID_JSON,
  ERROR_CODE_WEBHOOK_VERIFIER_MISSING,
  ERROR_CODE_PAYMENT_NOT_FOUND,
} from '@hushbox/shared';
import { verifyWebhookSignatureAsync } from '../services/helcim/index.js';
import { processWebhookCredit } from '../services/billing/index.js';
import { createErrorResponse } from '../lib/error-response.js';
import type { AppEnv } from '../types.js';

interface SignatureHeaders {
  signature: string | undefined;
  timestamp: string | undefined;
  webhookId: string | undefined;
}

interface VerifySignatureResult {
  error?: { message: string; code: string; status: 401 | 500 };
}

async function verifySignatureIfRequired(
  webhookVerifier: string | undefined,
  rawBody: string,
  headers: SignatureHeaders,
  isProduction: boolean
): Promise<VerifySignatureResult> {
  if (isProduction && !webhookVerifier) {
    return {
      error: {
        message: ERROR_CODE_WEBHOOK_VERIFIER_MISSING,
        code: ERROR_CODE_WEBHOOK_VERIFIER_MISSING,
        status: 500,
      },
    };
  }

  if (webhookVerifier && headers.signature && headers.timestamp && headers.webhookId) {
    const isValid = await verifyWebhookSignatureAsync({
      webhookVerifier,
      payload: rawBody,
      signatureHeader: headers.signature,
      timestamp: headers.timestamp,
      webhookId: headers.webhookId,
    });

    if (!isValid) {
      return {
        error: {
          message: ERROR_CODE_INVALID_SIGNATURE,
          code: ERROR_CODE_UNAUTHORIZED,
          status: 401,
        },
      };
    }
  }

  return {};
}

interface WebhookEvent {
  type: string;
  id: string;
}

function parseWebhookEvent(rawBody: string): WebhookEvent | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    const typedParsed = parsed as Record<string, unknown>;
    const typeValue = typedParsed['type'];
    const idValue = typedParsed['id'] ?? typedParsed['transactionId'];
    return {
      type: typeof typeValue === 'string' ? typeValue : '',
      id: typeof idValue === 'string' || typeof idValue === 'number' ? String(idValue) : '',
    };
  } catch {
    return null;
  }
}

async function processWithRetry(
  db: Database,
  transactionId: string,
  isCI: boolean
): Promise<boolean> {
  const maxRetries = isCI ? 3 : 15;
  const retryDelay = isCI ? 500 : 1000;

  for (let index = 0; index < maxRetries; index++) {
    await new Promise((resolve) => setTimeout(resolve, retryDelay));

    // Attempt atomic claim first — eliminates check-then-act race
    const result = await processWebhookCredit(db, { helcimTransactionId: transactionId });
    if (result) return true;

    // Only after atomic claim returns null, check if someone else completed it
    const [check] = await db
      .select({ status: payments.status })
      .from(payments)
      .where(eq(payments.helcimTransactionId, transactionId));

    if (check?.status === 'completed') return true;
  }

  return false;
}

type CardTransactionResult =
  | { handled: true; alreadyCompleted?: boolean }
  | { handled: false; shouldReturnError: boolean; errorMessage?: string };

async function handleCardTransaction(
  db: Database,
  transactionId: string,
  isCI: boolean
): Promise<CardTransactionResult> {
  // Attempt atomic claim first — eliminates check-then-act race
  const result = await processWebhookCredit(db, { helcimTransactionId: transactionId });
  if (result) {
    return { handled: true };
  }

  // Only after atomic claim returns null, do a read-only check to distinguish
  // "already completed" from "not found"
  const [existing] = await db
    .select({ status: payments.status })
    .from(payments)
    .where(eq(payments.helcimTransactionId, transactionId));

  if (existing?.status === 'completed') {
    return { handled: true, alreadyCompleted: true };
  }

  const success = await processWithRetry(db, transactionId, isCI);
  if (success) {
    return { handled: true };
  }

  if (isCI) {
    return { handled: true };
  }

  return { handled: false, shouldReturnError: true };
}

/**
 * Webhook routes.
 * Requires dbMiddleware to be applied.
 * Does NOT require auth middleware - webhooks are authenticated via signature.
 */
export const webhooksRoute = new Hono<AppEnv>().post('/payment', async (c) => {
  const db = c.get('db');
  const { isProduction, isCI } = createEnvUtilities(c.env);

  await recordServiceEvidence(db, isCI, SERVICE_NAMES.HOOKDECK);

  const rawBody = await c.req.text();
  const headers: SignatureHeaders = {
    signature: c.req.header('webhook-signature'),
    timestamp: c.req.header('webhook-timestamp'),
    webhookId: c.req.header('webhook-id'),
  };

  const verifyResult = await verifySignatureIfRequired(
    c.env.HELCIM_WEBHOOK_VERIFIER,
    rawBody,
    headers,
    isProduction
  );
  if (verifyResult.error) {
    return c.json(createErrorResponse(verifyResult.error.code), verifyResult.error.status);
  }

  const event = parseWebhookEvent(rawBody);
  if (!event) {
    return c.json(createErrorResponse(ERROR_CODE_INVALID_JSON), 400);
  }

  if (event.type === 'cardTransaction') {
    const result = await handleCardTransaction(db, event.id, isCI);
    if (!result.handled && result.shouldReturnError) {
      return c.json(createErrorResponse(ERROR_CODE_PAYMENT_NOT_FOUND), 500);
    }
  }

  return c.json({ received: true }, 200);
});
