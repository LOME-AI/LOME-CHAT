# Task-21 — impl-report-1

## Status: NEEDS_CONTEXT (ownership/scoping conflict — see §Blocker)

## Objective
Kill the chat-turn 402 INSUFFICIENT_ADMISSION flood by giving each Playwright
worker its own isolated funded user+wallet, so parallel smart-model sends stop
contending on one shared `test-alice-<project>` wallet.

## Root cause — CONFIRMED (matches research/chat-402-root-cause.md)
- `authenticatedPage` (`e2e/fixtures.ts:1070`) authenticates as `test-alice`,
  loading `e2e/.auth/<project>/test-alice.json` (project-level default at
  `playwright.config.ts:260` for iphone-15). `authenticatedRequest`
  (`fixtures.ts:1124-1131`) uses the same `test-alice.json`.
- `fullyParallel:true`, `workers: isCI ? 7 : '50%'` (`playwright.config.ts:39,43`);
  local 50% of 24 cores = 12 workers. Every iphone-15 `authenticatedPage`
  sending test admits against the SAME `test-alice-iphone-15` wallet.
- The default chat model is `smart-model`; each admitted run's hold ≈ the whole
  remaining balance (`answerMaxOutputTokens` sized to consume the budget), so the
  wallet realistically supports ~one in-flight run. Overlapping parallel runs see
  `snapshot − Σholds < estimate` → INSUFFICIENT_ADMISSION (402), synchronous on
  `POST /chat`. Confirmed: inflating the shared balance does NOT help (the hold
  scales with balance).
- Fix = distinct wallet per concurrent worker. A wallet belongs 1:1 to a user, so
  distinct wallet ⇒ distinct USER (distinct OPAQUE identity + session +
  storageState) per worker.

## The correct design (worker-scoped alice pool, parallelIndex-selected)
1. `scripts/lib/seed-personas.ts` (OWNED): add an alice pool to
   `BASE_TEST_PERSONAS` — index 0 = existing `test-alice` (unchanged), indices
   1..N-1 = `test-alice-1..test-alice-{N-1}`, each `emailVerified:true`,
   `totpSecret:null`, funded `DEFAULT_TEST_BALANCE_NANO_USD` ($100). Short
   displayNames so `<username>_<2-char-project>` stays ≤ `varchar(20)`
   (e.g. displayName "Test Alice 11" → `test_alice_11` (13) + `_ih` = 16 ✓).
   Pool size N ≥ max workers; recommend N = 12 (covers local 50%@24-core and
   CI 7), with `parallelIndex % N` fallback so higher worker counts degrade to
   partial sharing rather than an index overflow.
   - No edit needed to `scripts/seed.ts`: it iterates `TEST_PERSONAS`
     (BASE × projects) generically (`seed.ts:412`, `seedTestPersonas`).
   - No edit needed to `e2e/auth.setup.ts`: it iterates `BASE_TEST_PERSONAS`
     (`standardPersonas`) generically, so pool alices get storageState minted
     automatically.
2. `e2e/fixtures.ts` (OWNED): add a WORKER-scoped fixture that selects the pool
   base-name from `workerInfo.parallelIndex % N` and exposes
   `{ baseName, email, storageStatePath }`. Rewire `authenticatedPage`,
   `authenticatedRequest`, and every alice-derived fixture
   (`testConversation`, `multiModelConversation`, `imageConversation`/
   `videoConversation` via `seedMediaConversation:800`, `groupConversation`
   owner `:1162`) to derive alice's identity from this worker fixture instead of
   the hardcoded `test-alice`/`test-alice-<project>` literals.

## Blocker — the fix cannot be completed within granted ownership
Making `authenticatedPage`/`authenticatedRequest` authenticate as a per-worker
alice changes the PRINCIPAL identity. Numerous OUT-OF-BOUNDS specs/helpers
hardcode that principal as `test-alice`, and would REGRESS (including the
verify target `group-chat-billing.spec.ts`). Evidence:

- `e2e/helpers/personas.ts` — `personaEmail('test-alice')` / `personaUsername('test-alice')`
  resolve to the base `test-alice`, not the worker's alice. Group specs use these
  to locate the owner row of a `groupConversation` (owner = alice). If the fixture
  owner becomes worker-alice but the spec looks up `personaEmail('test-alice')`,
  `members.find(...)!` returns undefined → throws.
  - `e2e/group/group-chat-admin.spec.ts:22,143` (owner lookup + sidebar owner
    assertions, `authenticatedPage` drives alice).
  - `e2e/group/group-chat-billing.spec.ts:223` (alice as member) — VERIFY TARGET.
- Inline `test-alice-<project>` literals paired with `authenticatedPage`/
  `authenticatedRequest` as the acting principal:
  - `e2e/newsletter-settings.spec.ts:28` — toggles newsletter via
    `authenticatedPage`, then reads status for the literal `test-alice-<project>`
    email → mismatch if page is worker-alice → FAIL.
  - `e2e/sharing/inbox-decline-invite.spec.ts:24` — seeds group ownerEmail via
    `authenticatedRequest` using the literal (self-consistency requires it be
    worker-alice).
- `e2e/ui/document-panel.spec.ts:49` — comment only (no code coupling).
- Auth specs (`e2e/auth/*`) reference `personaEmail('test-alice')` for login;
  they self-align IF `personaEmail` is made worker-aware.

The linchpin that makes ALL of these auto-align is making
`personaEmail`/`personaUsername` (in `e2e/helpers/personas.ts`) worker-aware for
the `test-alice` base name (read `test.info().parallelIndex`, map through the same
pool). Then only the two INLINE-LITERAL specs
(`newsletter-settings.spec.ts:28`, `inbox-decline-invite.spec.ts:24`) need their
`test-alice-${project}` literal swapped to `personaEmail('test-alice')`.

None of `e2e/helpers/personas.ts`, `e2e/newsletter-settings.spec.ts`,
`e2e/sharing/inbox-decline-invite.spec.ts` are in Task-21's granted ownership
(fixtures.ts, playwright.config.ts, seed-personas.ts/seed). Implementing the fix
without them leaves `group-chat-billing.spec.ts` (a verify target) RED, so the
acceptance criteria (both specs green, zero 402) are unachievable within bounds.

I did NOT implement a partial fix: shipping the fixtures rename without the
`personas.ts` companion change would regress the verify target and burn the
shared e2e lock on a run I already know goes red for `group-chat-billing`.

## Recommendation (one of)
- Expand Task-21 ownership to include `e2e/helpers/personas.ts` (make
  `personaEmail`/`personaUsername('test-alice')` worker-aware) + the two
  one-line literal→`personaEmail` swaps in `newsletter-settings.spec.ts:28` and
  `inbox-decline-invite.spec.ts:24`. Then the full design above lands in one clean
  pass and both verify specs go green.
- OR sequence a small companion task owning those three files, serialized with
  Task-21.

## Notes for whoever lands this
- `chat-scroll.spec.ts` (verify target) uses only `authenticatedPage` with NO
  `test-alice` literal, so it validates the isolation mechanism in isolation once
  the pool + worker fixture land — good smoke for the mechanism even before the
  personas.ts companion change.
- Pool cost: N alices × 7 projects added to the seed + auth.setup cross-product
  (N=12 ⇒ +84 seeded users and +84 auth logins). auth.setup already clears the
  IP login limiter per persona, but the added setup time is a real tradeoff to
  weigh vs. a smaller N (e.g. N = CI workers = 7, accepting `%`-fallback sharing
  above 7 local workers).
- Sample-data coupling is NOT a blocker: `seedAliceBillingHistory` targets the
  DEV persona `alice` (`seed.ts:462`, `devEmail`), not the e2e `test-alice`; e2e
  specs seed their own conversations via `/dev/*` endpoints, so pool alices need
  no pre-seeded conversations.
- Sequential self-collision within one test (chat-scroll multi-send): the hold is
  released at settlement; snapshot-refresh swallow (`chat/domain/runtime.ts:612`)
  and the opaque-refusal collapse (`runtime.ts:591`) are app-side and owned by
  Task-30 — REPORTED here, not touched, per bounds.

## Self-gate
- No code written (blocked before implementation). No checks run.

## Confidence
high — root cause is confirmed end-to-end; the ownership/coupling conflict is
concrete (file:line evidence) and the `group-chat-billing` verify target
provably regresses without the out-of-bounds `personas.ts` change.
