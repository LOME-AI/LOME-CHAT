# Plan — e2e-green 2026-07-20

## Global Constraints

- Every fix meets repo quality bar: TDD at closest layer, CODE-RULES, determinism pillars.
- Long-term fixes only; forbidden shortcuts per skill (no skips, no timeout raises, no assertion weakening).
- Fix the class: each root cause gets an enforcement rung where feasible.
- No git writes.
- **E2E proofs are CENTRALIZED (updated).** Per-task e2e proofs created a ~28-min serialized lock backlog. Implementers must NOT run per-task e2e; prove the fix at the CLOSEST unit/integration layer (which needs no lock) and mark the e2e line "deferred to orchestrator consolidated run". The orchestrator runs the full `pnpm e2e` suite centrally. vitest (`pnpm test:*`, one-shot `pnpm test:watch <path>`) must NOT be wrapped in the e2e lock — the lock is only for Playwright `pnpm e2e*`.
- **E2E run lock (orchestrator + any unavoidable e2e only):** if an e2e run is truly needed, wrap it: `flock -w 7200 /tmp/claude-1000/-workspace-popper-mobile--superset-projects-HushBox/e2e-run.lock -c '<command>'`. Never kill processes you did not start.

## Tasks

### Task-01 — account-deletion spec contract corrections (test-side)

- **Objective:** Fix e2e/account-deletion.spec.ts to assert the real API contract and real error copy; determine whether the double-click test exposes an app race.
- **Diagnosis (validated):** (A) spec:~151 expects HTTP 204 from the deletion `/finish` endpoint; the app has always returned 200 `{success:true}` (pinned by slice integration tests) — app is authoritative. (B) spec:~479 asserts a stale hardcoded invalid-TOTP copy literal that drifted from `packages/shared` error messages. (C) the double-click test fails on a redirect race (/welcome vs 401→/login) that may be downstream of A.
- **Acceptance criteria:**
  1. Spec asserts 200 + response-shape `{success:true}` for `/finish`; expected status/shape is pinned against the typed API contract (typed client / AppType-derived), not a bare magic literal, where feasible.
  2. Invalid-TOTP copy is asserted via import from `@hushbox/shared` (error-messages / friendlyErrorMessage), never a duplicated string literal. Enforcement rung: sweep this spec for any other hardcoded user-facing copy literals that exist in shared error messages and convert them.
  3. Double-click test re-examined after 1: if still failing, produce evidence-backed verdict (app race vs test defect) in the report — do not paper over; fix only if clearly test-side.
  4. No forbidden shortcuts (no skips, no timeout raises, no assertion weakening — replacing a wrong expected value with the app's authoritative contract is a correction, not weakening).
  5. Proof: `pnpm e2e e2e/account-deletion.spec.ts` fully green (all 5 tests).
- **File ownership:** e2e/account-deletion.spec.ts (+ any new shared-copy import only). No app code.
- **Scoped checks:** eslint exit-0 on edited files (run from the owning package dir), `pnpm typecheck` for the e2e workspace, spec run above.
- **Sensitive?** Yes-adjacent (account deletion flow) — but changes are test-side only; 1 auditor + confirm any Critical.

### Task-02 — demo spec drives the /welcome iframe (test-side)

- **Objective:** Update e2e/demo.spec.ts for the deliberate guard (commit a4b4483d) that redirects top-level /demo → /welcome; the demo now lives inside an iframe on /welcome.
- **Diagnosis (validated):** all 5 demo failures are the stale spec navigating to /demo top-level. App behavior is correct and deliberate — not an intent conflict.
- **Acceptance criteria:**
  1. Spec navigates to /welcome and drives the demo through `frameLocator` (or the repo's established pattern for that iframe), preserving every existing assertion's intent — zero assertions weakened or deleted.
  2. If any assertion is genuinely unreachable through the iframe, report it as a finding instead of weakening it.
  3. Proof: `pnpm e2e e2e/demo.spec.ts` fully green (all 5 tests).
- **File ownership:** e2e/demo.spec.ts only.
- **Scoped checks:** eslint exit-0 on edited files (from owning package dir), e2e workspace typecheck, spec run above.
- **Sensitive?** No — 1 auditor.

### Task-03 — device-key E2E variant resolved at build time (app/harness)

- **Objective:** Eliminate the runtime `env.isE2E` dynamic `import('./device-key-store.e2e.js')` on the auth-bootstrap path, which navigation cancels on guest share routes → uncaught import rejection → CatchBoundary blank page (3 sharing failures).
- **Diagnosis:** research/sharing.md §RC1 (evidence: 15 aborted chunk fetches; `TypeError: Importing a module script failed`; device-key-store.ts:74-76,99-101,130-132).
- **Acceptance criteria:**
  1. The device-key-store implementation variant is selected at build time (Vite define/alias or equivalent) so the E2E build statically includes the `.e2e` variant in the entry chunk and the production build contains zero `.e2e` code (existing arch isolation rule must keep passing — run `pnpm arch:check`).
  2. No runtime dynamic `import()` remains on the auth-bootstrap path for device-key code.
  3. TDD at closest layer: a failing test first (unit/arch) pinning that loading the store under E2E mode requires no runtime chunk fetch / that the prod bundle excludes `.e2e` — then implement.
  4. Enforcement rung: lint or arch rule forbidding dynamic `import()` of `*.e2e` modules on the sync auth path (or a bundle-level assertion), so the class dies.
  5. Proof: `pnpm e2e e2e/sharing/link-guest-chat.spec.ts e2e/sharing/link-guest-access.spec.ts` green, plus the two shared-content tests that failed on RC1 if separable (full shared-content run acceptable; RC2/RC3 failures in that spec are out of scope — report them, don't chase).
- **File ownership:** apps/web/src/lib/device-key-store.ts, device-key-store.e2e.ts, apps/web vite config, packages/config arch/lint rule files for the new rung. No spec edits.
- **Scoped checks:** `pnpm test:web`, `turbo typecheck lint --filter=@hushbox/web`, `pnpm arch:check`, jscpd on changed paths.
- **Sensitive?** Yes (auth/crypto-adjacent harness) — 2 independent auditors.

### Task-04 — mint shareSecret once per logical mutation (app, crypto)

- **Objective:** Fix idempotent-replay mismatch: `useMessageShare.mutationFn` re-mints a random `shareSecret` per invocation while the Idempotency-Key stays stable, so a retry's URL fragment can't open the server-stored wrap (2 sharing failures). Same latent shape in `useCreateLink`/`useChangeLinkPrivilege`.
- **Diagnosis:** research/sharing.md §RC3 (use-message-share.ts:63,82; idempotent-mutation.ts:21-27).
- **Acceptance criteria:**
  1. Client-generated key material (shareSecret; link key material in use-conversation-links.ts) is minted exactly once per logical mutation and reused across every retry/replay — same discipline as the idempotency key (WeakMap-on-variables or onMutate-threaded).
  2. TDD: failing unit test first reproducing the mismatch (invoke mutationFn twice with same variables → today secrets differ / replayed wrap doesn't open under returned URL secret), then green: retry round-trip yields a fragment secret that opens the stored wrap.
  3. Enforcement rung: contract test covering both hooks' round-trip under a forced retry; if a lint/arch rule against re-randomizing key material inside idempotent mutationFns is feasible, add it — if not feasible, say so in the report.
  4. Proof: `pnpm e2e e2e/sharing/shared-content.spec.ts` — the two RC3 tests (shared-message-link-shows-decrypted-content, shared-image-message-guest-sees-the-rendered-image) green; RC1/RC2 failures in the same spec are other tasks' scope — report, don't chase.
- **File ownership:** apps/web/src/hooks/chat/use-message-share.ts, apps/web/src/hooks/**/use-conversation-links.ts, their test files. Do NOT touch apps/web/src/lib/device-key-store* (Task-03 owns it) or idempotent-mutation.ts key derivation.
- **Scoped checks:** `pnpm test:web`, `turbo typecheck lint --filter=@hushbox/web`, jscpd on changed paths.
- **Sensitive?** Yes (crypto/sharing) — 2 independent auditors.

### Task-05 — Helcim mock must drive the app's tokenization contract (harness/mock)

- **Objective:** Unfreeze 5 billing tests: the mock sets hidden-input `.value`s which produce no MutationRecord, so the app's `#helcimResults` MutationObserver never fires and the charge POST never dispatches.
- **Diagnosis:** research/billing.md §RC-A (helcim-mock.ts:26-31,40-73; payment-form.tsx:597-631,685-703).
- **Acceptance criteria:**
  1. Tokenization completion is signaled through a contract both the real Helcim.js path and the mock genuinely satisfy. Preferred: a typed tokenization-complete signal emitted by both loader paths, replacing reliance on incidental DOM mutation; acceptable: the mock performs the same structural DOM mutation the real script performs. Choose after reading the real-loader path; justify in the report.
  2. TDD: failing test first (web unit/component test: mock tokenization → form reaches terminal state and dispatches the charge mutation), then green. No timeout raises anywhere.
  3. Enforcement rung: that test IS the parity/readiness contract test — it must live in the web test suite (not e2e) so drift fails at merge.
  4. Proof: `pnpm e2e e2e/billing/billing.spec.ts` — the 5 RC-A tests green; the unauthenticated-token test is Task-06's scope; report any residue.
- **File ownership:** apps/web/src/lib/helcim-mock.ts, apps/web/src/components/billing/payment-form.tsx (+ their tests, + the loader in apps/web/src/lib if needed). No e2e spec edits.
- **Scoped checks:** `pnpm test:web`, `turbo typecheck lint --filter=@hushbox/web`, jscpd on changed paths.
- **Sensitive?** Yes (payments) — 2 independent auditors.

### Task-06 — E2E mutating requests auto-attach Idempotency-Key (test-side + lint rung)

- **Objective:** Fix the unauthenticated-billing-token test failing 400 `IDEMPOTENCY_KEY_REQUIRED`, and kill the class: raw e2e request-context mutating calls that omit the required header.
- **Diagnosis:** research/billing.md §RC-C (billing.spec.ts:272,325; fixtures.ts:1147-1155).
- **Acceptance criteria:**
  1. A single shared e2e helper/wrapper auto-attaches a fresh `Idempotency-Key` to mutating (POST/PUT/PATCH/DELETE) raw request-context calls; the two billing call sites use it; existing ad-hoc header attachments (helpers/budget.ts, helpers/banner.ts) migrate to it.
  2. Enforcement rung: an e2e lint rule banning raw mutating request-context calls that bypass the wrapper (mirror existing e2e no-restricted lint patterns).
  3. Proof: `pnpm e2e e2e/billing/billing.spec.ts` — unauthenticated-user-completes-payment-via-billing-token green (RC-A tests are Task-05's scope; report residue). `pnpm lint` scope: the e2e workspace lints clean including the new rule.
- **File ownership:** e2e/billing/billing.spec.ts (request-call lines only — Task-01/02 own other specs, none own this one), e2e/fixtures.ts (billingTokenRequest area), a new e2e helper file, e2e helpers/budget.ts + helpers/banner.ts (header-attachment lines), packages/config eslint e2e rule area (coordinate: Task-03 may also touch packages/config — serialize if both add rules; you own only the e2e-lint rule addition).
- **Scoped checks:** e2e workspace typecheck + eslint exit-0 on edited files, jscpd on changed paths, spec run above.
- **Sensitive?** No — 1 auditor.

### Task-07 — regenerate path resolves Smart Model like the send path (app/api)

- **Objective:** Every regenerate of a Smart-Model (default) turn 400s: `regenerateTurnDefinitionOrRefusal` (chat routes.ts:753-755) passes the `smart-model` sentinel straight to `buildTurnDefinition`, missing the sentinel branch the send path has (routes.ts:586-596). Hits fork-regeneration, smart-model regenerate, group retry-own (3 tests).
- **Diagnosis:** research/chat-misc.md §RC-1.
- **Acceptance criteria:**
  1. Model resolution for a turn is single-sourced (e.g. a shared `resolveTurnModel()` used by send AND regenerate) — not a copied branch.
  2. TDD: failing api integration test first — regenerate of a smart-model turn currently 400s; then green. Enforcement rung: a contract matrix test covering every turn entrypoint (send, regenerate, any fork/retry entry) × smart-model sentinel resolves without VALIDATION error.
  3. Proof: `pnpm e2e e2e/chat/fork-regeneration.spec.ts` green; report residue on smart-model.spec (other RCs pending).
- **File ownership:** apps/api chat slice routes + domain model-resolution helpers + their tests. NOT the engine interpreter/fallback path (Task-08 owns it).
- **Scoped checks:** `pnpm test:api`, `turbo typecheck lint --filter=@hushbox/api`, jscpd on changed paths.
- **Sensitive?** No (routing/validation) — 1 auditor.

### Task-08 — Smart Model resolved-label + stage-signal wiring (app: api engine + web store)

- **Objective:** (a) `markStageSeen` (apps/web pre-inference-activity store) has zero non-test callers — the overhaul rewired the Smart chip via `onModelResolved` and dropped the increment, so `data-pre-inference-stages-seen` stays 0 (smart-model classifier-stage + contracts/signals tests). (b) The engine's classifier-failure fallback branch never emits the resolved-model `stream-start` label, so the UI shows nametag "Model" with no chip (smart-model fallback test).
- **Diagnosis:** research/chat-misc.md §RC-2, §RC-3.
- **Acceptance criteria:**
  1. TDD both halves at closest layer: web unit test pinning that the Smart resolve/classifying site increments the stage counter; api/engine test pinning that the fallback path emits the resolved-model label like the happy path.
  2. Enforcement rung: the existing signals contract test already fired (good); add a dead-producer guard (lint or test) so an exported signal producer with zero production callers fails — if infeasible, justify in report.
  3. Proof: `pnpm e2e e2e/chat/smart-model.spec.ts e2e/contracts/signals.spec.ts` — classifier-stage, fallback, and signals tests green; attribute residue (RC-4/RC-6 tests are out of scope).
- **File ownership:** apps/web pre-inference-activity store + Smart tile/resolve site; apps/api engine (interpreter / smart-model node fallback emission) + tests. NOT chat routes.ts (Task-07), NOT models.ts pricing, NOT use-message-share/use-conversation-links (Task-04), NOT payment-form (Task-05).
- **Scoped checks:** `pnpm test:web`, `pnpm test:api`, `turbo typecheck lint --filter=@hushbox/web --filter=@hushbox/api`, jscpd on changed paths.
- **Sensitive?** No — 1 auditor.

### Task-09 — mock echo must not break markdown fences (mock)

- **Objective:** The mock provider emits `Echo: ${prompt}` on one line, so a prompt starting with a code fence puts ``` mid-line — never a valid fence — and document extraction never triggers (document-panel test).
- **Diagnosis:** research/chat-misc.md §RC-8 (mock-provider.ts:382).
- **Acceptance criteria:**
  1. Echo prefix newline-separated from the prompt body so leading fences stay at column 0; any sibling echo formats checked for the same class.
  2. TDD: failing test first at the mock/extraction seam (a fenced prompt round-trips to a document-extraction-eligible message), then green.
  3. Proof: `pnpm e2e e2e/ui/document-panel.spec.ts` green.
- **File ownership:** the mock provider file + its tests only.
- **Scoped checks:** owning package test/typecheck/lint scoped per table, jscpd on changed paths.
- **Sensitive?** No — 1 auditor.

### Task-11 — ConversationRoom DO shard/identity reconstruction crash (app/realtime)

- **Objective:** ConversationRoom throws on DO reconstruction when `ctx.id.name` is undefined (packages/realtime conversation-room.ts:~135, hit after wrangler restart with stale .wrangler state) — the exact bug class already fixed in JobDispatcher on 2026-07-18 by persisting identity to DO storage. Surfaced by Task-02's implementer mid-run.
- **Acceptance criteria:**
  1. ConversationRoom survives reconstruction without `ctx.id.name` — same mechanism as the JobDispatcher fix; extract a shared helper so both DOs use one identity-persistence mechanism (class fix), unless the two DOs' shapes genuinely diverge — justify if so.
  2. TDD: failing realtime unit test first reproducing reconstruction-without-name, then green.
  3. Proof: `pnpm test:realtime` green; no e2e run required.
- **File ownership:** packages/realtime (conversation-room, job-dispatcher only for helper extraction) + tests.
- **Scoped checks:** `pnpm test:realtime`, `turbo typecheck lint --filter=@hushbox/realtime`, jscpd on changed paths.
- **Sensitive?** No — 1 auditor.

### Task-12 — deterministic MinIO/storage readiness + api-server log capture (harness)

- **Objective:** Kill the 22-test media cluster's true cause: `ensure-stack-cli.ts:171` fires `docker compose up -d minio-setup` without awaiting bucket creation, so a cold-volume run serves media `storage.put` before the bucket exists (`NoSuchBucket` → UNAVAILABLE → INTERNAL/NOT_FOUND). Also close the diagnostic gap that hid it: api-worker output is not captured into e2e reports.
- **Diagnosis:** research/media-internal-deep-dive.md (verified live; committed media code proved green against real MinIO).
- **Acceptance criteria:**
  1. Stack readiness blocks on the bucket actually existing (poll/HEAD-bucket or awaited `mc mb`), not just container start — wherever the stack is ensured (dev + e2e paths share the mechanism).
  2. The api worker's stdout/stderr is teed into the e2e report dir (e.g. `e2e/report/<run>/server-api.log`) so server-side stacks are artifact-captured (single-source-of-truth doctrine).
  3. TDD to the extent the layer allows: a readiness check that fails against a missing bucket, then passes once gated; justify test shape for script-level code in the report.
  4. Proof under the e2e lock: wipe the MinIO volume (cold state), then `pnpm e2e e2e/chat/image-generation.spec.ts` green from cold; confirm server-api.log lands in the report dir.
- **File ownership:** scripts/** (ensure-stack, wrangler-dev, e2e prepare/report plumbing), docker-compose.yml only if a healthcheck is the right gate. No app slices, no specs.
- **Scoped checks:** repo-root `pnpm typecheck` + eslint exit-0 on edited files, jscpd on changed paths.
- **Sensitive?** No — 1 auditor.

### Task-13 — storage-failure error surfacing on dev-seed + storage contract test (app/api)

- **Objective:** A storage failure in `/dev/media-conversation` currently surfaces as opaque 404 `NOT_FOUND` (liftDevWork flattens `DevSeedError`), and media-persist re-throws a plain Error. Surface the real failure class distinctly so infra failures are never misread as domain absence.
- **Diagnosis:** research/media-internal-deep-dive.md (chain: storage-r2 assertOk → policies.ts:48 UNAVAILABLE → flattened).
- **Acceptance criteria:**
  1. `liftDevWork` (dev routes) maps storage/seed failures to a distinct, truthful error code (per CODE-RULES error-response rules: shared error-codes constant; friendlyErrorMessage entry if user-facing — dev-only routes may not need one; justify).
  2. Media-persist propagates typed failure (no plain-Error rethrow that launders UNAVAILABLE into INTERNAL defect-class) — respect the error taxonomy: infra unavailability is not a defect.
  3. TDD: failing api tests first — (a) contract test "put to missing bucket → UNAVAILABLE" at the storage adapter seam; (b) dev-seed storage failure returns the distinct code, not NOT_FOUND.
  4. Proof: `pnpm test:api` green; no e2e run required.
- **File ownership:** apps/api dev-seed routes/factories error path, media-persist error propagation, storage adapter test; packages/shared error-codes only if a new constant is required. NOT chat routes.ts (Task-07), NOT engine label emission (Task-08).
- **Scoped checks:** `pnpm test:api`, `pnpm test:shared` if shared touched, `turbo typecheck lint --filter=@hushbox/api` (+shared), jscpd on changed paths.
- **Sensitive?** No — 1 auditor.

### Task-14 — hide revoked links from listForConversation (app/api) [IC-1 RULED: hide]

- **Objective:** Revoked shared links must not appear in the conversation's link list. Founder ruling 2026-07-20: hide server-side.
- **Diagnosis:** research/sharing.md §RC4 (stores.ts:870-891 lacks the `isNull(revokedAt)` predicate its sibling reads have).
- **Acceptance criteria:**
  1. `listForConversation` excludes revoked links (predicate consistent with the slice's other link reads).
  2. TDD: failing store-level integration test first — revoked link absent from the list after revoke; then green.
  3. Proof: `pnpm test:api` green; e2e under the lock: `pnpm e2e e2e/group/group-chat-admin.spec.ts` green.
- **File ownership:** apps/api conversations slice stores + tests. No client or spec edits.
- **Scoped checks:** `pnpm test:api`, `turbo typecheck lint --filter=@hushbox/api`, jscpd on changed paths.
- **Sensitive?** Yes (sharing/authorization) — 3-lens panel (correctness, security, conventions).

### Task-15 — admission estimate regression: Smart-Model turn must fit the 5¢ allowance (app/billing) [IC-2 RULED: equation wrong]

- **Objective:** Founder ruling 2026-07-20: this is a feature regression — the test is correct, Smart Model needs no special handling, a Smart-Model call definitely fits within 5 cents; the admission estimate equation is wrong (it prices full context window on both input and output legs, orders of magnitude above realistic cost). Fix the equation so realistic worst-case estimates admit normal turns, unblocking group-chat-billing (free-allowance fall-through), multi-model/web-search/long-history sends (chat-misc RC-6), and chat-scroll.
- **Diagnosis (validated):** research/admission-estimate.md. Wrong terms in estimate-run.ts: :303 input leg = full `contextLength` (should be actual prompt tokens, bounded by contextLength); :304/:321 output falls back to full context when maxOutputTokens absent (should use the derived bounded maxOutputTokens); :364-368 classifier priced with `params:{}` ⇒ full-context both legs (should reuse the bounded `classifierWorstCaseBaseNanoUsd` the affordability filter already computes at smart-model-candidates.ts:113-133, so admission and the filter share ONE basis). fanOut×maxSteps×maxIterations are all 1 for chat turns — NOT the inflator. Legacy priced actual-prompt input + budget-bounded output (legacy stream-pipeline.ts:205-211,762-798). Today plain Sonnet = $4.14 (83×); corrected ≤ $0.05 by construction; unfittable models drop to buildable:false instead of admitting.
- **Acceptance criteria:**
  0. **(added — blocker from impl-report-1)** The estimator reads node `params` only (estimate-run.ts:303 hardcodes `inputTokens: contextLength`); the prompt-token basis (`estimatedInputTokens`, already computed in turn-definition.ts:174-192) is never stamped into node params. So the fix MUST stamp an input-token basis param into the language node in the chat build path (turn-definition.ts + smart-model-turn.ts) AND have estimate-run.ts read it (bounded by contextLength; fall back to contextLength only when absent, so the bound only ever shrinks the hold). Classifier + output-leg fixes alone leave the invariant RED (~$3.45 candidate input leg).
  1. Corrected estimate: input leg = actual prompt tokens (bounded by contextLength), not the context window; output leg = the derived bounded maxOutputTokens (no full-context fallback); classifier reserve = the bounded basis (reuse `classifierWorstCaseBaseNanoUsd` — MAX_CLASSIFIER_CONTEXT_CHARS/2 input + CLASSIFIER_OUTPUT_TOKEN_CAP output), so admission and the affordability filter share one basis.
  2. TDD: failing tests first pinning the invariant "free-tier default (Smart) worst-case admission ceiling ≤ DAILY_ALLOWANCE_NANO_USD" AND a plain single-model turn's ceiling is realistic (≤ allowance for the seeded cheap models); watch fail (today ~$4.14/$24.84), then green. Money math: nano-USD bigint, no Number() coercion, round half-even once.
  3. Enforcement rung (Rung 3): the ceiling-≤-allowance contract test, so a future catalog/default change that breaks free-tier admittance fails at merge.
  4. Proof under the lock: `pnpm e2e e2e/group/group-chat-billing.spec.ts` (free-allowance fall-through + serial sibling) green; report residual chat-cluster 402s (some may need Task-21's snapshot fix).
- **File ownership (OPTION F — expanded again):** the input-token basis must ride an **admission-only NODE field** (sibling to `maxSteps`), NOT inside `params` — node `params` are forwarded verbatim to the provider through a strict throw-on-unknown adapter schema (language-adapter.ts:53,65), so any extra params key 400s at inference. Ownership: packages/shared/src/workflow.ts (add an OPTIONAL admission-only node field to the modelCall/smartModel node schema — backward compatible, never forwarded to the provider); apps/api workflows builders model-call.ts + smart-model.ts (stamp the field from the actual prompt the build path already computes at turn-definition.ts:174-192); models/domain/estimate-run.ts (READ the admission field) + smart-model-candidates.ts (the affordability FILTER must also price turnCeiling realistically — in-bounds finding); billing/domain/admission.ts (classifier basis if needed); chat/domain/turn-definition.ts + smart-model-turn.ts; + all their tests. Ensure model-call-execution/smart-model-execution do NOT forward the admission field to the adapter (it lives outside `params`). NOT chat/domain/runtime.ts (Task-21), NOT chat routes.ts (Task-07, landed), NOT the smart-model node fallback EMISSION (Task-08, landed — but the workflow BUILDER smart-model.ts is different and yours). Task-07 + Task-08 both landed+audited-clean; no serialize wait remains.
- **Sensitive?** Yes (money/admission) — 2 independent auditors.
- **Note:** RC-4/Task-10 (client can't price the SMART_MODEL_ID sentinel) does NOT fold in — the corrected server basis doesn't touch the client's `getModelCostPer1k`/models.ts:66 filter. Task-10 stays separate.

### Task-21 — post-commit snapshot-refresh swallow + per-test wallet isolation (app/billing) [serialize after chat-slice tasks]

- **Objective:** `withPostCommitSnapshotRefresh` (chat/domain/runtime.ts:612) swallows a post-commit snapshot-refresh failure by design, so the next admission gates on a stale balance snapshot (healed only by the 30s TTL) → shared-wallet hold bleed can deterministically 402 even a correctly-sized reserve. Compounds the estimate regression in chat multi-model/web-search tests (chat-misc RC-6). Also: several chat/billing e2e share a single test-alice wallet.
- **Diagnosis:** research/admission-estimate.md (runtime.ts:612 finding) + chat-misc.md RC-6.
- **Acceptance criteria:**
  1. The snapshot-refresh failure is surfaced to telemetry (typed SafeLogFields, no content) rather than silently swallowed — decide whether it should also fail louder; justify against the money-never-Redis-only / advisory-snapshot doctrine (snapshot is advisory, ledger is truth — so a swallow may be doctrinally fine and the real fix is test wallet isolation; investigate and state the verdict).
  2. Per-test wallet isolation for the affected chat/billing e2e so a shared-wallet hold from one test can't bleed into another (Pillar 2.6 isolation). Prefer unique wallets/users per test over serialization.
  3. TDD at closest layer for any code change; e2e proof under the lock for the previously-402ing chat tests (multi-model follow-up/web-search/partial-failure, chat-scroll) — green after Task-15 + this.
- **File ownership:** apps/api chat/domain/runtime.ts (snapshot-refresh telemetry) + tests; the affected e2e specs' wallet-setup helpers (e2e/helpers/*, the specific specs). SERIALIZE AFTER Task-07 + Task-08 (both touch chat slice / may touch runtime-adjacent) — confirm runtime.ts not mid-edit before dispatch.
- **Scoped checks:** `pnpm test:api`, matching turbo filters, jscpd; e2e under lock.
- **Sensitive?** Yes (money/admission) — 2 independent auditors.

### Task-16 — deterministic default media model (app/web + e2e seed alignment) [IC-3 RULED: orchestrator decides]

- **Objective:** The default video model is positional (`use-resolve-default-model.ts:27-32` takes the first array entry), so catalog reorder silently changed the default (720p kling instead of veo-3.1-lite) and config-UI tests broke. Decision: the default must be deterministic and criteria-based, never positional.
- **Acceptance criteria:**
  1. Default media model selection is deterministic and non-positional: highest catalog ranking (the popularity/ordering field the catalog overhaul introduced), stable tie-break (model id) — same mechanism for image and video defaults if both are positional today.
  2. The E2E-seeded catalog deterministically yields veo-3.1-lite as the top-ranked video model so the existing spec assertions (1080p pill, 6s default) hold; if the seed already carries rankings, set them explicitly rather than relying on order. Spec may switch from hardcoded id to asserting the pinned default id from a single shared constant — assertions' intent (resolution pill, duration default) must remain.
  3. TDD: failing web unit test first — default selection with a shuffled catalog returns the ranked model, not the first; then green.
  4. Proof under the lock: `pnpm e2e e2e/chat/video-generation.spec.ts` — the 3 RC C config-UI tests green; attribute residue (storage-cluster tests are Task-12's).
- **File ownership:** apps/web use-resolve-default-model.ts + tests; the e2e catalog-seed ranking values (NOT scripts/ensure-stack or wrangler-dev — Task-12 owns those files; if the seed lives in a file Task-12 is editing, STOP and return BLOCKED); e2e/chat/video-generation.spec.ts assertion source only.
- **Scoped checks:** `pnpm test:web`, `turbo typecheck lint --filter=@hushbox/web`, e2e workspace lint/typecheck if spec touched, jscpd.
- **Sensitive?** No — 1 auditor.

### Task-17 — second strict-image model in E2E catalog; kill the known-red tests (harness/seed) [IC-4 RULED: all green]

- **Objective:** Founder ruling 2026-07-20: no documented-red tests may exist. The multi-model image tests are red-by-design because the E2E catalog exposes only one strict-image ZDR model id. Seed/expose a second distinct strict-image ZDR model so the tests select two models and go green; remove the in-spec documentation claiming they are intentionally red.
- **Acceptance criteria:**
  1. E2E catalog deterministically contains ≥2 distinct strict-image ZDR-reachable model ids (mock gateway + seed aligned).
  2. multi-model-media.spec.ts image tests select two distinct ids and pass; the "intentionally red" comment block is removed; assertion intent unchanged.
  3. TDD at the seed/catalog layer where feasible; justify shape in report.
  4. Proof under the lock: `pnpm e2e e2e/chat/multi-model-media.spec.ts` — image tests green; attribute residue.
  5. Founder directive 2026-07-20: NOTHING is intentionally red. Sweep the whole repo (specs, fixtures, docs, comments) for any marker claiming a test/feature is expected-red/known-failing ("intentionally red", "known-red", "expected to fail", fixme-class notes); remove each such claim — and for any that guard a genuinely failing test outside this task's scope, do not fix it silently: list it in your report so the orchestrator files a diagnosis task.
- **Mechanism (research/multimodel-image.md):** E2E catalog is LIVE from OpenRouter (`catalog:refresh --require-e2e-models` in e2e:prepare); only ONE strict-image ZDR model qualifies (seedream-4.5). The other real ZDR image id (mai-image-2.5) is token-priced-image → excluded by the normalizer, and relaxing that is a founder-ruled billing regression. So a real second id is impossible.
- **Design (option d):** inject an E2E-ONLY synthetic strict-image catalog row after catalog:refresh (the mock send-path already renders any image id). Keep it OUT of `E2E_MODELS.image` (which is validated pre-seed against live OpenRouter) — put its id in a NEW seed-only constant the spec reads.
- **Acceptance criteria (revised):**
  1. `db:seed` upserts one synthetic descriptor (`outputs:["image"]`, `zdrReachable:true`, per-image priced, id e.g. `hushbox-e2e/mock-image-2`) via a barrel-exposed `upsertCatalog` (models slice single-writer respected — expose through models/index.ts, don't write the table from scripts directly if that violates the boundary; if it must, justify).
  2. multi-model-media.spec.ts IMAGE_MODELS = two DISTINCT ids (seedream-4.5 + the synthetic), both select and pass; the "intentionally red" comment block (spec:7-18) removed; assertion intent unchanged.
  3. Remove every "intentionally red" marker for these tests: spec:7-18, research/media-gen.md RC-D note, plan.md/ledger IC-4, and the two CODEBASE-AUDIT docs (per founder: NOTHING intentionally red). For any red-marker guarding a genuinely-failing OTHER test outside scope, list it in the report for a diagnosis task — don't silently strip.
  4. TDD at the seed/catalog layer (synthetic row present + runnable after seed); e2e deferred to orchestrator central run.
- **File ownership:** e2e/chat/multi-model-media.spec.ts; scripts/lib/e2e-model-ids.ts (new seeded-image constant) + scripts/lib/e2e-models.ts (post-seed ≥2 validation) + scripts/seed.ts (upsert); apps/api/src/platform/dev/seed-toolkit.ts + apps/api/src/slices/models/index.ts (expose upsertCatalog). Task-12/22 done (scripts readiness files) — don't touch those. If Task-15 is mid-edit in models/index.ts, coordinate/serialize the barrel export line. media-gen.md + CODEBASE-AUDIT docs for the red-marker removal.
- **Scoped checks:** `pnpm test:api` (seed/catalog), e2e lint/typecheck, jscpd. No e2e run.
- **Sensitive?** No — 1 auditor.

### Task-18 — single-model regenerate wire shape: adopt legacy models[] (app/api + web) [IC-5 RULED; design chosen]

- **Objective:** Make regenerate use a `models` array of length ≥ 1 (legacy shape), with `replaceAssistantId` as the sole regenerate-one vs retry-all discriminator, so the two failing e2e tests' assertions hold with NO test changes. Design + evidence: research/regenerate-wire-shape.md.
- **Acceptance criteria:**
  1. chat routes.ts regenerate schema: `models` `.min(2)`→`.min(1)` (regenerate path ONLY — send-side `startTurnBodySchema` keeps `.min(2)`); `models` required for regenerate; singular `model` reduced to optional anchor (or removed) — server always reads `body.models`.
  2. Client use-chat-stream.ts: always send `models: request.models` for regenerate (remove the `>= 2` gate). No change to chat-regeneration.ts list resolution.
  3. Enforcement: type the regenerate wire body so `models` is a required non-empty array (Rung 1); a shared contract test asserting regenerate accepts min-1 while send requires min-2 (Rung 3).
  4. TDD: failing api/contract test first (regenerate with a 1-element models array currently rejected → accepted); then green. Verify the two e2e tests under the lock: `pnpm e2e e2e/chat/regeneration.spec.ts e2e/chat/multi-model-regeneration.spec.ts`.
- **File ownership:** apps/api chat routes.ts regenerate schema + contract test; apps/web use-chat-stream.ts + its test. SERIALIZE AFTER Task-07 (chat routes.ts) — do not dispatch concurrently. Before dispatch, confirm use-chat-stream.ts is not mid-edit by Task-08.
- **Scoped checks:** `pnpm test:api`, `pnpm test:web`, matching turbo filters, jscpd.
- **Sensitive?** No — 1 auditor.

### Task-19 — conversation-delete: stale prefetch + truthful error code (app/web) [IC-6 RULED: investigate and fix]

- **Objective:** After deleting a conversation the client still prefetches `/messages?` for the deleted id (stale query — fix by removing/cancelling the prefetch at delete), and the delete error surface emits `NOT_FOUND` where the test allowlist expects `CONVERSATION_NOT_FOUND` — investigate which code is repo-conventional (shared error-codes registry, sibling routes) and align app or allowlist truthfully.
- **Diagnosis:** research/chat-misc.md §RC-7.
- **Acceptance criteria:**
  1. No request for a deleted conversation's messages fires after delete (query cancellation/removal at the delete site).
  2. Error code investigation documented in the report; the chosen code follows the shared error-codes registry convention; allowlist/opt-out updated only to match the truthful contract, never widened generically.
  3. TDD: failing web test first for the prefetch-after-delete; then green.
  4. Proof under the lock: `pnpm e2e e2e/chat/chat.spec.ts` delete test green.
- **File ownership:** apps/web conversation-delete hook/query wiring + tests; e2e/chat/chat.spec.ts opt-out lines only; apps/api delete route error mapping ONLY if investigation proves the API code wrong. NOT chat routes' model resolution (Task-07).
- **Scoped checks:** `pnpm test:web` (+api if touched), matching turbo filters, jscpd.
- **Sensitive?** Yes-adjacent (deletion) — 1 auditor + validator on any Critical.

### Task-20 — latch the held-stream release barrier (app/realtime) [depends on Task-11]

- **Objective:** message-queue test: a queued message never drains because the held primary run never settles. The release barrier is a one-shot in-memory handshake — release fires before the primary parks (Smart Model's classifier stage satisfies `waitForStreamingActive` early), so `heldStreamRelease` is null at release (`{"released":false}`), the primary is orphaned, and `queued-messages` never unmounts.
- **Diagnosis:** research/message-queue-drain.md (evidence: released:false resource body; tile frozen at first 8-char delta; conversation-room.ts heldStreamRelease 129-138 / attachHeldStreamRelease 299-307 / releaseHeldStreamRoute 310-317; mock park mock-provider.ts:387-396).
- **Acceptance criteria:**
  1. The release latches: persist `releaseRequested` so a held run that parks (or a DO that reconstructs) AFTER release resolves immediately; key the barrier to the primary tile, not "whatever is parked". Order-/instance-independent.
  2. TDD: failing realtime contract test first — release-before-park and release-after-reconstruct both resolve the park and yield exactly one terminal settle; then green.
  3. Enforcement rung: that contract test pins release↔park order/instance independence → queue drains empty.
  4. Proof under the lock: `pnpm e2e e2e/chat/message-queue.spec.ts` green; `pnpm test:realtime` green.
- **File ownership:** packages/realtime conversation-room.ts + room-core + tests; the mock park path in apps/api mock-provider ONLY if the mock's park semantics must change (coordinate: Task-09 owns mock echo formatting — do not touch echo lines). SERIALIZE AFTER Task-11 (same conversation-room.ts) — do not dispatch concurrently.
- **Scoped checks:** `pnpm test:realtime` (+`pnpm test:api` if mock touched), matching turbo filters, jscpd.
- **Sensitive?** No — 1 auditor. (Realtime/settlement-adjacent — validate any Critical.)

### Task-23 — account-deletion app fixes: post-deletion redirect + lockout modal copy + 2FA coverage (app/web + api) [from account-deletion diagnostic]

- **Objective:** Fix the two app-side bugs blocking account-deletion e2e (30 failures). Both live in delete-account-modal.tsx (combined to avoid self-collision).
- **Diagnosis:** research/account-deletion-app.md.
- **Bug 1 (24 fails) — redirect to /login instead of /welcome:** delete-account-modal.tsx:453 sets `location.href = ROUTES.MARKETING` then :454 calls `clearLocalAuthState()` which (since a4b4483d, auth.ts:557-576) unconditionally `location.reload()`s the CURRENT url (/settings, the /welcome nav hasn't committed); the reloaded /settings re-runs requireAuth → redirect to /login. **Fix:** `clearLocalAuthState({ reload: false })` at :454 (the same-origin href assignment is already a full-doc nav — verify it gives the same memory-reset guarantee).
- **Bug 2 (6 fails) — lockout copy never shows:** `messageFor` (delete-account-modal.tsx:53-58) only calls `formatLockoutMessage` when `code==='DELETE_ACCOUNT_LOCKED'`, but the API NEVER emits that code — it emits `TOO_MANY_ATTEMPTS` + `{retryAfterSeconds}` (routes.ts:915, deletion.ts:176-188). **Fix:** key `messageFor` on the `retryAfterSeconds` detail (or the TOO_MANY_ATTEMPTS code), not the dead `DELETE_ACCOUNT_LOCKED`. NOTE: the source ALREADY returns 429 (proven by routes.integration.test.ts:2064-2094); the e2e "400×4" status symptom is a stale-build/redis artifact — the orchestrator verifies it clears on the fresh central run; do NOT invent a status-mapping fix.
- **Coverage gap:** the 2FA finish-flow lockout (valid proof + wrong TOTP ×max, deletion.ts:232-260) has no integration test. Add one.
- **Acceptance criteria:**
  1. Bug 1: modal passes `reload:false`; unit test asserts `location.href===MARKETING` AND `location.reload` NOT called.
  2. Bug 2: `messageFor` keyed on retryAfterSeconds/TOO_MANY_ATTEMPTS; modal test asserts the formatted lockout copy renders for the real API error shape.
  3. New api integration test: 2FA account, wrong TOTP ×max → next attempt 429 with numeric retryAfterSeconds.
  4. TDD RED→GREEN at each layer (modal unit + api integration). No forbidden shortcuts.
  5. Proof: `pnpm test:web` + `pnpm test:api` scoped green; e2e (account-deletion.spec) deferred to orchestrator central run.
- **File ownership:** apps/web delete-account-modal.tsx (+ its unit test); apps/api identity routes.integration.test.ts (new 2FA lockout case). auth.ts clearLocalAuthState is NOT edited (it already supports the reload option) — only the call site. No spec edits (Task-01 owns account-deletion.spec, already clean).
- **Scoped checks:** `pnpm test:web`, `pnpm test:api`, matching turbo filters, jscpd.
- **Sensitive?** Yes (auth/session-clear + deletion) — 2 independent auditors.

### Task-25 — 4k-video canary → green cost-differential test (test-side) [founder standing ruling: nothing red]

- **Objective:** video-generation.spec.ts:373 "cost preview increases 1080p→4k" is a deliberately-RED canary asserting 4K, which no live ZDR video model offers (veo-3.1-lite = 720p/1080p only; the app correctly filters 4K out — modality-config-panel.tsx:157-168, capabilities.ts:42-63). Founder standing ruling: nothing intentionally red. Make it green WITHOUT weakening its purpose (proving cost scales with resolution) and remove the RED-canary doc.
- **Diagnosis:** research/video-4k.md. NOT an app bug — app behavior is correct.
- **Acceptance criteria:**
  1. Rewrite the test to assert the per-resolution cost differential between two resolutions the default ZDR video model (veo-3.1-lite) actually offers — 720p vs 1080p — preserving the behavioral intent (cost preview increases with resolution). Do NOT weaken to a no-op; it must still fail if the cost preview did NOT change between resolutions.
  2. Remove the "Runs RED until a 4k-capable video model is ZDR-exposed…" JSDoc canary comment (and any similar marker) — nothing may document a test as intentionally red.
  3. If the chat.page.ts selectResolution/pill helper hardcodes '4k', adjust only as needed for the two real resolutions; do not break other specs' use of it.
  4. No forbidden shortcuts (no fixme/skip/timeout).
  5. Proof: `pnpm e2e e2e/chat/video-generation.spec.ts` deferred to orchestrator central run; verify the rewritten test's logic locally against the app if feasible without e2e.
- **File ownership:** e2e/chat/video-generation.spec.ts + e2e/pages/chat.page.ts (resolution helper, only if needed). No app code (app is correct).
- **Scoped checks:** e2e eslint (from e2e dir) exit-0 + e2e typecheck, jscpd.
- **Sensitive?** No — 1 auditor.

### Task-24 — Phase-4 api coverage top-ups (app/api) [this-run coverage regressions]

- **Objective:** Restore per-file 95% coverage (line/branch/function) on api files this run's changes dropped below the gate, so `pnpm test:api`'s coverage gate (and pre-push) passes. Known: chat/routes.ts (94.95% branches — Task-07 resolver removal + Task-18 schema) and workflows/engine/failures.ts (85.71% — Task-13 StorageUnavailableError branches). MEASURE current per-file coverage first (the tree changed a lot); top up every api file this run regressed below 95%.
- **Acceptance criteria:**
  1. Run `pnpm test:api` (or scoped coverage) to get the ACTUAL current per-file numbers; identify every api file <95% that this run's changes caused (not pre-existing debt unrelated to our changes — attribute).
  2. Add tests (not istanbul-ignores, unless a genuinely-unreachable branch with justification) to bring each back to ≥95%. For chat/routes.ts, include the single-concrete-model regenerate integration case (closes Task-18's Minor: models:[id] width-1 fan-out through the regenerate path).
  3. Tests are real behavioral tests (RED-meaningful), not coverage-padding that asserts nothing.
  4. Proof: `pnpm test:api` passes including the coverage gate.
- **File ownership:** apps/api test files for the under-covered modules (chat/routes.integration.test.ts, workflows/engine/failures.test.ts, and any other api file measured <95%). Prefer NOT changing source; if a branch is genuinely dead, justify an ignore. Coordinate: Task-25 is e2e-only (no collision).
- **Scoped checks:** `pnpm test:api` (with coverage), turbo typecheck lint --filter=@hushbox/api, jscpd.
- **Sensitive?** No — 1 auditor (but if any source changes, re-scope).

### Task-26 — Phase-4 e2e/config cleanup (test/harness) [knip + stale opt-outs + config verify]

- **Objective:** Clear the remaining non-e2e gate failures and stale markers so pre-push is green.
- **Acceptance criteria:**
  1. knip (`pnpm lint:unused`): resolve the 2 unused exports in e2e/helpers/idempotent-request.ts (Task-06's PATCH/DELETE wrappers unused). Decide with the completeness principle: if PATCH/DELETE mutating calls exist in e2e that should use them, wire them; else trim to the used set (POST/PUT) — knip must pass. Document which.
  2. Remove the two stale `CONVERSATION_NOT_FOUND` opt-outs in e2e/helpers/member-actions.ts:19 and e2e/sharing/inbox-decline-invite.spec.ts:19 (the app emits NOT_FOUND now, per Task-19 — these opt-outs reference a dead code). Verify removing them doesn't unmask a real failure (if it does, report it, don't silently strip).
  3. Verify the staged packages/config/vitest.config.ts change (maxOldSpace 2048→8192 + anything else) is benign — it must NOT alter test roots/coverage config in a way that includes legacy/ or changes gate behavior. Report exactly what changed and confirm it's a memory bump only. If it's not benign, flag it.
  4. Proof: `pnpm lint:unused` (knip) passes; e2e eslint + typecheck exit-0.
- **File ownership:** e2e/helpers/idempotent-request.ts (+ any e2e mutating call sites needing PATCH/DELETE), e2e/helpers/member-actions.ts, e2e/sharing/inbox-decline-invite.spec.ts; read-only verify of packages/config/vitest.config.ts (only edit it if it's genuinely broken — else just report). NOT video-generation.spec.ts / chat.page.ts (Task-25).
- **Scoped checks:** `pnpm lint:unused`, e2e eslint/typecheck, jscpd.
- **Sensitive?** No — 1 auditor.

### Task-21 — e2e per-worker wallet isolation (test infra) [THE chat-402 fix; was deferred, now required]

- **Objective:** Kill the chat-turn 402 INSUFFICIENT_ADMISSION flood. Root cause (research/chat-402-root-cause.md): all iphone-15 authenticatedPage tests share ONE wallet (test-alice $100, playwright.config.ts:260) under fullyParallel/workers:7; each smart-model admission hold reserves ≈ the whole wallet (answerMaxOutputTokens sized to the budget, turn-definition.ts:206), so the wallet supports ~one in-flight run → overlapping parallel tests + back-to-back sends → `snapshot − Σholds < estimate` → 402. NOT a Task-15 regression (Task-15's estimate is correct end-to-end); NOT underfunding; it's shared-wallet contention.
- **Acceptance criteria:**
  1. Each Playwright WORKER (or each test) that runs authenticated chat turns uses an ISOLATED funded user+wallet, so parallel/sequential turns don't contend on one wallet's holds. Prefer a worker-scoped auth/seed fixture. Do NOT simply inflate one shared wallet's balance (the hold scales with balance → doesn't help, and could mask a real admission bug) — isolation is the correct fix.
  2. Also ensure a test's OWN sequential sends don't self-collide: verify the prior turn's hold is released (settlement) before the next send is admitted; if the snapshot-refresh swallow (runtime.ts:612) causes stale-snapshot self-collision on a healthy stack, address it (see Task-30 for the api-side telemetry/robustness — coordinate, don't duplicate).
  3. Verify: re-run `pnpm e2e:fast e2e/chat/chat-scroll.spec.ts` (and a couple of the previously-402ing group-billing/multi-model tests) on a fresh stack — all green, zero 402.
  4. No forbidden shortcuts; the isolation must be a legitimate determinism fix, not over-funding to hide a real refusal.
- **File ownership (EXPANDED per impl-report-1 blocker):** the LINCHPIN is e2e/helpers/personas.ts — make `personaEmail`/`personaUsername` worker-aware (resolve to the current worker's pooled persona), which auto-aligns every spec that references personaEmail('test-alice') etc. Plus: e2e/fixtures.ts (auth fixtures), playwright.config.ts, scripts/seed-personas.ts / seed (create a per-worker persona POOL — one funded alice/dave/bob… per Playwright worker index, sized to `workers`), and the two inline-literal call sites newsletter-settings.spec.ts:28 + inbox-decline-invite.spec.ts:24 (swap the hardcoded 'test-alice' literal to personaEmail). Isolate EVERY funded/mutated persona that causes cross-worker contention (not only alice — group tests have members send turns → their wallets contend too), so no two workers share a wallet. NOT app admission code (Task-30). NOT the e2e storage gate (Task-29).
- **Scoped checks:** e2e eslint (from e2e dir) + typecheck; the targeted e2e re-run above.
- **Sensitive?** Yes (money-test infrastructure — could mask real billing bugs) — 2 independent auditors.
- **ATTEMPT-1 FINDINGS + REFINED FIX (do this):** attempt-1 made personaEmail/username worker-aware but that alone did NOT clear the 402 (report 12-32-47 still 402). The CRITICAL cause is a per-test global admission wipe: the auto-fixture `resetRateLimitsAutoHook` (fixtures.ts:1080) calls `DELETE /dev/usage-rate-limits` → `resetUsageRateLimits` (apps/api/src/platform/dev/redis-resets.ts:87) which GLOBALLY deletes `billing:admission:*` (ALL wallets' holds+snapshots+scope counters); under parallel workers this races (one worker wipes another's live admission state) → INSUFFICIENT_ADMISSION. FIX ORDER (cheapest first):
  (A) Make the per-test admission reset NON-GLOBAL: scope the `billing:admission:*` deletion to the CURRENT worker's wallet(s) only, OR remove `billing:admission:*` from the per-test `resetUsageRateLimits` and instead clear admission state once per run in global-setup / rely on per-worker isolation + TTL. Keep the rate-limit prefixes (chat:stream:*, media:*) as-is. Note redis-resets.ts is dev/api code — confirm `resetUsageRateLimits` has no non-e2e caller before changing its prefix list; if it does, add a wallet-scoped variant for the e2e hook instead.
  (B) Ensure per-worker isolation is REAL, not name-only: attempt-1 changed only personas.ts + fixtures.ts. If (A) alone doesn't clear the 402 at real parallelism, complete isolation — seed a funded per-worker persona POOL (scripts/lib/seed-personas.ts) AND capture per-worker storageState sessions (e2e/auth.setup.ts writes e2e/.auth/<project>/<pooled-name>.json for each pool member; fixtures.ts:38 loads by persona name). Pin `workers` in playwright.config.ts to a known N and size the pool to N.
  (C) VERIFY AT REAL PARALLELISM — not low-worker e2e:fast. Force multiple workers on the failing specs (e.g. `pnpm e2e:fast e2e/chat/chat-scroll.spec.ts e2e/group/group-chat-billing.spec.ts e2e/chat/multi-model.spec.ts` with enough tests to span workers, or pass `--workers` explicitly) and confirm ZERO INSUFFICIENT_ADMISSION across a genuinely parallel run.
- **File ownership (attempt-2, expanded):** e2e/fixtures.ts (the auto-hook + auth), e2e/helpers/personas.ts, playwright.config.ts, scripts/lib/seed-personas.ts, e2e/auth.setup.ts, e2e/global-setup.ts (coordinate with Task-29's gate — do NOT remove it; only add a once-per-run admission clear if you choose that path), AND apps/api/src/platform/dev/redis-resets.ts + its dev route (for the wallet-scoped admission reset — this is dev-only code, keep it dev-classed) + tests. NOT app admission/settlement logic (runtime.ts = Task-30).

### Task-29 — MinIO bucket-ready as e2e global-setup precondition (harness) [the 6 UNAVAILABLE fix]

- **Objective:** Image runs fail mid-run with ChatRunFailedError: UNAVAILABLE because the bucket-ready gate (ensureMediaBucketReady) runs only on `pnpm db:up` (Task-22) and inside ensure-stack, but NOT as an e2e global-setup precondition — so a `pnpm e2e` invocation isn't guaranteed a ready MinIO bucket (research/chat-402-root-cause.md UNAVAILABLE section).
- **Acceptance criteria:**
  1. The e2e global-setup calls ensureMediaBucketReady (reuse Task-12's helper — single mechanism, no duplicate) as a hard run precondition, so every `pnpm e2e` guarantees the bucket before any test runs.
  2. Verify the MinIO endpoint/credentials/bucket are correct for the e2e worker context, and check the storage-r2.ts UNAVAILABLE mapping isn't also triggered by a CI service_evidence write path in local e2e (if it is, gate that path to CI-only or fix it).
  3. Verify: re-run `pnpm e2e:fast e2e/chat/image-generation.spec.ts` on a fresh stack — the previously-UNAVAILABLE tests green (attribute any residual 402 to Task-21).
- **File ownership:** e2e global-setup (e2e/global-setup.ts or the prepare hook), reusing scripts/lib/minio-bucket-ready helper. NOT app storage code unless the service_evidence path proves wrong.
- **Scoped checks:** e2e eslint/typecheck; the targeted e2e re-run above.
- **Sensitive?** No — 1 auditor.

### Task-30 — surface admission-refusal reason (api observability) [not blocking green; "surface don't swallow"]

- **Objective:** runtime.ts:591 collapses the real AdmissionRefusalReason (budget-exceeded vs balance vs concurrent-cap) + estimate into an opaque INSUFFICIENT_ADMISSION, so a 402 can't be debugged from the wire/logs (this diagnosis was blind because of it). Surface the reason + estimate + (snapshot−holds) via the typed telemetry logger (SafeLogFields, no content/PII/money-as-Number). Optionally harden the hold-release/snapshot-refresh path if Task-21 shows sequential self-collision on a healthy stack.
- **Acceptance criteria:** typed telemetry emits the admission-refusal reason + estimate at the refusal site; TDD at the api layer; no money-as-Number, no content logged. Enforcement: a test asserting the refusal telemetry carries the reason. Proof: `pnpm test:api` scoped green.
- **File ownership:** apps/api chat/domain runtime.ts (admission refusal site) + tests. Coordinate with Task-21 on any runtime.ts hold-release change (serialize if both edit runtime.ts).
- **Sensitive?** Yes (money/admission observability) — 1 auditor. LOWER priority — dispatch after Task-21/29 or in parallel if no runtime.ts collision.

### Task-32 — admission balance check must honor the PAID_CUSHION (app/billing) [THE real chat-402 fix]

- **Objective:** Every PAID wallet's first smart-model chat turn is refused with INSUFFICIENT_ADMISSION even on a fresh isolated funded $100 wallet. Root cause: the estimate/ceiling for a paid turn is sized against `effective = remaining + PAID_CUSHION_NANO_USD ($0.50)` (turn-definition.ts:202, deliberate — paid users may go negative up to MAX_ALLOWED_NEGATIVE_BALANCE_CENTS=$0.50), but the admission Lua's insufficient-balance gate checks raw `balance − heldSum < estimate` (admission-scripts.ts, no cushion). So `estimate ≈ balance + $0.50 > balance` → refused by exactly the cushion on the first send. Estimate side and admission side are inconsistent by the cushion.
- **Diagnosis:** task-21/impl-report-2.md (root-caused it on a fresh funded wallet, first send, not contention) + orchestrator confirmation from turn-definition.ts:123,135-139,202 and admission-scripts.ts insufficient-balance gate.
- **Acceptance criteria:**
  1. Confirm the intended cushion semantics from code/docs/tests FIRST: a paid (non-free) wallet is allowed to spend into a negative balance up to PAID_CUSHION ($0.50). Do NOT change the estimate side (its cushion-sizing is the documented intent) unless you prove the estimate is wrong instead — justify whichever side you fix.
  2. Make admission consistent: for NON-FREE wallets, the insufficient-balance gate must allow `balance + PAID_CUSHION − heldSum ≥ estimate` (i.e., admit spending up to the cushion), matching the estimate's sizing. Free wallets keep their allowance-only path unchanged. Preserve the concurrent-run cap and budget-scope checks exactly.
  3. Money doctrine: nano-USD bigint, no Number() coercion on money, no change to settlement/ledger; PAID_CUSHION single-sourced (don't hardcode a second $0.50). The negative-balance-up-to-cushion must not exceed MAX_ALLOWED_NEGATIVE_BALANCE_CENTS.
  4. TDD: failing api integration test FIRST — a funded paid wallet's first smart-model turn is currently refused (402) → admitted after the fix; AND a wallet whose estimate exceeds `balance + cushion` is STILL refused (the gate still works). Watch it fail for the right reason.
  5. **SHARED LOGIC, not a shared constant or a bound duplication (attempt-1 was shallow).** There must be exactly ONE implementation of "spendable funds for a turn": a single function `spendableFundsNanoUsd(balanceNanoUsd, funding)` (free → allowance path; paid → `balance + PAID_CUSHION`). BOTH consumers call it — the estimate side (turn-definition.ts stops hand-rolling `remaining + cushion` and calls it) AND admission.ts (computes the effective figure via it and passes THAT single number to the Lua). The Lua stops computing `balance + cushion` and stops knowing about the cushion/free/paid at all — it becomes a pure atomic subtractor: `effectiveSpendable − Σholds < estimate`. No second copy of the arithmetic, no `PAID_CUSHION` redeclaration, no contract-test binding two implementations — one method, called from both places. The advisory-balance relaxation (Lua now gates on the TS-supplied balance, keeping its atomic guarantee only over the holds — the part that actually races) is acceptable BY DESIGN: the snapshot balance is already advisory ("holds and snapshots are advisory, the ledger is truth"), same-wallet settlement serializes under FOR UPDATE, admission is a best-effort gate. Preserve the fail-closed invariant (missing-type/stale snapshot → no cushion). A test still asserts the rule, but it tests the ONE function, not a cross-representation contract.
  6. Proof: `pnpm test:api` scoped green; then the e2e chat-scroll/group-billing parallel verify (with Task-21's isolation) shows ZERO INSUFFICIENT_ADMISSION.
- **File ownership:** apps/api billing slice admission.ts + admission-scripts.ts (the Lua gate + its caller) + tests. NOT turn-definition.ts/estimate-run.ts (Task-15 — the estimate side is correct) unless you prove otherwise and justify. NOT runtime.ts telemetry (Task-30). NOT e2e (Task-21).
- **Sensitive?** Yes (money/admission — the run's second keystone) — 2 independent auditors.

## Open intent conflicts (all RULED 2026-07-20 — see tasks above; kept for provenance)

- **IC-1 (sharing RC4):** revoked invite links still returned by `listForConversation` and rendered. Test expects disappearance. Hide server-side (`isNull(revokedAt)`) vs client filter + revoked-badge spec?
- **IC-2 (billing RC-B + chat-misc RC-6):** free 5¢ daily allowance can structurally never admit a Smart-Model turn (full-context worst-case ceiling). Options: bounded free-tier default model / bounded free-tier admission ceiling / test selects a cheap model. Same ceiling mechanism also 402s heavier Smart/multi-model/web-search sends in chat tests (shared test-alice wallet + a swallowed snapshot refresh at runtime.ts:612 compound it — the swallowed error deserves scrutiny regardless of ruling).
- **IC-3 (media RC C):** default video model is positional (`use-resolve-default-model.ts:27-32` takes the first array entry); the catalog overhaul reordered `/models` so the default became 720p-only kling-v3.0-pro while tests hardcode veo-3.1-lite (1080p, 6s default). Which model should be the pinned deterministic default? (A deterministic, non-positional default is needed either way.)
- **IC-4 (media RC D):** multi-model-media image tests are documented in-spec as intentionally red — only ONE strict-image ZDR model id exists, and selecting it twice toggles it off. Ruling: expose/seed a second strict-image ZDR id, redesign the test, or accept these tests' removal? (`test.fixme` is a forbidden shortcut in this workflow.)
- **IC-5 (chat-misc RC-5):** single-model regenerate wire shape — app sends `model` + `replaceAssistantId` and omits `models` (server schema forbids a 1-element `models`, min 2); tests assert `body.models[1]`. Which contract is intended?
- **IC-6 (chat-misc RC-7):** conversation-delete flow — tests' unexpected-error opt-out expects `CONVERSATION_NOT_FOUND`, app emits `NOT_FOUND`; and after delete the client still prefetches `/messages?` for the deleted id (looks like a stale-query app bug — diagnostician recommends removing the prefetch rather than widening opt-outs). Ruling on the intended error code; the stale prefetch is likely fixable without ruling but touches the same test.

### Task-36 — cap local Playwright workers for media-heavy mobile projects (infra config) [fixes media UNAVAILABLE/503/crash cascade]

- **Objective:** Under `e2e:fast` (single project iphone-15) and full `pnpm e2e`, the media-heavy mobile projects (iphone-15, pixel-7, ipad-pro) run at the global pool of 12 workers against ONE local backend (one wrangler worker + one MinIO + one Redis + one Postgres), saturating it: CPU 94% / load 28.6 / RAM 71% / 2 WebKit OOM crashes, producing ~34 `ChatRunFailedError: UNAVAILABLE` (media storage.put exhausts retries), several `503` on `/auth/me` (redis revocation read fails under load → pipeline-session.ts:112), and browser crashes. Cap these projects' local concurrency to a level the single-instance local backend sustains, mirroring the existing firefox precedent.
- **Diagnosis:** Diag-2 (ledger + this run's report). No code/harness defect underneath — the `UNAVAILABLE` is the app's intentional infra-outage classification (media-persist.ts:170-194) firing under genuine saturation; there is NO concurrent bucket-wipe race (grep-confirmed zero). Pure single-backend overload at 12 workers.
- **Acceptance criteria:**
  1. Add a per-project `workers` cap to the `iphone-15`, `pixel-7`, and `ipad-pro` projects in `playwright.config.ts` (blocks at ~:260, :273, :285), mirroring the firefox precedent (`workers: isCI ? 4 : '30%'`, config:150/245). Choose a conservative sustainable value with reasoning in a code comment; anchor to firefox but you MAY go slightly lower (e.g. `isCI ? 4 : '25%'`) given these projects run the full media suite and firefox does not — justify the number you pick in the comment. Do NOT exceed the firefox local value.
  2. PRESERVE the `workers ≤ persona-pool` invariant (config:46-50): the per-project cap must be ≤ `E2E_WORKER_POOL_SIZE` (12). Lower is safe (fewer workers than pooled personas → no wallet contention). Do NOT change `E2E_WORKER_POOL_SIZE` or the global top-level `workers` (:50) — only add per-project caps.
  3. Add a short comment on each capped project (or one shared comment) recording WHY (single local backend can't serve N concurrent media runs; matches production where the backend scales), so the cap reads as deliberate capacity-matching, not an arbitrary throttle.
  4. Confirm the per-project `workers` field is actually honored by this repo's runner (firefox already relies on it — verify it's not silently ignored; if it turns out vanilla Playwright ignores per-project workers here, STOP and report — the fix mechanism would differ).
  5. NO app/product code changes. NO change to storage-r2 resilience policy, MinIO config, or admission code (that's a separate task). This is config-only.
- **Proof:** `pnpm typecheck` + `pnpm lint` scoped clean (config is TS). The behavioral proof (media UNAVAILABLE/503/crashes gone) is validated by the USER's next `pnpm e2e:fast` run — this task does NOT run e2e. State clearly in the report that behavioral verification is deferred to the orchestrator/user's run.
- **File ownership:** `playwright.config.ts` ONLY. Non-overlapping with all other tasks.
- **Sensitive?** No (infra config, reversible).

### Task-37 — mock payment webhook must be delivered lifetime-safely (dev/harness) [fixes 3 of 4 billing tests]

- **Objective:** In local/E2E, an approved mock charge returns `awaiting_webhook` (payments.ts:206, by design) and the wallet is credited only by the confirming `cardTransaction` webhook. The mock self-delivers that webhook as a DETACHED floating promise: `scheduleWebhook` → `setTimeout(delayMs)` → `fetch(webhookUrl)`, added to an in-memory `pendingDeliveries` Set, NEVER registered with `executionCtx.waitUntil` (payment-mock.ts:86-119,142). In the workerd/wrangler runtime the request context ends when `/billing/payments` returns, so the delayed delivery is abandoned → `POST /api/webhooks/payment` never fires → balance never credited → the frontend polls `/billing/balance` forever and stays on "Processing payment…". 3 billing E2E tests time out there (simulates-successful-payment, completes-full-payment-flow, validates-real-helcim-webhook-signature). The `payment.verify.v1` fallback can't rescue it locally (no JOB_DISPATCHER binding; per-instance provider maps are empty on a fresh instance — Diag-3).
- **Diagnosis:** Diag-3 (ledger). Root = dropped background task lifetime, NOT the (already-fixed) MutationObserver.
- **Acceptance criteria:**
  1. Make the mock's confirming webhook delivery LIFETIME-SAFE so it actually fires in the workerd/wrangler runtime after the charge response returns. Register the pending delivery with the request's `executionCtx.waitUntil(...)` (the `/payments` handler already uses `c.executionCtx.waitUntil` at routes.ts:511, so executionCtx is reachable on that path). Pick the cleanest plumbing — e.g. thread `executionCtx` to the mock provider so it registers its own delivery, OR `c.executionCtx.waitUntil(provider.flushWebhooks())` after a mock charge. Justify the choice.
  2. **Timing invariant (critical):** the webhook credit MUST land AFTER the `/billing/payments` response returns, not before — the frontend captures its poll baseline from that response and only transitions to "Payment Successful" when a later poll shows the balance RISE above baseline (payment-form.tsx:497-505,533-536). Synchronous/pre-response delivery would fold the credit into the baseline and the poll would never see a rise → still stuck. Keep the post-response async delivery; only make it lifetime-safe.
  3. **No production behavior change.** This is dev/mock-only. The real Helcim path delivers webhooks externally (from Helcim's servers) and must be untouched. If you thread `executionCtx` through a shared factory (`createPaymentProviderFromEnv`, app.ts:387,401), the real provider must ignore it. Gate any behavior on the environment via `envUtils`, never on a raw flag, and keep the real path identical.
  4. (Secondary, only if cheap/coherent) make the mock provider a per-worker singleton so `knownTransactions`/`capturesByReference` survive for the `payment.verify.v1` fallback. Not required to green the 3 tests if (1) delivers reliably — note it as follow-up if you skip it.
  5. TDD: write the failing test FIRST at the closest layer — an integration test asserting a mock charge REGISTERS its confirming delivery with `executionCtx.waitUntil` (spy) AND that, once delivered, the webhook credits the wallet balance. Watch it fail (today the delivery is a dropped floating promise, never registered), then fix. The end-to-end browser proof is deferred to the user's e2e run.
- **Proof:** `pnpm test:api` scoped green (payment-mock + payments/webhook integration). Behavioral e2e proof deferred to user run.
- **File ownership:** `apps/api/src/slices/billing/adapters/payment-mock.ts` (primary) + the charge-path executionCtx wiring: `apps/api/src/slices/billing/adapters/payment-provider-env.ts`/factory + `apps/api/src/app.ts` (:387,401) if threading executionCtx; the `/payments` handler region of `apps/api/src/slices/billing/routes.ts` (~:479-511) ONLY if you choose the handler-side waitUntil. **routes.ts is shared with Task-38 (balance/transactions route classes, different region) — Task-37 lands FIRST; Task-38 serializes after.** + tests.
- **Sensitive?** No (dev/mock harness; not the production money path). Single auditor, but the auditor MUST verify criterion-3 (zero production-path change) and criterion-2 (post-response timing).

### Task-35 — Smart-Model admission reserve must be context-bounded and BALANCE-INVARIANT (money keystone) [THE real chat-402 fix]

- **Objective:** Every well-funded wallet's Smart-Model turn is refused (402 INSUFFICIENT_ADMISSION) because the admission reserve scales with wallet balance — a $100 wallet reserves ≈$100, so it supports only ~1 in-flight run; any lingering/leaked hold then refuses the next sends. Legacy did NOT have this: it reserved ~context-window-worth of the ONE chosen model (~$1–2, balance-invariant). Make the rewrite's Smart-Model reserve context-bounded and INVARIANT to balance, matching legacy's magnitude.
- **Diagnosis (Diag-1, ledger):** Two compounding causes, BOTH in Smart-Model estimation (single-model turns already match legacy and are fine):
  - (A) The rewrite HOLDS before it CLASSIFIES, so `estimateSmartModelNode` reserves `classifierReserve + MAX over node.candidates of (full-context ceiling)` (estimate-run.ts:412-436). Legacy classified first, then priced the one resolved model.
  - (B) `node.candidates` is stamped as the balance-scaled `affordable` subset (smart-model-candidates.ts:205-214: filter keeps models where `balanceNanoUsd >= reserve + turnCeilingNanoUsd(...)`), and the filter under-prices output at MINIMUM_OUTPUT_TOKENS=1000 (smart-model-candidates.ts:122-125) while the reserve prices full context. As balance rises, more/pricier/larger-context models clear the filter → the MAX in (A) climbs with balance.
- **Acceptance criteria:**
  1. Make the PRICED Smart-Model candidate set (`node.candidates`) **balance-INDEPENDENT** — build it from a fixed, balance-agnostic menu (the engine-text/pool set or a fixed curated policy set), NOT the balance-scaled affordable subset. The admission reserve (`classifierReserve + max candidate context-window ceiling`) then becomes a CONSTANT for a given catalog, invariant to wallet balance.
  2. Convert affordability into a **single binary refuse gate** (mirroring legacy's upstream low-balance denial): refuse the send iff `classifierReserve + maxCandidateCeiling > spendable`. Reuse the existing `buildable: false` / "no affordable candidate" channel (smart-model-turn.ts:150-151,175) — do NOT grow/shrink the priced set by balance. A genuinely under-funded wallet still gets a clean refusal (the balance gate still works).
  3. Do NOT introduce a new fixed `ADMISSION_DEFAULT_MAX_OUTPUT_TOKENS` constant. Legacy's context-window bound suffices once the set is balance-independent. Keep `estimate-run.ts:341` returning `contextLength` (already legacy-correct). NO `packages/shared` or `budget.ts` change. Only fall back to a constant if a balance-independent menu proves genuinely infeasible — and justify in the report.
  4. Money doctrine: nano-USD bigint, no Number() coercion, no settlement/ledger change. Cost-circuit (hold×K=5) still backstops (context-bounded ~$1–2 hold → ~$5–10 circuit, above a normal answer's cents; kills runaways, no false-trip). Settlement still charges authoritative inline cost (charge.ts:76) regardless of hold — under-GATE only, never under-BILL. Negative balances remain legal.
  5. TDD (write FIRST, watch fail): **balance-invariance** — build the Smart-Model turn at funding $10/$100/$1000 against the SAME catalog, run createEstimateRun over each, assert `estimate($100) == estimate($10)` and `estimate($1000) == estimate($10)` (invariant) AND `estimate ≤ one-model context-window ceiling` (bounded to legacy magnitude, not ≈ balance). In smart-model-turn.test.ts. Plus a coherence assertion in smart-model-candidates.test.ts that the stamped `node.candidates` does NOT vary with `balanceNanoUsd`. These FAIL today (estimate grows with balance) and pass after. Also keep a test that a genuinely under-funded wallet is still refused (the binary gate works).
  6. Interactions: independent of Task-15 (input leg) and Task-32 (spendable — unchanged). Do NOT touch admission.ts/admission-scripts.ts/budget.ts/turn-definition.ts.
- **Proof:** `pnpm test:api` scoped green (models + chat smart-model). e2e chat-402 disappearance deferred to user run.
- **File ownership:** `apps/api/src/slices/models/domain/smart-model-candidates.ts` + `apps/api/src/slices/chat/domain/smart-model-turn.ts` (refuse-gate wiring only) + `smart-model-candidates.test.ts` + `smart-model-turn.test.ts`. `estimate-run.ts:341` stays as-is. NOT admission/budget/turn-definition.
- **Sensitive?** YES (money/admission — the run's keystone) — 2 independent auditors; both must verify balance-invariance AND that a genuinely under-funded wallet is still refused (no over-admission).
- **Follow-up (out of scope, note only):** classify-before-hold (reserve tracks the actually-chosen model, legacy-exact) — a Smart-Model node re-architecture; only if founder wants reserve-tracks-chosen exactness.

### Task-38 — billing-token portal may read its own balance + transactions (billing authz) [fixes 1 billing test] — SERIALIZE AFTER Task-37 (shared routes.ts)

- **Objective:** The billing-token top-up portal (unauthenticated user tops up via a link) gets 403 on `/billing/balance` and `/billing/transactions` (both `routeClass('session')`), so the balance never renders and the test fails. Legacy granted this principal read access to BOTH balance and transactions (a `billingOnly`-scoped session allowlisted to all of `/api/billing` + `/api/auth`; dependencies.ts:86-90). Grant the rewrite's `billing-token` principal the same scoped read access.
- **Diagnosis:** Diag-3 + legacy research (ledger). `/billing/payments` (routes.ts:482) already correctly uses `routeClass('billing-token')`; `/balance` (:179) and `/transactions` (:443) are stricter than legacy at `routeClass('session')`.
- **Acceptance criteria:**
  1. Admit the `billing-token` principal to read `/billing/balance` and `/billing/transactions`, scoped STRICTLY to its OWN wallet/user (never another user's data). Use whatever route-class mechanism accepts both `session` and `billing-token` (mirror how `/payments` is classed). Do NOT broaden any other route.
  2. Verify the handlers already scope the read to the authenticated principal's own user id (no client-supplied id trust). If a handler derives the user from the session only, ensure the billing-token principal resolves to the same own-user scope.
  3. TDD: failing route-class/integration test FIRST — a billing-token principal can read its own balance and transactions (200, own data) and CANNOT read another user's (or any cross-user leakage). Watch fail (currently 403), then fix.
  4. No change to `/payments` or any non-billing route. No new principal class.
- **Proof:** `pnpm test:api` scoped green (billing routes/integration). e2e billing-token test deferred to user run.
- **File ownership:** `apps/api/src/slices/billing/routes.ts` (`/balance` :179 + `/transactions` :443 route-class regions ONLY — Task-37 owns the `/payments` region; Task-37 lands first) + the route-class/pipeline-manifest if a combined class must be added + tests. 
- **Sensitive?** YES (authorization — principal scope) — 2 auditors; both must verify strict own-wallet scoping and zero cross-user exposure.

### Task-40 — set SRH_MAX_CONNECTIONS on serverless-redis-http (local-stack config) [kills the 503 class]

- **Objective:** Under 12 workers, every authenticated request funnels multiple Redis HTTP ops through the single `serverless-redis-http` (SRH) proxy, which has NO connection cap set (docker-compose.yml ~:51-58) → it uses the image default (~3) → HTTP ops queue and time out → `pipeline-session.ts:112` returns fail-closed 503 on `/auth/me` etc. Legacy handled 12 workers; this is a rewrite-load regression on a mis-tuned proxy. Raise the SRH backend connection pool to match 12-worker concurrency.
- **Diagnosis:** Saturation diag (ledger) R1.
- **Acceptance criteria:**
  1. Set `SRH_MAX_CONNECTIONS` (verify this is the correct env var the `serverless-redis-http` image reads — check the image docs/source; if the var name differs, use the correct one and note it) on the SRH service in `docker-compose.yml` to a value comfortably above worker-concurrency × per-request Redis ops (e.g. 100). Add a short comment on WHY.
  2. docker-compose.yml is the single source of truth for local AND CI (CODE-RULES) — this change applies to both; confirm it doesn't break CI's SRH usage. No other service changed.
  3. No app code change in this task.
- **Proof:** `docker compose config` parses (or the stack still comes up); behavioral proof (503s gone) deferred to user's e2e run.
- **File ownership:** `docker-compose.yml` (the SRH service block) ONLY. Isolated.
- **Sensitive?** No (local-stack config; reversible). Single auditor — verify the env var name is real for the image and the value is sane.

### Task-41 — close the per-request Neon pool at end of request (app hardening) [stops wsproxy WebSocket leak]

- **Objective:** The hot request path creates a per-request Neon pool (`apps/api/src/middleware/pipeline-bindings.ts:29` via `createRequestDb`) but NEVER closes it, unlike every Durable Object path which calls `await db.$client.end()` (dispatcher-bindings.ts:86, realtime-room-bindings.ts:184, scheduled.ts:207). Every query-bearing request leaks a WebSocket at the single Neon wsproxy container until idle GC; at 12 workers this churns the wsproxy into a chokepoint (CPU + connection pressure) that legacy's prefix-scoped db middleware never hit. Close the per-request pool at end of request, parity with the DO paths.
- **Diagnosis:** Saturation diag (ledger) R2.
- **Acceptance criteria:**
  1. Ensure the per-request Neon pool is closed after the response completes — e.g. register `c.executionCtx.waitUntil(db.$client.end())` in a pipeline teardown that runs once per request (mirror the DO paths). Close exactly once; never double-close.
  2. **CORRECTNESS (critical):** the close must happen AFTER the response (and any streamed body) is fully done — never while an in-flight query or a streamed response still uses the pool. Verify no request-path handler uses the request `db` during a streamed/deferred response body after the handler returns (chat streaming happens in the ConversationRoom DO with its OWN db, not the request pool — confirm this). If any route streams using the request db, exclude/adjust so you don't close a pool mid-use.
  3. No behavior change other than connection cleanup. No change to the DO paths (already correct) or to `createRequestDb` semantics.
  4. TDD: an integration/unit test asserting the request lifecycle registers the pool-close (spy on `$client.end` / `executionCtx.waitUntil`) and that a normal request still succeeds (response intact, no premature close). Watch fail (today no close registered), then fix.
- **Proof:** `pnpm test:api` scoped green (middleware/pipeline tests). Behavioral proof deferred to user run.
- **File ownership:** `apps/api/src/middleware/pipeline-bindings.ts` (+ `pipeline.ts` if teardown wiring needs it) + tests. NOT the DO bindings. NOT app.ts (Task-37). Isolated.
- **Sensitive?** Moderate (connection lifecycle correctness) — 1 auditor MUST verify no mid-use close / no double-close / streaming responses unaffected.

### Task-42 — coalesce the two sequential session-revocation Redis reads (app hardening) [halves per-request Redis load]

- **Objective:** `checkSessionRevocation` does TWO sequential Redis HTTP GETs per authenticated request — `sessionActive` then `passwordChangedAt` (`apps/api/src/slices/identity/domain/revocation.ts:30-36`), each a separate round-trip. On `'*'` across 12 workers this doubles the SRH proxy load that causes the 503s. Coalesce to a single round-trip.
- **Diagnosis:** Saturation diag (ledger) R3.
- **Acceptance criteria:**
  1. Fetch both revocation keys in ONE Redis round-trip (MGET or a pipeline) instead of two sequential GETs, preserving EXACT current semantics: same fail-closed behavior on error, same interpretation of each value, same revocation decision. This is purely a round-trip reduction, not a logic change.
  2. Keep the typed key-registry usage (no raw keys). If a new Redis op wrapper (mget/pipeline) is needed, add it in the typed redis operations layer (`apps/api/src/lib/redis/operations.ts`) faithfully.
  3. TDD: tests proving identical revocation decisions (active/revoked/password-changed/error→fail-closed) with the coalesced read; assert a single round-trip is issued (spy). Watch the round-trip-count assertion fail (two today), then fix.
- **Proof:** `pnpm test:api` scoped green (identity revocation + redis operations). Behavioral proof deferred.
- **File ownership:** `apps/api/src/slices/identity/domain/revocation.ts` + `apps/api/src/lib/redis/operations.ts` (only if adding an mget/pipeline wrapper) + tests. NOT pipeline-session.ts. Isolated.
- **Sensitive?** Yes (auth/session revocation — security-relevant) — 2 auditors; both must verify the coalesced read preserves the exact fail-closed revocation semantics (no weakening of session invalidation).

### Task-44 — rename `payerUserId` to a neutral billing-principal helper (conventions close-out for Task-38) [Minor]

- **Objective:** Task-38 reused `payerUserId(principal)` (a helper named/documented for the "payer" identity, in domain/payments.ts) on the pure-read `/billing/balance` and `/billing/transactions` handlers. It's functionally correct (resolves to `principal.claims.userId`, accepts `full`|`billing-only`) but the name misleads for a read context (CODE-RULES: a misleading name is worse than none). Give it a neutral name shared by charge + read routes.
- **Diagnosis:** Task-38 correctness-lens Minor finding (ledger).
- **Acceptance criteria:**
  1. Find where `payerUserId` is defined (domain/payments.ts) and every call site (the `/payments` charge handler from Task-37 + the `/balance` :185 and `/transactions` :458 reads from Task-38). Rename to a neutral name that fits ALL of them (e.g. `billingPrincipalUserId`), preserving the exact behavior (accepts `full`|`billing-only`, returns `claims.userId`). Update the JSDoc/doc to be principal-generic (not "payer"-specific).
  2. Pure rename + doc — NO logic/behavior change. Update all references + any test referencing the old name. Confirm no other consumer breaks.
  3. Do NOT alter route classes, scoping, or the charge flow. Do NOT touch unrelated code.
- **Proof:** `pnpm test:api` scoped green (billing routes/integration) — run COVERAGE-FREE (`pnpm test:watch <files>`), authoritative lint via `pnpm lint`/direct-eslint+prettier on edited files. Behavioral e2e unaffected (rename only).
- **File ownership:** `apps/api/src/slices/billing/domain/payments.ts` (the helper def) + `apps/api/src/slices/billing/routes.ts` (call sites — do NOT alter Task-37's executionCtx wiring or Task-38's route classes, only the identifier name) + any test referencing `payerUserId`. Serialize AFTER Task-37 + Task-38 (both landed).
- **Sensitive?** No (mechanical rename, no logic change). Single auditor — verify pure rename, no behavior/scoping change, gates green.

### Task-45 — Smart-Model answer cap must always be stamped (completes the chat-402 fix) [money keystone completion]

- **Objective:** Funded personas ($100) still get 402 on Smart-Model sends because the admission estimate is $217.35 (2.17× the balance) — the MAX candidate ceiling prices the widest-context candidate (gpt-5.4-pro, 1,050,000 tokens) UNCAPPED at the priciest rate. Root: `node.params.maxOutputTokens` is MISSING. `answerMaxOutputTokens` (smart-model-turn.ts:75-116) sizes the cap against the tightest candidate context (minContext); `computeSafeMaxTokens` returns `undefined` when the budget covers that tight context ("no cap needed"), so the builder omits the cap, and admission's `declaredOutputCeiling` (estimate-run.ts:336-342) then falls back to EACH candidate's own full context and takes the MAX (widest window). "No cap" is only safe for a single-model turn; the multi-candidate Smart Model reserves the widest candidate's full window. Always stamp a concrete answer cap so admission (and the real provider request) are bounded.
- **Diagnosis:** Empirical diagnostician (ledger, session-2) — verified numbers: est $217.35 vs $100 balance; fix (cap≈4085) → est $0.85, admits.
- **Acceptance criteria:**
  1. `answerMaxOutputTokens` (apps/api/src/slices/chat/domain/smart-model-turn.ts, ~line 115) must NEVER return `undefined` in the affordable case. When `turnMaxOutputTokens(...)` returns a value, use it; when it returns `undefined` (budget ≥ tightest-candidate remaining context), clamp to `Math.max(1, minContextLength − promptInputTokensFor(budget))` — the tightest candidate's remaining context. `minContextLength` is already in scope (~line 98/103); `promptInputTokensFor` already imported (~line 21). Add a comment explaining WHY (multi-candidate estimate takes the MAX over candidates' OWN contexts, so an omitted cap reserves the widest window at the priciest rate → >$200 on a $100 wallet).
  2. This stamps `node.params.maxOutputTokens` on the built Smart-Model definition, so BOTH the admission estimate (`estimateSmartModelNode` prices each candidate at `min(candidateContext, cap)`) AND the real provider request are bounded. Do NOT fix only the estimator side (that would under-reserve vs real provider spend).
  3. Money doctrine: nano-USD bigint, no Number() coercion on money (token counts are integers, fine); no settlement/ledger change; cost-circuit (hold×K) still a meaningful bound. Preserve the builder's pre-admission affordability gate that refuses genuinely unaffordable wallets (unchanged).
  4. Do NOT touch Task-35's balance-independent menu (smart-model-candidates.ts) — it's correct and complementary. Do NOT change `computeSafeMaxTokens` (budget.ts) — its `undefined` return is correct for single-model turns; the fix is Smart-Model-specific in `answerMaxOutputTokens`.
  5. TDD (write FIRST, watch fail): (a) unit — for a catalog containing a wide-context candidate (e.g. 1M+ context) and a $100 budget, assert `answerMaxOutputTokens` returns a concrete number (NOT undefined) bounded by the tightest candidate context, AND the built definition's `node.params.maxOutputTokens` is set; (b) admission-magnitude — the Smart-Model admission estimate for a $100 budget against such a catalog is < the balance (well under — ~$1 order), and materially less than the widest-candidate full-context price. These FAIL today (undefined cap → ~$217 estimate). Watch them fail, fix, watch pass.
- **Proof:** `pnpm test:api` scoped green (smart-model-turn + estimate-run + admission). Then I (orchestrator) run `pnpm e2e:fast e2e/chat/smart-model.spec.ts` to confirm the 402s clear.
- **File ownership:** `apps/api/src/slices/chat/domain/smart-model-turn.ts` (the `answerMaxOutputTokens` function) + its tests (`smart-model-turn.test.ts`) + any estimate-magnitude test in `estimate-run.test.ts`/`smart-model-candidates.test.ts` if needed. NOT budget.ts, NOT smart-model-candidates.ts source, NOT estimate-run.ts source.
- **Sensitive?** YES (money/admission — the actual chat-402 fix) — 2 independent auditors; both verify the estimate for a funded persona drops below balance AND a genuinely unaffordable wallet is still refused AND the real provider request is now capped (no under-reserve vs runtime spend).
