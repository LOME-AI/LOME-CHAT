import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  DOMAIN_ERROR_CODE_TO_WIRE_CODE,
  ERROR_CODES,
  newsletterConfirmBodySchema,
  newsletterSettingsBodySchema,
  newsletterSubscribeBodySchema,
  newsletterUnsubscribeBodySchema,
} from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import { resolveClientIp } from '../../middleware/rate-limit.js';
import {
  callerUserId,
  confirmNewsletterSubscription,
  createErrorResponse,
  idempotencyExempt,
  idempotent,
  okAsync,
  readNewsletterSettings,
  runMutation,
  subscribeToNewsletter,
  suppressRecipients,
  unsubscribeFromNewsletter,
  writeNewsletterSettings,
} from './domain/index.js';
import type { Context, Env } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type {
  AccountEmailReaderFactory,
  DomainError,
  DomainErrorCode,
  NewsletterConfirmEmailPort,
  NewsletterStoresFactory,
  ResendWebhookVerifier,
} from './domain/index.js';

export interface NewsletterRouteDeps {
  /** Constructed per request from the pipeline's `c.var.db`. */
  readonly stores: NewsletterStoresFactory;
  /** Composition-root adapter: owns the confirm-link construction. */
  readonly confirmEmail: NewsletterConfirmEmailPort;
  /** Identity's published users store, bound structurally to the email read. */
  readonly identityUsers: AccountEmailReaderFactory;
  /** Fail-closed Resend (Svix-scheme) signature verification, bound to the env secret. */
  readonly webhookVerifier: (env: AppEnv['Bindings']) => ResendWebhookVerifier;
}

const STATUS_BY_DOMAIN_CODE = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  timeout: 408,
  unavailable: 503,
} as const satisfies Record<DomainErrorCode, ContentfulStatusCode>;

function respondDomainError(c: Context<AppEnv>, error: DomainError): Response {
  return c.json(
    createErrorResponse(DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code]),
    STATUS_BY_DOMAIN_CODE[error.code]
  );
}

/**
 * zValidator hook: malformed input answers the uniform `{code}` body. The
 * context is typed with hono's base `Env` because the hook's `E` is not
 * inferred from the route chain — `AppEnv` here would fail contravariance.
 */
function rejectInvalid(
  result: { readonly success: boolean },
  c: Context<Env, string>
): Response | undefined {
  return result.success ? undefined : c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
}

function clientIp(c: Context<AppEnv>): string {
  return resolveClientIp((name) => c.req.header(name));
}

/**
 * The unsubscribe token rides EITHER the query string (RFC 8058 one-click:
 * mail clients POST `List-Unsubscribe=One-Click` as a bare form body, so the
 * token must live in the URL) OR a JSON `{token}` body (the goodbye page).
 * The query wins; a non-JSON body is never an error on this route.
 */
async function resolveUnsubscribeToken(c: Context<AppEnv>): Promise<string | null> {
  const queryToken = c.req.query('token');
  if (queryToken !== undefined && queryToken !== '') return queryToken;
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = newsletterUnsubscribeBodySchema.safeParse(body);
  return parsed.success ? parsed.data.token : null;
}

/**
 * The newsletter slice's HTTP surface. The public routes are exempt without
 * an `Idempotency-Key`: subscribe converges (`naturally-idempotent` +
 * `byUpsert`), confirm/unsubscribe dedup on the token itself
 * (`token-is-key` + `byUpsert`, identity's verify-email precedent). The
 * `/me` toggle is a convergent upsert like account preferences.
 *
 * The return type is deliberately inferred: annotating it with a bare
 * `Hono<AppEnv>` widens the routes to `BlankSchema` and erases the route
 * schema from `AppType` (the typed client goes blind to this slice).
 */
export function createNewsletterManifest(deps: NewsletterRouteDeps) {
  return defineSliceManifest({
    basePath: '/newsletter',
    routes: new Hono<AppEnv>()
      .post(
        '/subscribe',
        routeClass('public'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', newsletterSubscribeBodySchema, rejectInvalid),
        async (c) => {
          const { email } = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              subscribeToNewsletter({
                store: deps.stores(c.var.db),
                emailPort: deps.confirmEmail,
                email,
                consentIp: clientIp(c),
                now: new Date(),
              })
            )
          );
          return result.match(
            () => c.json({ ok: true as const }, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .post(
        '/confirm',
        routeClass('public'),
        idempotencyExempt('token-is-key'),
        zValidator('json', newsletterConfirmBodySchema, rejectInvalid),
        async (c) => {
          const { token } = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              confirmNewsletterSubscription({
                store: deps.stores(c.var.db),
                token,
                now: new Date(),
              })
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          if (result.value.kind === 'invalid') {
            return c.json(createErrorResponse(ERROR_CODES.NEWSLETTER_CONFIRM_INVALID), 400);
          }
          return c.json({ ok: true as const }, 200);
        }
      )
      .post('/unsubscribe', routeClass('public'), idempotencyExempt('token-is-key'), async (c) => {
        const token = await resolveUnsubscribeToken(c);
        if (token === null) {
          return c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
        }
        const result = await runMutation(() =>
          idempotent.byUpsert(() =>
            unsubscribeFromNewsletter({
              store: deps.stores(c.var.db),
              token,
              now: new Date(),
            })
          )
        );
        if (result.isErr()) return respondDomainError(c, result.error);
        if (result.value.kind === 'invalid') {
          return c.json(createErrorResponse(ERROR_CODES.NEWSLETTER_UNSUBSCRIBE_INVALID), 400);
        }
        // RFC 8058: the one-click POST MUST NOT be answered with a redirect.
        return c.json({ ok: true as const }, 200);
      })
      .post(
        '/webhooks/resend',
        routeClass('public'),
        idempotencyExempt('webhook-event-id'),
        async (c) => {
          const rawBody = await c.req.text();
          const verified = await deps.webhookVerifier(c.env).verify(
            rawBody,
            {
              svixId: c.req.header('svix-id'),
              svixTimestamp: c.req.header('svix-timestamp'),
              svixSignature: c.req.header('svix-signature'),
            },
            new Date()
          );
          if (verified.isErr()) return respondDomainError(c, verified.error);
          const event = verified.value;
          if (event.type === 'ignored') {
            return c.json({ received: true as const }, 200);
          }
          const reason =
            event.type === 'email.bounced' ? ('bounce' as const) : ('complaint' as const);
          // The claim runs the whole suppression (the Helcim-webhook shape):
          // the conditional UPDATE is itself the event's convergence point, so
          // a duplicate svix-id — replayed inside or outside the signature
          // tolerance — lands on a 0-row no-op, never a second effect.
          const result = await runMutation(() =>
            idempotent.byEventId({
              claim: () =>
                suppressRecipients({
                  store: deps.stores(c.var.db),
                  recipients: event.recipients,
                  reason,
                  now: new Date(),
                }),
              execute: () => okAsync<boolean, DomainError>(true),
              onDuplicate: () => okAsync<boolean, DomainError>(false),
            })
          );
          // Verified events always answer 200 — Resend retries any non-2xx,
          // and there is nothing a redelivery could fix that the next
          // legitimate event would not.
          return result.match(
            () => c.json({ received: true as const }, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .get('/me', routeClass('session'), async (c) => {
        const result = await readNewsletterSettings({
          store: deps.stores(c.var.db),
          users: deps.identityUsers(c.var.db),
          userId: callerUserId(c.var.principal),
        });
        return result.match(
          (settings) => c.json(settings, 200),
          (error) => respondDomainError(c, error)
        );
      })
      .put(
        '/me',
        routeClass('session'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', newsletterSettingsBodySchema, rejectInvalid),
        async (c) => {
          const { subscribed } = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              writeNewsletterSettings({
                store: deps.stores(c.var.db),
                users: deps.identityUsers(c.var.db),
                userId: callerUserId(c.var.principal),
                subscribed,
                consentIp: clientIp(c),
                now: new Date(),
              })
            )
          );
          return result.match(
            (settings) => c.json(settings, 200),
            (error) => respondDomainError(c, error)
          );
        }
      ),
  });
}
