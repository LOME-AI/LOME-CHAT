# impl-report-1 — task-14-docs (canonical-cost-estimator doc updates)

## Objective

Apply the five founder-approved documentation updates to `docs/BILLING.md` and
`docs/ARCHITECTURE.md`, each verified against current code before writing.

## Files changed

- `docs/BILLING.md` — updates 1–4 (Fee Structure pointer, Storage Fees nano truth,
  Admission-includes-storage, reserve ≥ charge principle).
- `docs/ARCHITECTURE.md` — update 5 (one shared estimator bullet in §Money & settlement).

## The 5 updates (before → after + code verification)

### Update 1 — BILLING.md Fee Structure application-functions pointer

Before:
> Fee constants: `packages/shared/src/constants.ts`; application functions:
> `packages/shared/src/pricing.ts`.

After:
> Fee constants: `packages/shared/src/constants.ts`. The money-path markup is
> `applyMarkup` in `packages/shared/src/money.ts` (exact bigint nano-USD, half-even once),
> applied by the canonical estimator (`packages/shared/src/estimate/`) and at settlement.
> `packages/shared/src/pricing.ts` retains only the float display helpers (`applyFees`,
> `estimateTokenCount`).

Verified against:
- `packages/shared/src/money.ts:47` — `applyMarkup(baseCostNanoUsd: bigint): bigint`,
  half-even once (`money.ts:16` `MARKUP_BASIS_POINTS = 1500n`).
- `packages/shared/src/pricing.ts:8,23` — only `estimateTokenCount` and `applyFees`
  (float display) remain.
- `apps/api/src/slices/billing/domain/charge.ts:1,76` — settlement path imports+uses
  `applyMarkup`.
- `packages/shared/src/estimate/reducers.ts:11,125` — estimator applies `applyMarkup`.

### Update 2 — BILLING.md Storage Fees single-source

Before:
> Messages are charged a per-character storage fee covering long-term retention,
> derived in `packages/shared/src/constants.ts`: [formula] … Media has the analogous
> `MEDIA_STORAGE_COST_PER_BYTE`. Both are added to message cost in
> `packages/shared/src/pricing.ts`.

After: reframed so the nano-USD rates in `estimate/storage-rate.ts` are the billing
truth (folded as never-marked-up line items; same rate added at settlement), and the
float `STORAGE_COST_PER_CHARACTER` (constants.ts) is display-only. Formula retained.

Verified against:
- `packages/shared/src/estimate/storage-rate.ts:12,14` — `STORAGE_COST_PER_CHARACTER_NANO
  = 300n`, `MEDIA_STORAGE_COST_PER_BYTE_NANO = 18n`; file header calls them "the single
  source of truth for the storage rates".
- `packages/shared/src/estimate/price-request.ts:73-75,82-86` — storage line items carry
  `marksUp: false`.
- `packages/shared/src/constants.ts:66-68` — float `STORAGE_COST_PER_CHARACTER` derivation
  (unchanged formula; now display-only).
- `apps/api/src/slices/chat/domain/settlement-storage.test.ts:3-4,26-27` — settlement
  storage fee computed from the same nano constants.

### Update 3 — BILLING.md Billing Flow step 2 (Admission includes storage)

Before: admission "places a TTL hold for the run's declared ceiling. Redis down ⇒ …".

After: adds that for a persisting turn the ceiling includes storage — input prompt
char-storage once at the definition level plus per-node output and media storage — so
admission never under-reserves relative to settlement.

Verified against:
- `apps/api/src/slices/models/domain/estimate-run.ts:637-645` — input storage added
  ONCE at definition level (`storageContext.inputChars * STORAGE_COST_PER_CHARACTER_NANO`).
- `estimate-run.ts:66-93,580-596` — per-node token output-storage + media output-storage
  when the definition carries a `storage` stamp; comment "matching what settlement bills,
  so admission never under-reserves."

### Update 4 — BILLING.md reserve ≥ charge principle (new line)

Added after the Billing Flow list:
> **Reserve ≥ charge:** if a term is charged at settlement, admission reserves a
> best-guess for it — media byte-storage and prompt char-storage are held because
> settlement bills them — so the hold is never smaller than the eventual charge.

Verified against:
- `packages/shared/src/estimate/reducers.ts:80-95` — `reservationCeiling` folds storage
  into the hold; comment "Storage included in hold so admission never under-reserves
  relative to settlement."
- `estimate-run.ts:34-42,50-64` — admission ceiling is a deliberate over-estimate covering
  storage settlement will bill.

### Update 5 — ARCHITECTURE.md §Money & settlement (one shared estimator bullet)

Added a new bullet after the cost-circuit exposure-bound bullet:
> **One estimator, shared client + server:** the canonical nano-USD estimator
> (`packages/shared/src/estimate/`) is the single implementation of billable-cost
> pricing — client-side display and affordability, server-side admission holds, and
> settlement's estimated charges all price through it, over the shared bigint money
> primitives in `packages/shared/src/money.ts`. There is no second copy to drift.

Verified against:
- Client: `apps/web/src/hooks/billing/use-budget-calculation.ts:3,100,109`
  (`priceRequest`/`affordability`), `use-media-cost-estimate.ts:3,87` (`priceRequest`).
- Server admission: `apps/api/src/slices/models/domain/estimate-run.ts:9,87`
  (`reservationCeiling`); `estimate.ts` uses `evaluateManifest`.
- Settlement estimated charges + markup/storage: `apps/api/src/slices/billing/domain/
  charge.ts:1,76` (shared `applyMarkup`) and the shared nano storage rates (update 2).
- Module lives in `packages/shared/src/estimate/` (index.ts barrel), imported by both
  `apps/web` and `apps/api` — one shared implementation.

## No other doc content changed

`git diff --stat` shows only `docs/BILLING.md` (+29/-7) and `docs/ARCHITECTURE.md`
(+5). No other files touched. The concurrent e2e-green run's tree changes were left
untouched.

## Self-gate

- Re-read both edited sections; every claim maps to the code lines above. No test/lint
  gate applies to docs; markdown fences and list formatting are well-formed and match
  each doc's existing terse style.

## Confidence

High — each of the five claims is grounded in a specific verified code location; edits
are surgical and confined to the two approved docs.
