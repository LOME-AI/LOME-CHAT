# T21 — batched cleanup (4 validated Minors) — impl-report-1

## Objective

Apply four small validated mid-run audit findings as independent minimal changes:
1. Correct the stale `DELETE_ACCOUNT_LOCKED` "never on the wire" comment (now a 403).
2. Replace 8 inline `.max(1024)` KE-array sites with one identity-domain-scoped
   `MAX_KE_ARRAY_LENGTH = 1024` constant.
3. Add a route-level test asserting admin's manual `claimKeyRow` path returns
   `REQUEST_IN_PROGRESS`.
4. Resolve the never-exercised `spec.values === undefined` sub-branch at
   `model-call-execution.ts:203`.

## Files changed

- `packages/shared/src/error-codes.ts` — corrected the client-code group comment
  (`:111-115`) to state `DELETE_ACCOUNT_LOCKED` is the exception that is wire-emitted (403).
- `packages/shared/src/error-codes.test.ts` — corrected the mirror comment
  (`:208-212`) the same way. The block asserts only registration + copy mapping, so no
  assertion changed (the stale claim lived only in the comment).
- `apps/api/src/slices/identity/domain/opaque.ts` — homed the new exported
  `MAX_KE_ARRAY_LENGTH = 1024` constant (narrowest scope covering all four consumer files;
  all four already import from `./opaque.js`, so no new cross-slice edge).
- `apps/api/src/slices/identity/domain/deletion.ts` — value-import `MAX_KE_ARRAY_LENGTH`;
  both `.max(1024)` → `.max(MAX_KE_ARRAY_LENGTH)`.
- `apps/api/src/slices/identity/domain/login.ts` — same (added to existing opaque import).
- `apps/api/src/slices/identity/domain/password-change.ts` — same.
- `apps/api/src/slices/identity/domain/two-factor-disable.ts` — same (added a value import;
  previously only a type-import of `OpaqueFinishFlow`).
- `apps/api/src/slices/admin/routes.integration.test.ts` — added a value-import of
  `hashCanonicalJson`/`uuidFromHex` and one route-level test seeding a live request-kind key
  claim → asserting `REQUEST_IN_PROGRESS` + zero effect.
- `apps/api/src/slices/workflows/nodes/model-call-execution.test.ts` — added one test
  covering the `spec.values === undefined` sub-branch (degenerate enum ParamSpec).
- `apps/api/src/slices/workflows/nodes/model-call-execution.ts` — **net-zero**. Temporarily
  mutated (sub-branch removed) only to prove reachability, then exactly restored from backup;
  line 203 is unchanged.

## Tests added

- `admin routes … answers REQUEST_IN_PROGRESS when a live claim already holds the key, zero
  effect` — item 3. Covers the admin engine's `claimKeyRow` in-progress arm at the route
  layer (mirrors the billing `byKey` body-mismatch test pattern).
- `createModelCallExecution … accepts any duration for a video model whose durationSeconds
  enum declares no values (degenerate spec)` — item 4. Reaches the
  `spec.values === undefined` sub-branch.

## Per-item detail + evidence

### Item 1 — stale comment (comment/classification fix, no behavior change)

Verified `DELETE_ACCOUNT_LOCKED` IS now emitted on the wire: `identity/routes.ts:919`
`createErrorResponse(ERROR_CODES.DELETE_ACCOUNT_LOCKED, …)` returned as a **403** (T01's
deletion-lock path), and `routes.integration.test.ts` asserts `body.code ===
DELETE_ACCOUNT_LOCKED` at 5 sites. The other three codes in the group
(`STORAGE_READ_FAILED`, `INCORRECT_PASSWORD`, `NO_PENDING_DELETE_ACCOUNT`) have zero
`createErrorResponse` call sites — genuinely client-only. Both comments now say "three are
client-only; `DELETE_ACCOUNT_LOCKED` is the exception, emitted on the wire as a 403." The
test-block comment change was comment-only (no stale assertion existed).
Evidence: `pnpm test:shared` error-codes.test.ts → 38 passed.

### Item 2 — named constant (pure refactor, behavior identical)

All 8 `.max(1024)` sites across the four files now read `.max(MAX_KE_ARRAY_LENGTH)`, sourced
from the single `opaque.ts` export. `grep` confirms zero remaining `.max(1024)` in
`identity/domain/`. Home is identity-domain (`opaque.ts`), NOT `packages/shared` — only
identity uses it (NEEDS_CONTEXT trigger checked: no cross-slice import forced, all four files
already imported from `./opaque.js`). Existing 1024/1025 accept/reject tests pin the behavior.
Evidence: identity domain suites (deletion/login/password-change/two-factor-disable/opaque)
→ 32 passed; typecheck api exit 0.

### Item 3 — admin REQUEST_IN_PROGRESS route test (RED→GREEN)

Located the path: `admin/routes.ts:266-286` (`POST /ops/:name/execute`) → `runAdminOp` →
`engine.ts:412` `claimKeyRow(...)`; a live `claimed` request-kind row with matching bodyHash
held by a different executor resolves through `disambiguateLiveClaim` →
`requestInProgressError()` (`lib/idempotency/key-row.ts:141`, wireCode `REQUEST_IN_PROGRESS`,
`conflict` → 403… → 409). The test computes the engine's exact scope
(`userId = uuidFromHex(hashCanonicalJson({adminActor: ADMIN_EMAIL}))`,
`bodyHash = hashCanonicalJson({input, undoes: null})`), seeds the row (`status` defaults
`claimed`, lease unexpired), then executes the same key.
- GREEN: `-t "REQUEST_IN_PROGRESS"` → 1 passed (status 409, `{code:'REQUEST_IN_PROGRESS'}`,
  zero audit/scratch effect).
- RED verification: temporarily seeding a mismatched `bodyHash` flipped the response to
  `{code:'IDEMPOTENCY_BODY_MISMATCH'}` and failed the assertion — proving the test genuinely
  discriminates the in-progress arm, not just any 409. Restored.
Location note (NEEDS_CONTEXT trigger checked): admin route-test file and `claimKeyRow` path
were both clearly locatable; no blocker.

### Item 4 — branch coverage: RESOLUTION = reachable-so-tested (test added; source net-zero)

`ParamSpec.values` is `z.array(...).min(1).optional()` (`packages/shared/src/param-spec.ts:22-25`),
so the enum variant does **not** guarantee `values` is present — `{type:'enum'}` with no
`values` is a type-valid `ParamSpec`. Therefore the `spec.values === undefined` sub-branch at
`model-call-execution.ts:203` is **genuinely reachable**, not dead. It is also load-bearing:
`baseSchema` throws `Enum param "…" must declare values` (`param-spec.ts:62-63`) when an enum
spec lacks values, so the guard prevents that throw for degenerate descriptors.

Resolution (b): I added a colocated test (video descriptor with
`parameters: { durationSeconds: { type: 'enum', wire: 'providerOptions' } }`, no values) that
asserts the call passes through (`isOk`), exercising the sub-branch. I did NOT simplify or
touch line 203 (simplifying would delete legitimate, reachable defensive logic).
- GREEN: `-t "declares no values"` → 1 passed.
- Reachability proof (temporary source mutation, reverted): removing `|| spec.values ===
  undefined` made the test FAIL with `compileParamSpec` throwing `Enum param "durationSeconds"
  must declare values` — confirming the branch executes and is load-bearing. Source restored
  from backup; line 203 is byte-identical to its pre-task state.

## Self-gate

| Command | Result |
| --- | --- |
| `test:shared` — error-codes.test.ts | pass — 38/38 |
| `test:api` — identity domain (deletion, login, password-change, two-factor-disable, opaque) | pass — 32/32 |
| `test:api` — admin/routes.integration.test.ts + workflows/nodes/model-call-execution.test.ts | pass — 79/79 |
| `eslint` owned files (from apps/api dir, after last edit) | exit 0 |
| `eslint` owned files (from packages/shared dir, after last edit) | exit 0 |
| `tsgo --noEmit` (apps/api) | exit 0 |
| `tsgo --noEmit` (packages/shared) | exit 0 |

Runs were scoped + coverage-free per the plan's Phase-4 note (full-coverage `test:api`
OOMs in this sandbox).

### Attribution

- **`pipeline-bindings.ts` ExecutionContext error (brief-flagged, pre-existing):** did NOT
  surface — `tsgo --noEmit` on apps/api returned exit 0 with no diagnostics. Nothing to
  attribute out from this session.
- **Pre-existing identity files from T01/T02 (not mine):** `identity/domain/index.ts`,
  `keys.ts`, `keys.test.ts`, `deletion.test.ts`, `login.test.ts` (modified) and the untracked
  `password-change.test.ts` / `two-factor-disable.test.ts` appear in `git status` from prior
  tasks in this uncommitted run. I did not touch them. My edits are confined to the 9 files
  in "Files changed" (and `model-call-execution.ts` is net-zero).

## Deviations

None.

## Concerns and limitations

- `model-call-execution.ts` shows as modified in `git status` because it was already modified
  by a prior task (T15); my temporary mutate+restore leaves it net-zero relative to that
  pre-task state (verified: line 203 unchanged).
- Item 4's covering test relies on the type-level fact that `ParamSpec.values` is optional; if
  a future arch rule ever forbids constructing enum specs without `values`, the branch would
  become dead and the guard could then be simplified. Not the case today.

## Confidence

High — all four items are small, independently verified (items 3 and 4 with explicit RED
checks), full scoped self-gate green, and no source behavior changed except the two added
tests and the constant refactor (pinned by existing 1024/1025 tests).
