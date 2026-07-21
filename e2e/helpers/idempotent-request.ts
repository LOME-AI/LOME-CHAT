import type { APIRequestContext, APIResponse } from '@playwright/test';

/**
 * The options bag Playwright's mutating request methods accept (`data`,
 * `headers`, `params`, …). Derived from the context type so it can never drift
 * from Playwright's real signature.
 */
type MutatingRequestOptions = NonNullable<Parameters<APIRequestContext['post']>[1]>;

/**
 * Every mutating route on the product Worker is idempotency-gated: the
 * middleware rejects a POST/PUT/PATCH/DELETE that carries no `Idempotency-Key`
 * with 400 `IDEMPOTENCY_KEY_REQUIRED` (billing/routes.ts et al.). A raw
 * `request.post(url)` from a test therefore 400s before the app logic runs.
 *
 * These wrappers are the single sanctioned way to issue a mutating raw
 * request-context call in the suite: each mints a fresh `Idempotency-Key` per
 * call, so a retry inside {@link withRequestRetry} re-sends the same key and the
 * app treats it as one logical mutation. Hand-rolling the header at a call site
 * (`headers: { 'Idempotency-Key': crypto.randomUUID() }`) is banned by lint —
 * route through here instead, so the key discipline lives in one place.
 *
 * A caller may still pass its own `headers` for non-idempotency needs; the fresh
 * key is applied first and caller headers are merged over it.
 */
function mutate(
  request: APIRequestContext,
  method: 'post' | 'put',
  url: string,
  options?: MutatingRequestOptions
): Promise<APIResponse> {
  const idempotencyKey = crypto.randomUUID();
  return request[method](url, {
    ...options,
    headers: { 'Idempotency-Key': idempotencyKey, ...options?.headers },
  });
}

/** POST a mutating request with a fresh `Idempotency-Key`. */
export function idempotentPost(
  request: APIRequestContext,
  url: string,
  options?: MutatingRequestOptions
): Promise<APIResponse> {
  return mutate(request, 'post', url, options);
}

/** PUT a mutating request with a fresh `Idempotency-Key`. */
export function idempotentPut(
  request: APIRequestContext,
  url: string,
  options?: MutatingRequestOptions
): Promise<APIResponse> {
  return mutate(request, 'put', url, options);
}
