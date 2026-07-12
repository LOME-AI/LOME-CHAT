/**
 * Per-mutation `Idempotency-Key` that survives TanStack retries.
 *
 * The app configures `mutations.retry` (see `providers/query-provider.tsx`), and
 * TanStack re-invokes `mutationFn(variables)` on every retry with the SAME
 * `variables` object reference. Minting a uuid inside `mutationFn` would produce
 * a fresh key per attempt — defeating server-side dedup in exactly the retry
 * case the key exists for. Keying a `WeakMap` on the stable `variables`
 * reference mints once per logical `mutate()` call and reuses it across retries;
 * the entry is collected with the `variables` object, so nothing leaks. This is
 * the mint-once-reuse-across-retries discipline the chat run path applies at its
 * own call boundary (`hooks/chat/use-chat-stream.ts`), externalized for the
 * TanStack mutation shape where the retry loop lives outside our code.
 */
const keyByVariables = new WeakMap<object, string>();

/**
 * The idempotency key for one logical mutation. Stable across TanStack retries
 * of the same `mutate()` call (same `variables` reference), fresh for a new call.
 */
export function idempotencyKeyFor(variables: object): string {
  const existing = keyByVariables.get(variables);
  if (existing !== undefined) return existing;
  const key = crypto.randomUUID();
  keyByVariables.set(variables, key);
  return key;
}

/**
 * Per-call header object for a typed-client mutation, e.g.
 * `client.x.$post({ json }, idempotentHeaders(variables))`.
 */
export function idempotentHeaders(variables: object): {
  headers: { 'Idempotency-Key': string };
} {
  return { headers: { 'Idempotency-Key': idempotencyKeyFor(variables) } };
}
