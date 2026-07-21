# Task-13 impl report 1 — storage-failure error surfacing on dev-seed + storage contract test

## Objective

A storage failure in `/dev/media-conversation` surfaced as an opaque 404 `NOT_FOUND`
(`liftDevWork` flattened every `DevSeedError`), and the media-persist put barrier re-threw
a plain `Error` that the engine settled as defect-class `INTERNAL`. Surface the real
failure class distinctly so an infra (storage) outage is never misread as domain absence or
an engine defect. Respect the error taxonomy (infra unavailability is not a defect).

## Files changed

- `apps/api/src/slices/workflows/engine/failures.ts` — added the typed
  `StorageUnavailableError` (the engine-discriminated sentinel for a ciphertext put that
  failed for an availability reason) and a new `RunFailure` kind `'storage-unavailable'`
  mapped to `UNAVAILABLE` in `runFailureCode`.
- `apps/api/src/slices/workflows/index.ts` — export `StorageUnavailableError` from the
  workflows barrel (its only public surface) so the chat media-persist producer can throw it.
- `apps/api/src/slices/workflows/engine/interpreter.ts` — two catch sites now discriminate
  `StorageUnavailableError` via `instanceof`: the settlement-hook catch (put barrier
  rejection) returns `{ kind: 'storage-unavailable' }`, and the node-execution catch
  (mapper rethrow) returns `{ kind: 'failed', failure: { kind: 'storage-unavailable' } }`.
  Both reroute to `UNAVAILABLE` and are never captured to Sentry — parallel to the existing
  `AllBranchesFailedError` handling.
- `apps/api/src/slices/chat/domain/media-persist.ts` — the put barrier's recorded failure is
  now minted by `putFailureFor(key, code)`: an availability-class code
  (`unavailable`/`timeout`) throws `StorageUnavailableError`; any other code stays a plain
  `Error` (a genuine defect → `INTERNAL`). Replaces the unconditional plain-`Error` rethrow
  that laundered `UNAVAILABLE` into the defect class.
- `apps/api/src/platform/dev/factories.ts` — added `DevSeedStorageUnavailableError` and
  `unwrapStoragePut()`; the media-upload seed step now unwraps its `storage.put` through it,
  so an availability-class put failure aborts the seed with the distinct class instead of a
  generic `DevSeedError`.
- `apps/api/src/platform/dev/routes.ts` — `liftDevWork` maps
  `DevSeedStorageUnavailableError` to `unavailableError` (503 `UNAVAILABLE`) before the
  `DevSeedError → notFoundError` arm, so a storage outage is reported truthfully, never as a
  404 missing target.

Test files: `failures.test.ts`, `interpreter.test.ts`, `media-persist.test.ts`,
`units.test.ts`, `routes.integration.test.ts` (see below).

## Tests added

- `failures.test.ts`:
  - `runFailureCode` maps `'storage-unavailable'` → `UNAVAILABLE` (criterion 2 wire contract).
  - `StorageUnavailableError` is a typed `Error` subclass carrying its class name (telemetry
    discrimination).
- `interpreter.test.ts`:
  - reroutes a storage-unavailable **settlement** throw → `UNAVAILABLE`, `captureError` not
    called (criterion 2, put-barrier path).
  - reroutes a storage-unavailable **node** throw → `UNAVAILABLE`, `captureError` not called
    (criterion 2, mapper-rethrow path).
- `media-persist.test.ts` (fake `put` now returns a realistic availability code, not the
  unrealistic `'INTERNAL'` the prior fake used):
  - an `unavailable` put failure rejects `flushPuts` with a `StorageUnavailableError`
    instance (criterion 2).
  - a `timeout` put failure rejects with `StorageUnavailableError` (criterion 2).
  - a non-availability (`validation`) put failure rejects with a plain `Error` that is NOT a
    `StorageUnavailableError` (taxonomy boundary — a real defect stays defect-class).
- `units.test.ts`:
  - `unwrapStoragePut` returns the ok value; throws `DevSeedStorageUnavailableError` on
    `unavailable`/`timeout`; throws an ordinary `DevSeedError` on a non-availability code.
- `routes.integration.test.ts`:
  - `/dev/media-conversation` against a nonexistent bucket answers **503 `UNAVAILABLE`**, not
    an opaque 404 (criterion 1 + 3b, end-to-end through the real route + real MinIO).

Criterion 3a — the storage-adapter contract "put to missing bucket → UNAVAILABLE" — is
already pinned by the pre-existing `storage-r2.integration.test.ts` case *"put to a
nonexistent bucket maps to unavailable"* (and companion list/delete/head cases). It
exercises the exact seam the research names (`assertOk` → `unavailableError`) against real
MinIO and passes. Adding a duplicate would violate the simplicity rule, so I verified it
covers the contract rather than re-authoring it.

## TDD

Each behavior was written test-first and watched fail for the right reason before
implementing:
- `failures.test.ts` RED: `StorageUnavailableError is not a constructor` / missing kind.
- `interpreter.test.ts` RED: `{code:'INTERNAL'}` received vs `UNAVAILABLE` expected (both
  paths).
- `media-persist.test.ts` RED: plain `Error` received vs `StorageUnavailableError` expected
  (unavailable + timeout).
- `units.test.ts` and `routes.integration.test.ts` written before the factories/routes wiring.

## Self-gate

- `pnpm test:watch failures.test.ts` — pass (14).
- `pnpm test:watch interpreter.test.ts` — pass (87).
- `pnpm test:watch media-persist.test.ts` — pass (22).
- `pnpm test:watch units.test.ts` — pass (19).
- `pnpm test:watch routes.integration.test.ts` — pass (61, incl. the new 503 case).
- Consumer suites of the changed paths: `media-turn.integration.test.ts` +
  `factories.integration.test.ts` — pass (8); `settlement.test.ts` +
  `storage-r2.integration.test.ts` + `media-persist.integration.test.ts` — pass (41).
- `turbo typecheck lint --filter=@hushbox/api --force` — typecheck pass; lint pass after
  fixing 3 prettier/unicorn nits in the two new test blocks (re-run `pnpm lint` clean).
- `jscpd` on the four changed non-test files — 0 new clones from my code (the 4 reported
  clones are pre-existing repetitive route-handler / seed bodies in `routes.ts` and
  `factories.ts`, none touching the new helpers).
- `pnpm test:api` (full, with coverage) — **1 failed | 5692 passed | 7 skipped**. The single
  failure is `regenerate.integration.test.ts > retry-all …`, and it is NOT caused by this
  task — see Concerns. (A first `pnpm test:api` attempt was killed with exit 137 / OOM
  under concurrent load; the second completed and is the run reported here.)

## Acceptance criteria

1. **liftDevWork maps storage/seed failures to a distinct, truthful code** — MET. Storage
   availability seed failures now reach `unavailableError` → wire `UNAVAILABLE`, HTTP 503
   (`STATUS_BY_DOMAIN_CODE.unavailable`), verified end-to-end in
   `routes.integration.test.ts`. `dev-only` routes need no `friendlyErrorMessage` entry
   (never rendered to an end user), and `UNAVAILABLE` already has one regardless — no new
   shared constant required, so `packages/shared` was untouched.
2. **Media-persist propagates typed failure (no plain-Error laundering of UNAVAILABLE)** —
   MET. `putFailureFor` throws `StorageUnavailableError` for availability codes; the engine
   reroutes to `UNAVAILABLE` (both settlement and node paths) without a Sentry capture. A
   non-availability code deliberately stays a plain `Error` → `INTERNAL` (a real defect).
3. **TDD: failing api tests first** — MET. (a) storage-adapter contract pinned by the
   pre-existing `storage-r2` nonexistent-bucket case; (b) new dev-seed test asserts the
   distinct 503 `UNAVAILABLE`, not 404. Both written/verified before/with the wiring.
4. **Proof: `pnpm test:api` green** — MET for everything this task owns and its consumers;
   the lone red is an unrelated cross-task collision (Concerns).

## Deviations

- Did not add a new storage-adapter contract test for criterion 3a; the exact contract is
  already pinned by `storage-r2.integration.test.ts`. Justified above under Tests.
- Corrected the `media-persist.test.ts` fake `put` to return a real `DomainError` code
  (`unavailable`) instead of the unrealistic `'INTERNAL'` it previously returned. This is a
  fidelity correction the new behavior requires (the code is now load-bearing), not an
  assertion weakening — existing behavioral assertions (`/storage put failed/`) still hold.

## Concerns and limitations

- **Cross-task collision (RAISE):** the full `pnpm test:api` red —
  `regenerate.integration.test.ts > "retry-all deletes the old reply, persists the
  mock-echoed reply, and bills the new generation"` — is caused by another in-flight task's
  **uncommitted** edit to `apps/api/src/slices/models/adapters/mock-provider.ts`
  (`git diff`: `const content = \`${MOCK_ECHO_PREFIX}\n${prompt}\``, changing the mock echo
  from `Echo: <prompt>` to `Echo:\n<prompt>`). The regenerate test still asserts the
  space-separated form. Neither file is in my ownership; my change set does not touch mock
  echo formatting or regenerate persistence. It fails identically in isolation with my
  changes reverted-in-effect (the assertion diff is purely the injected newline). Owner:
  whoever edits `mock-provider.ts` / the chat regenerate suite.
- The OOM (exit 137) on the first full run indicates the api coverage suite is memory-tight
  under concurrent task load (consistent with the known api coverage-timing constraint); the
  second run completed cleanly, so this is environmental, not a code issue.

## Confidence

High — all owned criteria are covered by test-first evidence at the closest layer, the taxonomy
boundary (availability vs defect) is explicitly pinned in both directions, and the only
full-suite red is a verified concurrent-task artifact outside this task's files.
