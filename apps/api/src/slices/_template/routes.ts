import { Hono } from 'hono';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import { buildGreeting } from './domain/index.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { TemplateDeps } from './domain/index.js';

/**
 * Manifest factory: dependencies arrive from the composition root (the
 * `app.ts` assembly), so routes never import adapters themselves. Every
 * route declares its class via `routeClass` as its first handler — the
 * pipeline default-denies any route that reaches it undeclared.
 *
 * The return type is deliberately inferred: annotating it with a bare
 * `Hono<AppEnv>` widens the routes to `BlankSchema` and erases the route
 * schema from `AppType` (the typed client goes blind to this slice).
 */
export function createTemplateManifest(deps: TemplateDeps) {
  return defineSliceManifest({
    basePath: '/template',
    routes: new Hono<AppEnv>().get('/greeting', routeClass('public'), (c) => {
      return c.json({ greeting: buildGreeting(deps.clock) });
    }),
  });
}
