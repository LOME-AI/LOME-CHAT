import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { ERROR_CODES } from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import {
  createErrorResponse,
  domainErrorBody,
  domainErrorStatus,
  fullSessionClaims,
  idempotencyExempt,
  idempotent,
  registerDeviceToken,
  registerDeviceTokenSchema,
  runMutation,
  unregisterDeviceToken,
} from './domain/index.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { Database } from '@hushbox/db';
import type { DeviceTokenStore } from './domain/index.js';

export interface NotificationsDeps {
  /** Per-request store construction from the pipeline's `c.var.db`. */
  readonly deviceTokenStore: (db: Database) => DeviceTokenStore;
}

/**
 * The notifications slice's HTTP surface: device-token registration. Both
 * routes are `naturally-idempotent` — the byUpsert/byTransition wrapper in
 * each terminal handler converges repeats on the same end-state, so no
 * Idempotency-Key header is required (the exemption-wrapper pairing is
 * checked by the arch harness, which is why the wrapper calls sit visibly
 * in the registrations below).
 *
 * The return type is deliberately inferred: annotating it with a bare
 * `Hono<AppEnv>` widens the routes to `BlankSchema` and erases the route
 * schema from `AppType` (the typed client goes blind to this slice).
 */
export function createNotificationsManifest(deps: NotificationsDeps) {
  return defineSliceManifest({
    basePath: '/notifications',
    routes: new Hono<AppEnv>()
      .post(
        '/device-tokens',
        routeClass('session'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', registerDeviceTokenSchema, (result, c) =>
          result.success ? undefined : c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400)
        ),
        async (c) => {
          const claims = fullSessionClaims(c.var.principal);
          const store = deps.deviceTokenStore(c.var.db);
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              registerDeviceToken(store, claims.userId, c.req.valid('json'))
            )
          );
          return result.match(
            () => c.json({ registered: true }, 201),
            (error) => c.json(domainErrorBody(error), domainErrorStatus(error))
          );
        }
      )
      .delete(
        '/device-tokens/:token',
        routeClass('session'),
        idempotencyExempt('naturally-idempotent'),
        async (c) => {
          const claims = fullSessionClaims(c.var.principal);
          const store = deps.deviceTokenStore(c.var.db);
          const result = await runMutation(() =>
            idempotent.byTransition(
              unregisterDeviceToken(store, claims.userId, c.req.param('token'))
            )
          );
          return result.match(
            (deleted) => c.json({ deleted }, 200),
            (error) => c.json(domainErrorBody(error), domainErrorStatus(error))
          );
        }
      ),
  });
}
