# Plan — Legacy→New Parity Remediation

**Tier 2.** Remediates 20 verified findings (R1–R8, R10, R12, R14–R23) from
`docs/history/2026-07-21-legacy-parity-audit.md`. R9, R11, R13 are explicitly out of scope
(founder ruling). Each finding is a parity restoration or a ruled decision; the audit's
`file:line` citations are the map, and `research/*.md` holds the exact legacy-source anchors
and current-code shapes each task needs.

> Task detail (acceptance criteria, file ownership, interfaces, dependency graph) is filled
> in below after the Phase-1 research pass lands. This header + Global Constraints are stable.

## Global Constraints

Implicitly part of every task's acceptance criteria and every auditor's lens.

- **G1 — Parity is against real legacy source.** Every task that restores legacy behavior
  cites the exact `legacy/**` source `file:line` for the target behavior/value. The auditor
  independently opens that legacy source and confirms the new code reproduces it — the audit
  report is corroboration, not the primary authority. State precisely what must match.
- **G2 — TDD, no exceptions.** Red→green→refactor. A bug-fix parity task writes the failing
  parity test FIRST (it reproduces the regression), watches it fail for the right reason,
  then implements. No production line without a failing test.
- **G3 — Environment branching only via `envUtils`/`createEnvUtilities()`.** Never `NODE_ENV`,
  `CI`, or `E2E` directly; never branch on a var's existence; no `??` env fallbacks
  (CODE-RULES). Applies especially to R22 mock delays, which must reproduce legacy's env gate.
- **G4 — Error contracts.** New/changed API errors use `{code, details?}` (no message field);
  `code` is a constant in `packages/shared/src/error-codes.ts` with a `friendlyErrorMessage`
  entry and copy in `packages/shared/src/error-messages.ts`; responses via
  `createErrorResponse`. Domain code returns `Result`; expected domain failures never reach
  Sentry.
- **G5 — One Implementation, Shared.** No new copy of logic that must stay identical across
  callers (directly relevant to R19/R20). Collapse to one shared implementation at the
  narrowest scope covering all callers; never a "keep in sync" comment.
- **G6 — Money/nano-USD, single-writer-per-table, ports** conventions unchanged; no task
  introduces a numeric money column, a second writer, or an external call inside `settle()`.
- **G7 — Surgical.** Every changed line traces to its finding. Do not refactor adjacent code,
  restyle, or delete pre-existing dead code beyond what the finding rules on.
- **G8 — Durable naming.** Final orthodox names/paths, no `v2`/task-id suffixes, no
  TODO/FIXME. Comments record durable facts only.
- **G9 — Self-gate before reporting.** Run the task's scoped checks (see table in SKILL) to
  green — including ESLint exit-0 on owned files after the LAST edit, run from the package dir
  — before writing the impl report.

## How to read a task

Each task cites its finding in `docs/history/2026-07-21-legacy-parity-audit.md` and its
research anchor in `research/*.md` (exact legacy + current `file:line`). Implementers and
auditors both read those two sources; acceptance criteria here are the contract. "Parity
anchor" names the legacy source the auditor independently opens (G1); where it says
**correctness (no legacy anchor)**, the acceptance target is the new-code behavior, not
legacy — research found the legacy route didn't actually implement the behavior.

## Tasks

### T01 — R1: delete-account step-up lock trips on the 3rd failure  · SENSITIVE (panel)
- **Objective:** Restore the delete-account 24h hard lock to engage on the 3rd consecutive
  step-up failure (currently the 4th — off-by-one).
- **Parity anchor:** `legacy/apps/api/src/legacy/lib/rate-limit.ts:180-193` (`count >= maxAttempts`).
- **Acceptance:**
  1. A new test proves the lock engages on the **3rd** consecutive failed delete-account
     step-up (reserve-before-verify preserved), failing first for the right reason (G2).
  2. **Scope guard (load-bearing):** the fix MUST NOT shift the threshold of any other
     lockout call site. `lockout.ts` is shared — verify (and pin with the existing
     login/2FA/recovery lockout tests staying green **unchanged**) that login (5/900),
     2FA (10/900), recovery (3/3600) still admit exactly their audited counts. Achieve this
     by scoping the change to the delete-account gate (dedicated threshold/param), never a
     global operator flip.
  3. The locked response carries `DELETE_ACCOUNT_LOCKED` (`error-codes.ts:117`) and keeps
     `retryAfterSeconds` in `details` so the existing client (`delete-account-modal.tsx`,
     which keys on `retryAfterSeconds`) still detects lockout. Confirm the client path.
- **Files:** `apps/api/src/slices/identity/domain/{deletion.ts,lockout.ts,keys.ts}`,
  `apps/api/src/slices/identity/routes.ts`, `apps/web/src/components/**/delete-account-modal.tsx`.
- **Checks:** `pnpm test:api` + `pnpm test:web`; typecheck+lint api & web. **Depended on by** T02, T11.

### T02 — R10: restore 1024-element cap on OPAQUE KE arrays
- **Objective:** Cap `ke1`/`ke3` (and equivalent) arrays at 1024 elements to bound parse cost.
- **Parity anchor:** `legacy/apps/api/src/legacy/routes/delete-account.ts:33-41` (1024, delete-account only).
- **Acceptance:**
  1. Delete-account KE schemas capped at 1024 (`.max(1024)`) — parity — with a test rejecting 1025.
  2. **Assumption (approval-gated):** the same 1024 cap is added to login, password-change,
     and 2FA-disable KE schemas as consistent hardening (legacy left these uncapped; this is
     the audit's defect lens, fail-fast doctrine, no legitimate-input downside). Each gets a
     rejection test. *If the founder declines, this task caps delete-account only.*
- **Files:** `apps/api/src/slices/identity/domain/{deletion.ts,login.ts,two-factor-disable.ts,password-change.ts}`.
- **Checks:** `pnpm test:api`; typecheck+lint api. **Depends on** T01 (shares `deletion.ts`).

### T03 — R2: thread width/height/durationMs through history + public-share wire
- **Objective:** Re-serve media `width`/`height`/`durationMs` (columns exist, populated) so
  non-square media renders correctly from history and share links; delete the dead schema.
- **Parity anchor:** report L850-853, L1226-1227 (legacy served all three on both reads).
- **Acceptance:**
  1. `contentItemViewSchema` (`content-item-view.ts:11-18`) and history view
     (`history.ts:20-26`) include the three fields, populated from the existing DB columns.
  2. Web adapters stop hardcoding nulls (`hooks/chat/chat.ts:88-113`,
     `use-shared-message.ts:98-100`); `media-preview.tsx` aspect-ratio tier 2 becomes live again.
  3. Dead `publicShareContentItemSchema` (`message-shares.ts:69-88`, zero refs) removed.
  4. Tests: server serializes the fields; a non-square item yields correct aspect data.
- **Files:** `apps/api/src/slices/conversations/domain/{content-item-view.ts,history.ts}`,
  `packages/shared/src/schemas/api/message-shares.ts`,
  `apps/web/src/lib/api.ts`, `apps/web/src/components/**/media-preview.tsx`,
  `apps/web/src/hooks/chat/chat.ts`, `apps/web/src/hooks/**/use-shared-message.ts`.
- **Checks:** test:api, test:web, test:shared; typecheck+lint api/web/shared.

### T04 — R12: restore link/guest display-name cap to 100
- **Objective:** `SHARE_DISPLAY_NAME_MAX_LENGTH` 200 → 100, documented as the legacy-matched limit.
- **Parity anchor:** report L936/994/1002 (legacy 100).
- **Acceptance:** constant = 100 with a one-line comment marking it the deliberate legacy
  value; all three same-file consumers honor it; a test rejects 101 / accepts 100.
- **Files:** `apps/api/src/slices/conversations/domain/schemas.ts`.
- **Checks:** test:api; typecheck+lint api.

### T05 — R14: restore a removal-specific refusal code  · SENSITIVE (authorization)
- **Objective:** Member-removal refusal stops answering generic `FORBIDDEN`; distinguishable again.
- **Parity anchor:** report L1071-1073, L1086-1087 (legacy used `PRIVILEGE_INSUFFICIENT` for
  both removal and privilege-change).
- **Acceptance:**
  1. Removal refusal (`members.ts:370`) answers `PRIVILEGE_INSUFFICIENT` (matching the sibling
     privilege-change path), with the `friendlyErrorMessage`/`error-messages.ts` copy broadened
     so it reads correctly for BOTH removal and privilege-setting (research recommends broaden-
     copy over a new sibling code: smaller diff, closer to legacy). The overclaiming comment at
     `members.ts:643-648` is reconciled.
  2. Test asserts removal refusal returns the specific code.
- **Files:** `apps/api/src/slices/conversations/domain/members.ts`,
  `packages/shared/src/error-messages.ts`.
- **Checks:** test:api, test:shared; typecheck+lint api/shared. *(error-messages.ts sole owner.)*

### T06 — R15: align WS-upgrade non-member response to 404  · SENSITIVE (authorization)
- **Objective:** WS-upgrade for a non-member returns existence-hiding 404, matching the sibling
  `GET /:conversationId` and legacy — not the current existence-revealing 403.
- **Parity anchor:** report L3463-3464 (legacy 404); sibling pattern `outcomes.ts:49-54`.
- **Acceptance:** the two sites (`routes.ts:366-374,394-400`,
  `userUpgradePrincipal`/`guestUpgradePrincipal`) return 404 mirroring the sibling GET;
  member upgrade still succeeds; a test covers non-member → 404 for both user and guest upgrade.
- **Files:** `apps/api/src/slices/conversations/routes.ts`.
- **Checks:** test:api; typecheck+lint api. **Depended on by** T11 (shares `conversations/routes.ts`).

### T07 — R16: restore `webSearchEnabled` on regenerate
- **Objective:** Regenerating a search-backed answer can stay a search answer.
- **Parity anchor:** `legacy/apps/api/src/legacy/routes/chat.ts:1027`.
- **Acceptance:** `regenerateTurnBodySchema` (`chat/routes.ts:130-175`) gains
  `webSearchEnabled: z.boolean().optional()`; it flows through the already-generic
  `turnDefinitionOrRefusal` (`:556-616`) exactly as the send path does; the omission comment
  (`:1034-1037`) is removed; a test shows a regenerate with the flag produces a search turn
  definition.
- **Files:** `apps/api/src/slices/chat/routes.ts`.
- **Checks:** test:api; typecheck+lint api. **Depended on by** T08 (shares `chat/routes.ts`).

### T08 — R4: user-only ("AI off") messages keep fork support  · correctness (no legacy anchor)
- **Objective:** A user-only message sent while viewing a non-Main fork stays in that fork
  (today it parents onto Main and vanishes after refetch).
- **Anchor:** correctness — mirror the paid-turn fork machinery (`settlement.ts:142-152,257-263,548-553`).
  (Legacy's checked-in `/message` route did not wire `forkId`; do NOT claim legacy parity.)
- **Acceptance:**
  1. `userOnlyMessageSchema` (`shared/.../conversations.ts:156-159`) accepts optional `forkId`;
     the web send path supplies the active fork.
  2. `saveUserOnlyMessage` (`user-message.ts:52-58,151`) resolves the parent via the fork tip
     and advances that fork's tip when `forkId` is present, mirroring paid turns; linear
     behavior preserved when absent.
  3. Test: user-only send under a non-Main fork parents onto the fork tip and survives refetch.
- **Files:** `packages/shared/src/schemas/api/conversations.ts`,
  `apps/api/src/slices/chat/domain/user-message.ts`, `apps/api/src/slices/chat/routes.ts`,
  `apps/web/src/hooks/chat/**` (user-only send path).
- **Checks:** test:api, test:web, test:shared; typecheck+lint api/web/shared.
  **Depends on** T07 (shares `chat/routes.ts`). **Depended on by** T12 (shares `user-message.ts`).

### T09 — R6: fork-tip / epoch-wrap settlement conflicts return `{code}`, not INTERNAL+Sentry  · 2 auditors (settlement-adjacent)
- **Objective:** Ordinary concurrency conflicts (fork tip moved, epoch wrapped) surface as a
  friendly domain outcome; only the genuine CAS-defect still pages Sentry.
- **Parity anchor:** report L4783-4794 (legacy `FORK_TIP_CONFLICT` wire code + "Someone else
  updated this branch. Refresh and try again."); code+message already exist unused for chat.
- **Acceptance:**
  1. Split the conflated `ForkTipConflict` so the **expected** throw sites (`resolveForkTip`
     fork-gone, epoch-wrap — documented never-defect at `wrap-epoch.ts:25-26`, `fork-tip.ts:18`)
     are discriminated in the engine `settle()` catch (`interpreter.ts:1009-1039`) and returned
     as `{outcome:'failed', code: FORK_TIP_CONFLICT}` (epoch-wrap → its existing conflict code)
     via `DomainError.wireCode`, **emitting no Sentry event**; the genuine-defect
     `advanceForkTip` CAS-zero-row site (`fork-tip.ts:58-59`) still routes to
     `workflowSettlementDefect`.
  2. No expected-conflict path produces `code: INTERNAL`.
  3. Tests: an expected conflict → `{code: FORK_TIP_CONFLICT}` + no Sentry; the CAS-defect → defect path.
- **Files:** `apps/api/src/slices/chat/domain/settlement.ts`,
  `apps/api/src/slices/workflows/engine/{interpreter.ts,failures.ts}`,
  `apps/api/src/slices/conversations/domain/{fork-tip.ts,wrap-epoch.ts}`.
- **Checks:** test:api; typecheck+lint api.
  **Depended on by** T10 (shares `settlement.ts`+`interpreter.ts`).

### T10 — R18: Smart Model chip reflects the pipeline running, not the charge  · 2 auditors (billing-adjacent)
- **Objective:** Restore legacy chip semantics — an answer is badged "Smart Model" whenever the
  Smart pipeline ran, even if the classifier failed and fell back — and graceful-degrade the
  thrown-classifier path instead of Sentry-failing the whole node.
- **Parity anchor:** report L1528, L1543, L1678, L2103; `legacy/.../smart-model-stage.ts:115-131`,
  `stream-pipeline.ts:1389-1400` (catches throw, marks `stagesRun` regardless of billing).
- **Acceptance:**
  1. The chip is anchored to a "Smart pipeline ran" signal (stagesRun-equivalent), not to a
     classifier **charge** (`settlement.ts:472,484-489`); a classifier failure (typed or thrown)
     still badges the fallback answer.
  2. A thrown, unclassified classifier error degrades gracefully (fallback answer persists,
     badged) instead of failing the node as a Sentry defect
     (`model-call-execution.ts:250-256` → `interpreter.ts:576-604`); widen the catch boundary
     as narrowly as possible (auditor confirms no genuine defect is now swallowed).
  3. Update the test that currently pins charge-anchored chip behavior; add tests for
     classifier-throw-still-badged and graceful-degrade.
- **Files:** `apps/api/src/slices/chat/domain/{settlement.ts,smart-model-execution.ts}`,
  `apps/api/src/slices/workflows/engine/{model-call-execution.ts,interpreter.ts}`.
- **Checks:** test:api; typecheck+lint api. **Depends on** T09. **Depended on by** T15 (shares `model-call-execution.ts`).

### T11 — R19: route all slice error responders through `domainWireCode()`
- **Objective:** Stop discarding `DomainError.wireCode`; idempotency conflicts surface as
  `IDEMPOTENCY_BODY_MISMATCH`/`REQUEST_IN_PROGRESS`, not generic `CONFLICT`.
- **Anchor:** `domainWireCode()` at `lib/errors/domain-error.ts:60-61`; codes+messages exist.
- **Acceptance:**
  1. The 8 direct-mapping sites (account/identity/billing/models/announcements/admin/
     newsletter/platform-dev `routes.ts`) call `domainWireCode(error)` (which prefers
     `error.wireCode`) instead of indexing `DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code]`
     directly; converge the conversations/feedback hand-rolled third pattern onto the same
     helper (G5 — one implementation).
  2. Test proving a `byKey` body-mismatch on billing → `IDEMPOTENCY_BODY_MISMATCH` (not `CONFLICT`).
  3. No behavior change where `wireCode` is unset (the 6 latent sites keep current output).
- **Files:** the 8 slice `routes.ts` (+ conversations/feedback responders) and, if a shared
  responder is introduced, `apps/api/src/lib/errors/**`.
- **Checks:** test:api; typecheck+lint api. **Depends on** T01 (identity/routes.ts), T06 (conversations/routes.ts).

### T12 — R20: hoist one shared 23505 unique-violation helper  · 2 auditors (touches auth+admin adapters)
- **Objective:** Replace 4 drifted copies with one shared helper (depth cap + constraint-name
  matching + message fallback — the union of all four behaviors).
- **Parity anchor:** `legacy/apps/api/src/legacy/lib/unique-violation.ts:64-79`.
- **Acceptance:**
  1. New `apps/api/src/lib/errors/unique-violation.ts` exports one helper carrying all three
     behaviors; the four call sites (`conversations/adapters/stores.ts:38-51`,
     `identity/adapters/stores.ts:46-56`, `chat/domain/user-message.ts:78-88`,
     `admin/adapters/stores.ts:10-25`) import it; the inline copies are deleted.
  2. No caller loses a feature it relied on (identity regains message fallback; chat regains
     constraint-name matching).
  3. Tests cover: matched constraint, unmatched (fallback), depth cap.
- **Files:** new `apps/api/src/lib/errors/unique-violation.ts`;
  `apps/api/src/slices/{conversations/adapters,identity/adapters,admin/adapters}/stores.ts`;
  `apps/api/src/slices/chat/domain/user-message.ts`.
- **Checks:** test:api; typecheck+lint api; `jscpd` on the four sites (must drop). **Depends on** T08 (shares `user-message.ts`).

### T13 — R21: prove content_items constraints against real Postgres
- **Objective:** Real-DB rejection tests for the `content_items` type-consistency CHECK and the
  partial-unique storage-key index — not just a name assertion.
- **Parity anchor:** report L4141-4149 (legacy integration-tested actual DB rejection).
- **Acceptance:** new cases in the `schema.integration.test.ts` `expectDbError` harness
  (mirroring the sibling examples) assert the DB rejects a CHECK-violating row and a
  partial-unique collision; use the **current** constraint name `content_items_storage_key_unique`.
- **Files:** `packages/db/src/**/schema.integration.test.ts` (+ `shape-tables.test.ts` if the
  name assertion moves).
- **Checks:** `pnpm test:db`; typecheck+lint db.

### T14 — R3: reinstate media-GC runtime budget + partial evidence  · 2 auditors (data deletion)
- **Objective:** GC bails at a soft time budget and records a partial pass, so it can't be
  CPU-killed mid-sweep making zero forward progress.
- **Parity anchor:** `legacy/apps/api/src/legacy/services/gc/r2-gc.ts:27,139-149`
  (`MAX_GC_RUNTIME_MS = 25_000`, bail before each page, `partialCompletion` always in evidence).
- **Acceptance:**
  1. `runMediaGc`/`sweep()` (`gc.ts:113-138`) checks elapsed time via the injected
     `deps.now()` before each page fetch and bails at 25s with `partialCompletion: true`.
  2. `MediaGcReport` (`gc.ts:56-61`) gains `durationMs` and `partialCompletion`; evidence is
     recorded on partial passes too (`gc.ts:104-110`), not only complete ones.
  3. Tests with a mock clock: a sweep that exceeds budget bails, reports partial, records evidence.
- **Files:** `apps/api/src/slices/media/domain/gc.ts` (+ `MediaGcReport` type home if separate).
- **Checks:** test:api; typecheck+lint api.

### T15 — R17: wire per-model discrete video-duration pre-flight  · 2 auditors (billing-adjacent)
- **Objective:** Reject out-of-set video durations at pre-flight (`UNSUPPORTED_DURATION`) via the
  ParamSpec compiler, instead of failing at the provider.
- **Parity anchor:** report L1701 (legacy `400 UNSUPPORTED_DURATION` per model).
- **Acceptance:**
  1. Reconcile the key mismatch first: `normalize.ts:496` keys the video ParamSpec as
     `'duration'` while consumers use `'durationSeconds'` — align so `compileParamSpec`'s
     `strictObject` accepts valid video calls (auditor confirms image/language ParamSpecs
     unaffected).
  2. `compileWireParams` (`wire-params.ts:26-46`) is invoked pre-flight at
     `model-call-execution.ts:242`; its validation error carries the `UNSUPPORTED_DURATION`
     wireCode via `DomainError.wireCode`.
  3. Tests: an out-of-set duration for a model with a discrete set → `UNSUPPORTED_DURATION`
     pre-flight; an in-set duration passes; a valid video call still succeeds end-to-end.
- **Files:** `apps/api/src/slices/models/domain/{wire-params.ts,normalize.ts}`, the
  video-adapter file, `apps/api/src/slices/workflows/engine/model-call-execution.ts`.
- **Checks:** test:api; typecheck+lint api. **Depends on** T10 (shares `model-call-execution.ts`).

### T16 — R5: seed conversations get real titles
- **Objective:** Server-seeded conversations get real titles instead of an empty string.
- **Parity anchor:** report L4598, L4645, L4663, L4667-4680 (`Seed Conversation ${n}`,
  `${persona} Conversation ${n}`, `Screenshot: ${name}`).
- **Acceptance:** `seedConversationShell` (`factories.ts:154-181`, line 176) accepts a `title`
  param threaded to `encryptTextForEpoch`; the four factory param interfaces expose it; all
  callers pass the legacy title values; a test asserts a seeded conversation carries a non-empty title.
- **Files:** `apps/api/src/platform/dev/factories.ts`, `scripts/seed.ts` (callers).
- **Checks:** test:api; typecheck+lint api. **Depended on by** T19 (shares `scripts/seed.ts`).

### T17 — R7: repoint the dev-stack idle heartbeat + fix the APK log filter
- **Objective:** Live API traffic ticks the idle heartbeat again (so the local stack isn't
  reaped under an active developer), and the still-used APK log extractor filters correctly.
- **Anchor:** structured request-log now at `middleware/request-log.ts:38-43` /
  `console-adapter.ts:37`; consumers `heartbeat-source.ts:1-20`, `extract-mobile-api-log.ts`
  (still called from `mobile-test.ts:16` — NOT dead).
- **Acceptance:**
  1. `heartbeat-source.ts` matches a stable field the structured JSON request-log actually
     emits (not a re-introduced `[req]` text line — that would violate the typed-logger doctrine).
  2. `extract-mobile-api-log.ts`'s filter is updated to the structured format so it stops
     keeping every line.
  3. Test/380 or a focused unit test proves the heartbeat matcher fires on a real emitted line.
- **Files:** `scripts/lib/heartbeat-source.ts`, `scripts/lib/extract-mobile-api-log.ts`
  (+ `scripts/wrangler-dev.ts` only if the wiring requires it).
- **Checks:** relevant `pnpm test:*` for scripts (or the scripts test suite); typecheck+lint.

### T18 — R22: restore dev/mock/test fidelity (5 items)
- **Objective:** Restore the five mock/cassette/test-fidelity behaviors, with dev delays gated
  exactly as legacy gated them.
- **Parity anchors:** legacy `services/ai/index.ts` (`isDevServer` gate, 60/3000/1000ms,
  `??`-overridable); legacy `media-assertions.ts` (magic-byte + size bounds).
- **Acceptance:**
  1. **(a) Mock delays** — add `textDelayMs`/`mediaDelayMs` to `mockDirectivesSchema`; default
     them to 60/3000/1000ms (text/media/classifier) **only when `isDevServer`** (the existing
     `packages/shared/src/env.ts` flag, via `envUtils` — G3; excludes E2E/vitest), per-request
     `??`-overridable; wire into the `mock-provider.ts` generators. Test both branches.
  2. **(b) recordedFromSha** — stamp it on newly recorded cassettes (`recording-fetch.ts:139-202`);
     confirm `docs/CI-CASSETTES.md:173` matches (doc note for Phase-4 if wording shifts).
  3. **(c) grapheme chunking + fence** — restore `Intl.Segmenter` 24-grapheme chunking and the
     trailing JSON fence in the mock echo (`mock-provider.ts:60,385,416-421`).
  4. **(d) aspect-aware mock media** — mock media honors `aspectRatio` instead of fixed 400×300
     PNG / fixed MP4; **update the pinning spec** `e2e/chat/image-generation.spec.ts:49,54`
     (currently asserts 400×300) in the same task.
  5. **(e) magic-byte + size bounds** — `image-adapter.integration.test.ts:53` /
     `video-adapter.integration.test.ts:55` assert magic bytes + size bounds
     (PNG/JPEG/WebP `{32, 10_000_000}`, MP4/WebM `{16, 50_000_000}`), porting legacy assertions.
- **Files:** `apps/api/src/**/mock-provider.ts`, the `mockDirectivesSchema` file,
  `apps/api/src/**/recording-fetch.ts`,
  `apps/api/src/**/{image-adapter,video-adapter}.integration.test.ts`,
  `e2e/chat/image-generation.spec.ts`. (Read-only reference: `packages/shared/src/env.ts`.)
- **Checks:** test:api; typecheck+lint api. (E2E spec change validated in Phase-4 E2E run, not here.)

### T19 — R23: restore the bulk sample-data generator + the missing rate-limit reset key
- **Objective:** Restore list-scale dev seed data wired to `hasSampleData`, and clear the
  share-create limiter in the dev reset.
- **Parity anchor:** legacy `createPersonaSampleData` (alice: 150 conversations); insertion at
  `scripts/seed.ts:440-485`.
- **Acceptance:**
  1. A bulk sample-data generator is restored and invoked for personas whose `hasSampleData`
     is set (`seed-personas.ts:46,56,109,139`); the field is now read, not dead.
  2. `DELETE /dev/usage-rate-limits` (`redis-resets.ts:85-93`) also clears
     `share:create:user:ratelimit:*` (the key template from the registry), matching the
     E2E helper's claim (`e2e/helpers/auth.ts:174-179`).
  3. Tests: the reset covers the share-create key; the generator produces the expected scale.
- **Files:** `scripts/seed.ts`, `scripts/lib/seed-personas.ts`,
  `apps/api/src/platform/dev/redis-resets.ts`.
- **Checks:** test:api (+ scripts suite); typecheck+lint api. **Depends on** T16 (shares `scripts/seed.ts`).

## Dependency graph

Edges are "must finish before" (shared-file exclusivity or output consumption):

```
T01 → T02            (deletion.ts)
T01 → T11            (identity/routes.ts)
T06 → T11            (conversations/routes.ts)
T07 → T08 → T12      (chat/routes.ts ; user-message.ts)
T09 → T10 → T15      (settlement.ts+interpreter.ts ; model-call-execution.ts)
T16 → T19            (scripts/seed.ts)
```

**No-dependency, ready at start:** T01, T03, T04, T05, T06, T07, T09, T13, T14, T16, T18.
**Unlocked later:** T02 (after T01), T08 (after T07), T10 (after T09), T11 (after T01+T06),
T12 (after T08), T15 (after T10), T19 (after T16).

Concurrency cap: **≤4 implementers in flight** (shared local DB/test contention; echoes the
stack-saturation lesson). Dispatch ready tasks up to the cap; refill on completion.

## Amendments (post-approval)

### T20 — R16 (client half): web regenerate builder sends `webSearchEnabled`
- **Why:** T07's audit found the server now honors `webSearchEnabled` on regenerate, but the
  web regenerate request builder (`apps/web/src/hooks/chat/use-chat-stream.ts:603-629`) never
  sends it, so R16's user-facing intent is inert. T07 was correctly scoped server-only.
- **Objective:** The web regenerate request includes `webSearchEnabled` (mirroring the send
  path), so a regenerated search-backed answer stays a search answer end-to-end.
- **Acceptance:** the regenerate builder forwards the active `webSearchEnabled` state exactly as
  the initial-send builder does; a test (or existing hook test) proves the field is present on a
  regenerate request when web search is on. Surgical — regenerate builder only.
- **Files:** `apps/web/src/hooks/chat/use-chat-stream.ts` (regenerate builder region).
- **Checks:** `pnpm test:web`; typecheck+lint web.
- **Depends on** T08 (shares `apps/web/src/hooks/chat/**`; sequence to avoid file overlap).

### T18 scope expansion (from T18 impl-report-1 concerns)
- **Files added to T18 ownership:** `apps/api/src/**/resolve-model-provider.ts` and
  `apps/api/src/**/conversation-runtime.ts` (the composition seam that must thread
  `isDevServer` into `createMockModelProvider`); the new shared
  `apps/api/src/**/media-assertions.ts` (+ its test) required by One-Implementation-Shared;
  and the out-of-bounds echo-consumer test `apps/api/src/slices/chat/domain/regenerate.integration.test.ts`.
- **Clarified acceptance:** R22.a is complete only when the 60/3000/1000ms default is applied
  AT RUNTIME under `isDevServer` (via `envUtils`) — not merely accepted as a per-request
  override — with a test at the composition seam proving default-on under dev-server and
  default-off under the E2E/vitest branch. The fence change (R22.c) must leave every
  mock-echo consumer green (update `regenerate.integration.test.ts` and any other exact-echo
  consumer). Video mock aspect-scaling is NOT required (mock MP4 ftyp carries no dimensions —
  accepted documented deviation); image aspect-scaling IS.
- **Phase-4 note:** full-coverage `test:api` OOM's (exit 137) in this sandbox — self-gate and
  close use scoped, coverage-free runs + per-file coverage as evidence.

### T17 scope expansion (from T17 impl-report-1 concerns)
- **Files added to T17 ownership:** `scripts/mobile-test.ts` and `scripts/mobile-test.test.ts`
  — the APK extractor's caller + its test, which consume the log-line contract T17 changed.
  (Research named `mobile-test.ts` a consumer; the original Files list omitted it — plan gap.)
- **Clarified acceptance:** the request-log-format contract change must leave `mobile-test.test.ts`
  green (update its `[req]`/version fixtures to the structured format), and the stale
  `X-App-Version` docstrings (`mobile-test.ts:419,435`) corrected. Because the structured
  request-log carries no app-version field, version-based filtering is unexpressible: resolve the
  now-vestigial `mobileVersion` param — remove it and update callers if it is genuinely dead
  (preferred, per durable-naming), or document precisely why it must stay. No re-introduction of a
  legacy `[req]` text line or an app-version log field (that would need apps/api middleware +
  SafeLogFields, out of scope).
- **Process lesson (for close doc-proposals):** a task that changes a cross-cutting contract (log
  format, mock-echo format) must own ALL its consumers in its Files list. This bit T17 and T18.

### T05 file-ownership correction (from T05 NEEDS_CONTEXT)
- The `friendlyErrorMessage` copy table is in `packages/shared/src/error-codes.ts` (the
  `ERROR_MESSAGES` map, ~:197) — NOT `error-messages.ts` (branded-type only, unread by
  `friendlyErrorMessage`). **T05's Files** are therefore
  `apps/api/src/slices/conversations/domain/members.ts` +
  `packages/shared/src/error-codes.ts` (broaden the `PRIVILEGE_INSUFFICIENT` copy there).
  `error-codes.ts` has no other active editor this run.
- **G4 / doc correction (Phase-4 doc-proposal):** Global Constraint G4 above and CODE-RULES.md's
  "Error Responses" section both say user-facing copy lives in `error-messages.ts`; it actually
  lives in the `ERROR_MESSAGES`/`friendlyErrorMessage` table in `error-codes.ts`. This mis-briefs
  every error-contract task; correct the doc.

### T05 scope expansion (stale route assertion, found by T10 fixer)
- **File added to T05 ownership:** `apps/api/src/slices/conversations/routes.integration.test.ts`
  — a route-level test (`"refuses a removal without a strictly higher privilege"`) still asserts
  `FORBIDDEN` for the member-removal refusal T05 changed to `PRIVILEGE_INSUFFICIENT`. T05's
  auditors couldn't run integration tests (stack down) and its original Files list omitted this
  route test — same contract-change-must-own-its-consumers gap as T17/T18.
- **Fix:** update every stale removal-refusal assertion in that file from `FORBIDDEN` to
  `PRIVILEGE_INSUFFICIENT` to match the now-correct behavior (search the file; there may be more
  than one). If the local stack is up, run the suite to green; if not, update by inspection
  (mapping is verified) and Phase-4 confirms end-to-end.

### T15 scope expansion + rulings (from T15 NEEDS_CONTEXT)
- **Files added to T15 ownership:** `apps/api/src/slices/models/domain/list-models.ts` +
  `apps/api/src/slices/models/domain/list-models.test.ts` (consumers of the ParamSpec duration
  key). (`normalize.test.ts` is colocated with the owned `normalize.ts` and already in bounds.)
- **RULING 1 (key reconcile):** rename the video-duration ParamSpec key `duration`→`durationSeconds`
  consistently — at `normalize.ts:496` (produce), `list-models.ts:138` (`enumIntegers(descriptor,
  'durationSeconds')`), and the `duration:`-keyed ParamSpec fixtures in `list-models.test.ts`
  (:64,228,241) and `normalize.test.ts`. The DERIVED client field `supportedVideoDurationsSeconds`
  keeps its name, so the web `modality-config-panel.tsx` reader is unaffected (out of scope, do not
  edit). Verify image/language ParamSpecs are untouched by the rename.
- **RULING 2 (wiring site):** wire `compileWireParams` pre-flight ONLY on the VIDEO path — the
  `runModelCall`/modelCall-node-entry (or a `modality==='video'` guard), NOT the shared
  `streamModelCall` at line 242 — so language/image/classifier calls (which carry affordability
  caps like `maxOutputTokens` not in their ParamSpec) are never strictObject-rejected. Criterion (d)
  MUST hold. Use only in-bounds sites (model-call-execution.ts / the video-adapter).
- **RULING 3 (escape hatch, legacy parity):** preserve legacy's "no declared durations ⇒ allow
  through" — enforce `UNSUPPORTED_DURATION` ONLY for models that declare a discrete duration set; a
  model declaring none accepts any duration (do not strictObject-reject its `durationSeconds`).

### T15 round-2 rulings (from T15 NEEDS_CONTEXT round 2)
- **RULING A (wiring mechanism):** `compileWireParams` (models/domain) is unreachable from the
  engine node (engine-node-purity valueImport lint) and the adapter (adapter boundary lint). Use
  **Path 1**: do the video-duration pre-flight inside `runModelCall` via the node-reachable
  `@hushbox/shared` `compileParamSpec` primitive → `err({reason: UNSUPPORTED_DURATION})` (stamp the
  wireCode at this err site). This is a targeted duration check using the shared compiler primitive
  — NOT a re-implementation, so acceptable under G5. Leave `wire-params.ts`/`compileWireParams`
  UNTOUCHED (pre-existing dead code; surgical — do not remove it here; flagged for a Phase-4
  dead-code note). Per-model enforcement (R17's goal) is restored via `compileParamSpec`.
- **RULING B (string-vs-number):** the duration enum VALUES must be numeric integers so a numeric
  request `durationSeconds` matches strict `includes` — convert them in `normalize.ts` (mirrors
  `list-models`' `enumIntegers`; test fixtures are already numeric). Without this a valid in-set
  duration is wrongly rejected.

### T03 scope expansion + rulings (from T03 NEEDS_CONTEXT)
- **Files added to T03 ownership:** `apps/api/src/slices/conversations/ports/stores.ts` (add
  `width`/`height`/`durationMs` to `ContentItemRow`), `apps/api/src/slices/conversations/adapters/stores.ts`
  (add the 3 columns to the SINGLE `contentItemsByMessage` SELECT projection — the "one place" that
  feeds BOTH the history read and the share read), and
  `apps/api/src/slices/conversations/adapters/presign-reads.integration.test.ts` if the store change
  needs test updates. All are free (every other task complete). Additive change — extra row fields
  don't break existing consumers.
- **RULING (blocker 2 — dead cluster):** delete the ENTIRE dead public-share cluster in
  `packages/shared/src/schemas/api/message-shares.ts` (`:69-101`: `publicShareContentItemSchema` +
  `publicShareResponseSchema` + `PublicShareResponse`/`PublicShareContentItem` types), not just
  `:69-88` — grep confirms zero external references to any of them.

### T21 — batched cleanup (4 validated Minors from mid-run audits)
One fixer, four small validated findings (batched to avoid per-finding context rebuilds). Each is a
real audit finding, not a new change.
1. **Stale comment (from T01 audits, triple-confirmed):** `packages/shared/src/error-codes.ts:111-113`
   (+ mirror in `error-codes.test.ts:208-210`) still groups `DELETE_ACCOUNT_LOCKED` as "never on the
   wire"; T01 now emits it as a 403. Correct the comment to reflect it is wire-emitted.
2. **Named constant (from T02 audit):** replace the inline `.max(1024)` at the 8 KE-array sites
   (`identity/domain/{deletion,login,two-factor-disable,password-change}.ts`) with one named
   `MAX_KE_ARRAY_LENGTH = 1024` constant at the narrowest scope covering all four files (identity
   domain — NOT packages/shared; only identity uses it). Behavior identical.
3. **Admin test (from T11 audit):** add a route-level test asserting admin's manual `claimKeyRow`
   path returns `REQUEST_IN_PROGRESS` (the billing `byKey` path is already tested; admin's is
   correct-by-construction but untested).
4. **Branch coverage (from T15 audit):** `workflows/nodes/model-call-execution.ts:203` — the
   `spec.values === undefined` defensive sub-branch is never exercised. If reachable given
   `ParamSpec.values`'s type, add a test; if the type guarantees `values` present for enums (so the
   sub-branch is dead), simplify the guard to remove it (preferred over an ignore comment).
- **Files:** `packages/shared/src/error-codes.ts`(+test); `apps/api/src/slices/identity/domain/{deletion,login,two-factor-disable,password-change}.ts` + a constant home; the admin route-test file; `apps/api/src/slices/workflows/nodes/model-call-execution.ts`(+test).
- **Checks:** test:api + test:shared; typecheck+lint api & shared.

## Phase-4 follow-up tasks (founder-ruled at close)

- **T22 — R8 (missed in planning): DO WebSocket close-handshake.** Restore legacy close handling —
  `webSocketClose` echoes the peer's code/reason; `webSocketError` closes `1011`. Founder leaning
  advance-compat-date; PENDING an evidence check (does `web_socket_auto_reply_to_close` echo peer
  code/reason like legacy? can it be a targeted `compatibility_flag` vs a full date bump + its blast
  radius?). Files depend on the chosen mechanism: manual echo → `packages/realtime/src/{conversation-room.ts,room-core.ts}`;
  flag/date → `apps/api/wrangler.toml` (+ verify no manual echo needed). Anchor: report L165 (R8).
- **T23 — R14 residual (ruled: extend to full parity).** Change the non-admin-caller removal rung
  (`conversations/domain/members.ts:287-289`) AND, for internal consistency, the sibling
  privilege-change non-admin rung, from `FORBIDDEN` to `PRIVILEGE_INSUFFICIENT` (reuse the code
  T05 already broadened). Update the corresponding `members.test.ts` + `routes.integration.test.ts`
  assertions. Files: `conversations/domain/members.ts`(+test), `conversations/routes.integration.test.ts`.
- **T24 — T17 lockstep (ruled: hoist a shared constant).** Extract the `'request completed'` log
  `msg` literal to ONE shared constant imported by both the emitter (`apps/api/src/middleware/request-log.ts`)
  and the dev-stack heartbeat matcher (`scripts/lib/heartbeat-source.ts`), working within the typed
  logger's compile-time-literal `msg` constraint (a `const x = '...' as const` the logger accepts).
  Remove the "keep in lockstep" comment. Files: `request-log.ts`, `heartbeat-source.ts`, the shared
  constant home (+ `SafeLogFields`/logger types if the constraint requires).
- **T25 — GC budget (ruled: shrink).** Lower `MEDIA_GC_MAX_RUNTIME_MS` from 25s to a value leaving
  headroom for the 3 co-running cron auditors in the shared 30s `cpu_ms` isolate (propose ~15s;
  document it as a deliberate shared-isolate margin, no longer strict legacy parity). Files:
  `apps/api/src/slices/media/domain/gc.ts`(+test).
- **Doc changes (founder ruling pending on the diffs):** CODE-RULES.md:109 (`error-messages.ts`→
  `error-codes.ts`); apps/api/CLAUDE.md:47-48 (`domainWireCode`). CI-CASSETTES.md = no change.

## Related E2E

Agreed now so the close phase is mechanical (Phase-4 runs these, not the full suite):
- **`e2e/chat/image-generation.spec.ts`** — modified by T18(d) (mock media dims). Must pass with
  the updated assertions.
- **Delete-account flow E2E** (if one exists under `e2e/`) — exercised by T01's lockout change;
  the implementer/close phase confirms the lockout step still passes. If none exists, no new
  E2E is warranted (unit/integration cover the threshold; CODE-RULES doesn't force one for a
  pure threshold fix).
- **Share/media render E2E** — T03 changes the share wire shape; if an existing share-view spec
  asserts media rendering, it is in scope for the Phase-4 run.
- No other task adds a user-facing flow beyond existing integration coverage; per CODE-RULES,
  no new standalone E2E specs are created for the remaining tasks. Final E2E set is confirmed at
  close.

