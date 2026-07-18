import { z } from 'zod';
import { fromStandardBase64 } from '@hushbox/shared';
import { verifyHmacSha256Webhook } from '@hushbox/crypto';
import { ResultAsync, errAsync, okAsync } from '../../../lib/result/index.js';
import { isDomainError, unauthorizedError, validationError } from '../../../lib/errors/index.js';
import type { EnvContext } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';

/** Resend webhook signature headers (Svix scheme: `svix-id`/`svix-timestamp`/`svix-signature`). */
export interface ResendWebhookHeaders {
  readonly svixId: string | undefined;
  readonly svixTimestamp: string | undefined;
  readonly svixSignature: string | undefined;
}

/**
 * Replay tolerance on the signed timestamp (Svix's documented default).
 * Unlike the Helcim verifier, this window exists because Resend retries
 * non-2xx for days — an unbounded window would let a captured delivery be
 * replayed forever even after the byEventId effect converged.
 */
export const RESEND_WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Only the two suppression events act; every other verified type is `ignored`
 * (200 no-op — Resend must never redeliver an event we chose not to handle).
 */
export type ResendWebhookEvent =
  | {
      readonly type: 'email.bounced' | 'email.complained';
      readonly recipients: readonly string[];
      readonly eventId: string;
    }
  | { readonly type: 'ignored'; readonly rawType: string };

const SUPPRESSION_EVENT_TYPES = ['email.bounced', 'email.complained'] as const;

const rawEventSchema = z.object({
  type: z.string().optional(),
  data: z.object({ to: z.union([z.string(), z.array(z.string())]).optional() }).optional(),
});

export interface ResendWebhookVerifier {
  verify(
    rawBody: string,
    headers: ResendWebhookHeaders,
    now: Date
  ): ResultAsync<ResendWebhookEvent, DomainError>;
}

export interface ResendWebhookVerifierConfig {
  /** The signing secret (`whsec_` + standard base64). Missing config is a startup defect. */
  readonly secret: string | undefined;
}

/**
 * The structural slice of the env the composition root binds the verifier to —
 * `RESEND_WEBHOOK_SECRET` is a secret, not on the typed Bindings, and the
 * `EnvContext` base is what keeps `Bindings` assignable (a bare one-optional
 * shape would fail the weak-type check).
 */
export interface ResendWebhookSecretEnv extends EnvContext {
  readonly RESEND_WEBHOOK_SECRET?: string;
}

const WHSEC_PREFIX = 'whsec_';

function parseEvent(rawBody: string, eventId: string): ResendWebhookEvent | DomainError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
    // eslint-disable-next-line catch-swallow/no-silent-catch -- malformed JSON becomes validationError; runs only AFTER the HMAC verifies, so verification stays fail-closed.
  } catch {
    return validationError('webhook body is not valid JSON');
  }

  const event = rawEventSchema.safeParse(parsed);
  if (!event.success) {
    return validationError('webhook body has an invalid shape');
  }

  const rawType = event.data.type ?? '';
  const suppressionType = SUPPRESSION_EVENT_TYPES.find((type) => type === rawType);
  if (suppressionType === undefined) {
    return { type: 'ignored', rawType };
  }

  const to = event.data.data?.to;
  const recipients = (typeof to === 'string' ? [to] : (to ?? []))
    .filter((recipient) => recipient !== '')
    .map((recipient) => recipient.toLowerCase());
  if (recipients.length === 0) {
    return validationError('webhook suppression event carries no recipients');
  }

  return { type: suppressionType, recipients, eventId };
}

function withinTolerance(timestamp: string, now: Date): boolean {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  return Math.abs(now.getTime() / 1000 - seconds) <= RESEND_WEBHOOK_TOLERANCE_SECONDS;
}

/**
 * Fail-closed Resend (Svix-scheme) webhook verification: the secret is
 * mandatory at construction and must be `whsec_` + standard base64 (a corrupt
 * secret would otherwise survive startup and reject every delivery as a
 * silent 401); every request must carry all three svix headers inside the
 * timestamp tolerance, and the body is parsed into a domain event only after
 * the HMAC over `${id}.${timestamp}.${body}` verifies (constant-time compare
 * against the space-separated `v1,<sig>` list — the shared crypto primitive).
 * There is no header-presence branch that skips verification.
 */
export function createResendWebhookVerifier(
  config: ResendWebhookVerifierConfig
): ResendWebhookVerifier {
  const secret = config.secret;
  if (secret === undefined || secret.trim().length === 0) {
    throw new Error('Resend webhook secret is not configured');
  }
  if (!secret.startsWith(WHSEC_PREFIX)) {
    throw new Error('Resend webhook secret must carry the whsec_ prefix');
  }
  const secretB64 = secret.slice(WHSEC_PREFIX.length);
  try {
    fromStandardBase64(secretB64);
  } catch (error) {
    throw new Error('Resend webhook secret is not valid standard base64 after whsec_', {
      cause: error,
    });
  }

  return {
    verify(
      rawBody: string,
      headers: ResendWebhookHeaders,
      now: Date
    ): ResultAsync<ResendWebhookEvent, DomainError> {
      const { svixId, svixTimestamp, svixSignature } = headers;
      if (svixId === undefined || svixTimestamp === undefined || svixSignature === undefined) {
        return errAsync(unauthorizedError('webhook signature headers missing'));
      }
      if (!withinTolerance(svixTimestamp, now)) {
        return errAsync(unauthorizedError('webhook timestamp outside tolerance'));
      }

      // fromSafePromise: the crypto primitive catches internally and resolves
      // false on any failure — its promise cannot reject.
      return ResultAsync.fromSafePromise<boolean, DomainError>(
        verifyHmacSha256Webhook({
          secret: secretB64,
          payload: rawBody,
          signatureHeader: svixSignature,
          timestamp: svixTimestamp,
          webhookId: svixId,
        })
      ).andThen((isValid) => {
        if (!isValid) {
          return errAsync(unauthorizedError('webhook signature invalid'));
        }
        const eventOrError = parseEvent(rawBody, svixId);
        return isDomainError(eventOrError) ? errAsync(eventOrError) : okAsync(eventOrError);
      });
    },
  };
}
