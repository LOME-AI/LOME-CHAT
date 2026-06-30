import { COMPOSED_HANDLER } from 'hono/utils/constants';
import { ROUTE_CLASSES } from '../lib/context/index.js';
import type { AppEnv, RouteClass, Variables } from '../lib/context/index.js';
import type { Context, MiddlewareHandler } from 'hono';

/**
 * Route-class declaration travels as a symbol-keyed property on the handler
 * function itself (not on path strings), so the authorizer can resolve the
 * class from the router's matched handlers without re-deriving path patterns
 * — immune to basePath/mount-prefix string drift by construction.
 */
const ROUTE_CLASS_KEY = Symbol('hushbox.routeClass');
const PIPELINE_HANDLER_KEY = Symbol('hushbox.pipelineHandler');

const ROUTE_CLASS_SET: ReadonlySet<string> = new Set(ROUTE_CLASSES);

/**
 * Declares the route class of every route it is registered on. The marker
 * itself is a pass-through: enforcement is centralized in the authorizer,
 * which reads the declaration off the matched handler chain BEFORE the
 * terminal handler runs. Use it as the first handler of a route:
 *
 * ```ts
 * new Hono<AppEnv>().get('/me', routeClass('session'), (c) => …)
 * ```
 */
export function routeClass(cls: RouteClass): MiddlewareHandler<AppEnv> {
  // Registration-time fail-fast: the union is closed; an unknown value from a
  // cast or untyped call site must die at composition, not silently deny.
  if (!ROUTE_CLASS_SET.has(cls)) {
    throw new Error(`pipeline: unknown route class ${JSON.stringify(cls)}`);
  }
  // eslint-disable-next-line unicorn/consistent-function-scoping -- each call must return a distinct function instance: the class declaration is attached to it
  const marker: MiddlewareHandler<AppEnv> = (_c, next) => next();
  return Object.assign(marker, { [ROUTE_CLASS_KEY]: cls });
}

/**
 * Reads a pipeline-populated variable WITHOUT the type-level promise that the
 * stage which sets it has run: Hono types `c.get` as always-present for
 * declared Variables, but a mis-ordered composition leaves them undefined at
 * runtime. The widened return type forces callers to fail fast on that case.
 */
export function readPipelineVariable<K extends keyof Variables>(
  c: Context<AppEnv>,
  key: K
): Variables[K] | undefined {
  return c.get(key);
}

/** Reads a route-class declaration off a matched handler, if any. */
export function readRouteClass(handler: unknown): RouteClass | undefined {
  const unwrapped = unwrapComposedHandler(handler);
  if (typeof unwrapped !== 'function') return undefined;
  const value = (unwrapped as unknown as Record<symbol, unknown>)[ROUTE_CLASS_KEY];
  return typeof value === 'string' && ROUTE_CLASS_SET.has(value)
    ? (value as RouteClass)
    : undefined;
}

/**
 * Marks a middleware as pipeline-owned so the authorizer can tell "only the
 * pipeline matched (no such route → 404)" apart from "a real route matched
 * without a class declaration (→ default-deny)".
 */
export function markPipelineHandler(handler: MiddlewareHandler<AppEnv>): MiddlewareHandler<AppEnv> {
  return Object.assign(handler, { [PIPELINE_HANDLER_KEY]: true });
}

export function isPipelineHandler(handler: unknown): boolean {
  const unwrapped = unwrapComposedHandler(handler);
  if (typeof unwrapped !== 'function') return false;
  return (unwrapped as unknown as Record<symbol, unknown>)[PIPELINE_HANDLER_KEY] === true;
}

/**
 * Hono's `.route()` wraps a sub-app's handlers when the sub-app carries its
 * own error handler, storing the original under `COMPOSED_HANDLER`. Unwrap so
 * declarations survive composition regardless of how a sub-router was built.
 */
function unwrapComposedHandler(handler: unknown): unknown {
  let current = handler;
  while (
    typeof current === 'function' &&
    (current as unknown as Record<string, unknown>)[COMPOSED_HANDLER] !== undefined
  ) {
    current = (current as unknown as Record<string, unknown>)[COMPOSED_HANDLER];
  }
  return current;
}
