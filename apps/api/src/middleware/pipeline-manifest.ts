import type { AppEnv } from '../lib/context/index.js';
import type { Hono } from 'hono';

/**
 * # The slice route manifest — the contract every slice ships routes with
 *
 * A slice exposes its HTTP surface as ONE manifest entry:
 *
 * ```ts
 * // slices/<name>/routes.ts
 * import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
 * import type { AppEnv } from '../../middleware/pipeline-manifest.js';
 *
 * export function createGreetingManifest(deps: GreetingDeps) {
 *   return defineSliceManifest({
 *     basePath: '/greeting',
 *     routes: new Hono<AppEnv>()
 *       .get('/', routeClass('public'), (c) => c.json(buildGreeting(deps.clock))),
 *   });
 * }
 * // slices/<name>/index.ts (the barrel)
 * export { createGreetingManifest } from './routes.js';
 * ```
 *
 * and the app assembly mounts it with ONE chained line (chaining keeps `AppType`
 * inference intact for the typed `hc` client):
 *
 * ```ts
 * .route(greetingManifest.basePath, greetingManifest.routes)
 * ```
 *
 * The rules the contract carries:
 * - **Every route declares a class** via `routeClass(…)` as its first
 *   handler (or a wildcard `use` for a subtree). The pipeline default-denies
 *   any route that reaches it undeclared — declaring is not optional.
 * - **Dependencies arrive through the factory's `deps` parameter** (wired by
 *   the composition root) or through the pipeline's `c.var` DI (db, redis,
 *   logger, envUtils, principal). Routes never construct adapters.
 * - **Sub-routers must not install their own `onError`** — error mapping is
 *   owned by the assembly, and a sub-app error handler makes Hono wrap the
 *   slice's handlers at mount time.
 * - Routes hold no business logic; handlers call the slice's domain barrel.
 *
 * This module is importable from slice `routes.ts` files (boundaries: routes
 * may import `middleware/pipeline*`), which is why it re-exports the types
 * and the `routeClass` marker slices need.
 */
export interface SliceRouteManifest<TRoutes extends Hono<AppEnv> = Hono<AppEnv>> {
  /** Mount point under the app, e.g. '/auth'. Leading slash, no trailing slash. */
  readonly basePath: `/${string}`;
  /** The slice's typed sub-router; every route declares a class via `routeClass`. */
  readonly routes: TRoutes;
}

/**
 * Validating identity helper: registration-time fail-fast on a malformed
 * basePath, with full type inference preserved for the assembly's `.route()`
 * chaining.
 */
export function defineSliceManifest<
  const TBasePath extends `/${string}`,
  TRoutes extends Hono<AppEnv>,
>(manifest: { basePath: TBasePath; routes: TRoutes }): { basePath: TBasePath; routes: TRoutes } {
  const basePath: string = manifest.basePath;
  if (!basePath.startsWith('/') || basePath === '/' || basePath.endsWith('/')) {
    throw new Error(
      `manifest: invalid basePath ${JSON.stringify(basePath)} — expected '/<segment>' with a leading slash and no trailing slash.`
    );
  }
  return manifest;
}

export { routeClass } from './pipeline-markers.js';
export { respondOk } from '../lib/context/index.js';
export type { AppEnv, Principal, RouteClass, SessionClaims } from '../lib/context/index.js';
