import type { Context, TypedResponse } from 'hono';
import type { JSONParsed } from 'hono/utils/types';

/**
 * The shared success tail. Returns `c.json(body, 200)` while preserving the
 * concrete body type instead of widening it to `Response`.
 *
 * `hc<AppType>` infers a route's 200 body only when the handler's returned
 * value keeps its `TypedResponse<T>` type through to the route chain. Annotating
 * a success return as bare `Response` — or routing it through a helper that
 * does — erases `T`, blinding the typed client and forcing the web app to
 * re-assert every body by hand. Every slice routes its 200 through this idiom
 * (or an inline `c.json(body, 200)`, which is type-equivalent) so the body type
 * flows into `AppType`.
 */
export function respondOk<T extends object>(
  c: Context,
  body: T
): TypedResponse<JSONParsed<T>, 200, 'json'> {
  return c.json(body, 200);
}
