# Task-42 impl-report-1 — coalesce the two sequential session-revocation Redis reads

## Objective

`checkSessionRevocation`/`checkSessionLiveness` issued TWO sequential Redis HTTP GETs per
authenticated request (`sessionActive` then `passwordChangedAt`). On `'*'` across 12 workers
this doubles load on the single SRH proxy. Coalesce into ONE round-trip, preserving EXACT
fail-closed revocation semantics.

## Files changed

- `apps/api/src/lib/redis/operations.ts` — added a typed `redisMGet` wrapper (one `MGET`
  round-trip over N registry keys, parsing each returned value through its own entry's
  schema) plus `redisMGetEntry` (binds buildKey args type-safely and captures the schema)
  and the `RedisMGetEntry` type. Mirrors `redisGet`'s per-value contract: missing key →
  `null`, schema-invalid stored value → validation error, unreachable Redis → unavailable
  error (fail-closed).
- `apps/api/src/lib/redis/index.ts` — barrel exports for `redisMGet`, `redisMGetEntry`, and
  the `RedisMGetEntry` type.
- `apps/api/src/slices/identity/domain/revocation.ts` — `checkSessionLiveness` now fetches
  both keys via `redisMGet([sessionActive, passwordChangedAt])` and applies the identical
  decision. Signature and return type unchanged (all consumers — `app.ts` pipeline,
  `adapters/conversation-room.ts` realtime backstop — unaffected).
- `apps/api/src/slices/identity/domain/revocation.integration.test.ts` — added a
  round-trip-count test (via a forwarding `countingRedis` Proxy).
- `apps/api/src/lib/redis/operations.integration.test.ts` — added a `redisMGet` describe
  block (heterogeneous keys / single round-trip / missing-key null / validation error /
  unavailable).

## Tests added

- `revocation.integration.test.ts` › "issues a single Redis round-trip for the full
  active-session check" — proves AC-3 round-trip reduction. Uses a Proxy counting `get`+`mget`
  calls (spying on Upstash methods directly is unreliable — accessor-defined). Criterion: AC-1/AC-3.
- `operations.integration.test.ts` › redisMGet: "fetches heterogeneous keys in a single
  round-trip preserving order" (round-trip + ordering + per-schema parse), "returns null for a
  missing key while parsing present siblings", "surfaces a validation error when a stored value
  fails its schema", "surfaces an unavailable error when redis is unreachable". Criterion: AC-2.
- Existing revocation semantic tests (active / revoked-absent / pw-changed-before /
  pw-changed-after / unreachable→fail-closed) retained unchanged and stay green — they pin
  that the decision is identical under the coalesced read (AC-1).

## Self-gate (from apps/api)

- `pnpm exec tsx ../../scripts/with-env.ts vitest run revocation.integration.test.ts operations.integration.test.ts` — pass — 42/42.
- `pnpm exec tsgo --noEmit` — pass — exit 0.
- `pnpm exec eslint <5 edited files>` — pass — exit 0.
- `pnpm exec prettier --check <5 edited files>` — pass — exit 0.
- Coverage: ran the two test files with `--coverage`; `operations.ts` and `revocation.ts`
  produced NO per-file threshold errors (the only errors were for `define-key.ts` /
  `platform-keys.ts`, whose own test files were not part of this scoped two-file run). All
  branches of the new code are exercised.

## Acceptance criteria

1. **One round-trip, exact semantics — met.** `redisMGet` issues a single `MGET`. Decision
   preserved: `active === null` → `revoked` (regardless of pw-changed value); else
   `createdAt < changedAt` → `revoked`, else `active`; any read error → unavailable
   (fail-closed). Round-trip-count test proves 2→1 (RED: "expected 2 to be 1"; GREEN: 1).
2. **Typed key-registry, no raw keys — met.** Keys come only from `IDENTITY_KEYS` via
   `redisMGetEntry(definition, ...args)` (calls the registry's `buildKey`); the new wrapper
   lives in `operations.ts` and mirrors `redisGet`'s parse/error contract faithfully.
3. **TDD round-trip assertion — met.** Wrote the count test first, watched it fail against the
   two-GET code (RED evidence below), implemented, watched pass.

## RED→GREEN evidence

- RED: `revocation.integration.test.ts:110 expect(counting.roundTrips()).toBe(1)` →
  `AssertionError: expected 2 to be 1` (two sequential GETs today).
- GREEN: after coalescing, same test passes; full scoped run 42/42.

## Deviations with reasons

- **Round-trip counting uses a forwarding Proxy, not `vi.spyOn`.** Verified `vi.spyOn(redis,
  'get')` records 0 calls against the Upstash client (its command methods are accessor-defined,
  so the spy wraps the getter, not the call). The Proxy counts `get`+`mget` invocations
  reliably. Documented inline.
- **Exact-semantics corner (documented, not a weakening).** The old code short-circuited and
  never read/validated `passwordChangedAt` when `sessionActive` was absent. `redisMGet` fetches
  and parses both. In the single pathological case where `sessionActive` is absent AND a corrupt
  `passwordChangedAt` value fails its `z.coerce.number()` schema, the old code returned `revoked`
  while the new code returns a validation error. Both DENY the request (the pipeline treats every
  `Result` error as fail-closed), so no session that should be revoked ever becomes `active` — the
  security invariant is fully preserved; only the denial's error label differs in that
  theoretical corner (`passwordChangedAt` is a coerced number written by our own code, so a
  schema-invalid value is not reachable in practice).

## Concerns and limitations

- Behavioral (e2e) proof deferred to the orchestrator's consolidated run per Global Constraints
  (no per-task e2e). Proven at the closest integration layer against real local Redis.
- `redisMGet` is a general N-key wrapper but currently has exactly one caller; kept minimal
  (no pipeline/transaction features beyond the single `MGET` the task needs).

## Confidence

High — pure round-trip reduction; signature and decision unchanged; all consumers untouched;
RED→GREEN captured; typecheck/lint/prettier clean; changed files meet the per-file coverage gate.
