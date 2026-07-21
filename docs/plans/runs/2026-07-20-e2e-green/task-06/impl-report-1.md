# impl-report-1 — Task-06: E2E mutating requests auto-attach Idempotency-Key + lint rung

## Objective

Fix the unauthenticated-billing-token test's 400 `IDEMPOTENCY_KEY_REQUIRED`, and kill the
class: raw e2e request-context mutating calls that omit the required header. Provide a shared
helper that auto-attaches a fresh `Idempotency-Key`, use it at the two billing login-link call
sites, migrate the ad-hoc header attachments in `helpers/budget.ts` + `helpers/banner.ts`, and
add an e2e lint rule (the enforcement rung) banning raw mutating request-context calls that
hand-roll the key.

## Files changed

- `e2e/helpers/idempotent-request.ts` (new) — shared wrapper: `idempotentPost/Put/Patch/Delete(request, url, options?)`; each mints a fresh `Idempotency-Key` (minted once into a local var, then attached) and merges caller headers over it. Single sanctioned mint site.
- `e2e/billing/billing.spec.ts` — the two `billingTokenRequest.post('/billing/login-link')` sites (RC-C) now go through `idempotentPost`; added the helper import. Request-call lines only.
- `e2e/helpers/budget.ts` — `setConversationBudget` + `setMemberBudget` PUTs migrated from inline `headers: { 'Idempotency-Key': crypto.randomUUID() }` to `idempotentPut`; added import.
- `e2e/helpers/banner.ts` — `setBanner` POST migrated to `idempotentPost`; added import.
- `e2e/admin/helpers/feedback.ts` — `submitFeedback` POST migrated to `idempotentPost` (OUT-OF-OWNERSHIP; see Deviations); added import.
- `packages/config/eslint.config.js` — added selector (h) to `e2eUniversalRestrictedSyntax` banning a `crypto.randomUUID()` value on an `'Idempotency-Key'` header property; exported the array for the rule test.
- `packages/config/eslint-config.test.mjs` — added a describe block pinning the rule (flags hand-rolled key in helper + spec; allows intentional fixed-string keys and the wrapper call).

## Tests added

- `eslint-config.test.mjs > e2e hand-rolled Idempotency-Key ban` (4 cases):
  - flags hand-rolled `crypto.randomUUID()` key in a helper file — enforcement rung / AC2.
  - flags the same in a `.spec.ts` file — AC2 (selector is in the shared array spread into both blocks).
  - allows an intentional fixed-string key (idempotent-replay tests: op-modal / trial-media use these) — guards against over-broad matching.
  - allows the `idempotentPost(...)` wrapper call — confirms the sanctioned path is not flagged.

## Self-gate

- `npx vitest run eslint-config.test.mjs` (packages/config) — pass, 9/9.
- e2e `npx eslint .` — exit 0 (clean, including the new rule).
- e2e `npx tsgo --noEmit` (typecheck) — exit 0.
- `npx eslint eslint-config.test.mjs --no-warn-ignored` (packages/config) — exit 0. (`eslint.config.js` is ignored by eslint's config-file rule — warning only, expected.)
- `npx prettier --check` on all 7 edited files — clean.
- `npx jscpd e2e/helpers/idempotent-request.ts` — 0 clones.
- RED→GREEN demonstration: (1) the rule test was RED before selector (h) was added (0 findings) and GREEN after; (2) a scratch `.spec.ts` doing `request.post(url, { headers: { 'Idempotency-Key': crypto.randomUUID() }, data: {} })` is flagged by `npx eslint`; the migrated call sites are clean.

## Acceptance criteria

1. **Shared helper auto-attaches fresh Idempotency-Key; two billing sites use it; budget.ts + banner.ts migrate — MET.** `idempotent-request.ts` is the single helper; billing.spec.ts:272/325, budget.ts (2 PUTs), banner.ts (1 POST) all route through it. Fresh key per call re-sends unchanged on `withRequestRetry` retry (key minted before the call, not per-retry-attempt inside Playwright).
2. **Enforcement rung: e2e lint rule banning raw mutating request-context calls that bypass the wrapper — MET.** Selector (h) mirrors the existing e2e no-restricted-syntax patterns (sits alongside rule (g), the `page.request.<method>` ban). It targets the exact bug shape — an inline `crypto.randomUUID()` hand-rolled as an `Idempotency-Key` header value — so it does not false-positive on intentional fixed-key replay tests. See Concerns for the residual bypass.
3. **Proof — DEFERRED per Global Constraints.** Did NOT run `pnpm e2e` (orchestrator consolidated run). The fix is proven at the lint + typecheck layer (no e2e lock needed). e2e workspace lints clean including the new rule.

## Deviations with reasons

- **Edited `e2e/admin/helpers/feedback.ts` (outside the brief's file-ownership list).** The class-killing lint rule (AC2) flagged feedback.ts:88, which hand-rolls the identical `headers: { 'Idempotency-Key': crypto.randomUUID() }` on `POST /feedback`. AC3 requires the e2e workspace to lint clean *including the new rule*; that is impossible while feedback.ts retains the banned pattern. No task in `plan.md` owns `e2e/admin/helpers/feedback.ts`, so there is no parallel-edit collision. I migrated it to `idempotentPost` (1-line change, identical intent to the budget/banner migrations). Raised to the orchestrator.
- **Wrapper avoids self-triggering the rule by minting the key into a local variable** (`const idempotencyKey = crypto.randomUUID();`) rather than inlining it in the header property. This is the canonical mint site, not a bypass; I chose the variable form over an `eslint-disable` so no suppression comment is needed. Noted as a rule limitation below.

## Concerns and limitations

- **The lint rule is syntactic and targets the common inline hand-roll** (`'Idempotency-Key': crypto.randomUUID()`). A determined author can evade it by extracting the key to a variable first (exactly what the sanctioned wrapper does). This is an accepted limit of a `no-restricted-syntax` selector — the helper is the path of least resistance, and the rule kills the copy-paste form that actually caused the billing regression. It does NOT catch a pure *omission* of the header (billing's original bug shape), because omission is indistinguishable at lint from a legitimately idempotency-exempt `/dev/*` call; the fix for omission is that the two billing sites now use the wrapper.
- **Admin-suite convention:** op-modal.ts (`options.idempotencyKey`) and trial-media-blocked.spec.ts (fixed string literal) intentionally use non-random keys for idempotent-replay assertions; the selector correctly leaves these untouched.

## Confidence

high — lint rule RED→GREEN demonstrated on real bypassing code; all scoped checks (config vitest 9/9, e2e eslint 0, e2e typecheck 0, prettier, jscpd) pass. The one deviation (feedback.ts) is transparent, uncontested by any other task, and required by the green gate.
