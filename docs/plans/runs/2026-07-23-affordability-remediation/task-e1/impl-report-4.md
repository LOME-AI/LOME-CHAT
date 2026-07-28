# E1 — impl report 4 (the picker renders the produced set; engine now caller-free)

## Objective

Every client surface renders the produced `affordable` / `admissible` sets (text arm only),
premium rows MARKED not removed, and the client's second verdict engine — a **hook**, not a
component — deleted.

## Status

**DONE_WITH_CONCERNS.** The **picker** is fully converted: it renders `affordable.all`, every
disabled row carries its typed reason from the shared vocabulary, premium is a reason rather than
a separate gate, and the third phrasing is gone. As a direct consequence `useModelFloor` now has
**zero production consumers**. The effort menu, send gate, `chat-welcome.tsx` and the actual
deletion remain.

---

## What landed

### The picker renders one produced value

| Before | After |
| --- | --- |
| `isPremium` + `canAccessPremium` + `isLinkGuest` → paywall overlay with its own copy | one `availability: Availability` |
| `isBelowFloor(model)` from `useModelFloor` → grey with `MODEL_BELOW_FLOOR_REASON` | the same `availability`, greyed with `noticeText(reason)` |
| `isPremiumGated()` — a fourth premium rule in the modal | deleted; the producer decides |

`model-selector-modal.tsx` now calls `useTurnOptions` and exposes one lookup,
`availabilityOf(modelId)`, reading `affordable.all`. `model-list-body.tsx` and
`model-list-item.tsx` take that verdict and decide nothing.

**Every string traced.** `MODEL_BELOW_FLOOR_REASON` ("Doesn't fit your current balance") and the
`ModelItemOverlay` component that hand-wrote *"Top up … to unlock"* / *"Sign up … to access"* are
**deleted**. Copy now comes from `noticeText(reason)` for the tooltip and accessible description,
and from `NOTICE_COPY[reason].action` for the in-row action link. Nothing in the picker authors a
sentence.

**The action affordance was preserved, not dropped.** Two old tests pinned a clickable "Top up" /
"Sign up" link in the row. Rather than delete that behaviour with the copy, `RowReasonAction`
renders `NOTICE_COPY[reason].action` segments — linked segments become links — so "Add credit" and
"Sign up" stay actionable from the row while being authored in exactly one place.

### A regression I introduced and caught

Converting the row, I made an unavailable row swallow its click
(`onClick={isUnavailable ? undefined : onActivate}`). Eight modal tests went red and the cause was
real, not fixture drift: swallowing the click breaks **two** required behaviours — routing a
premium lock to the paywall, and de-selecting a row that became unavailable (the plan's "a greying
model must not trap the user"). The row now always reports activation; refusing to *select* is the
container's decision. My own unit test had pinned the wrong contract and was rewritten to pin the
right one.

## Inversion proofs

| Pin | Inversion | Result |
| --- | --- | --- |
| Row copy comes from the shared vocabulary | replaced `noticeText(availability.reason)` with a local sentence | **5 tests fail** |
| Rows are marked, not filtered | forced `isUnavailable = false` | **6 tests fail** |
| Adapter withholds a verdict while funding loads | removed the funding pending guard | **1 test fails** (report 3) |
| Instant is session-stable | `nowMs: CATALOG_INSTANT_MS` → `Date.now()` | **1 test fails** (report 3) |

Every mutated source file was restored from a byte-exact backup and verified with `diff`.

## Premium evidence

From the adapter's own tests (report 3, still green): the premium row is **present** in
`affordable.all`, marked `premium_requires_credit` (free payer) or `premium_requires_account` (no
account), while `admissible.sendable === true` because a different model answers the turn. At the
picker level, `model-list-item.test.tsx` pins that such a row renders, is `aria-disabled`, carries
the reason as `aria-describedby`, and still reports activation so the paywall stays reachable.

## The vocabulary sweep — and what it says about the deletion

Swept the full engine vocabulary (`useModelFloor`, `isBelowFloor`, `belowFloor`, `showFloorGrey`,
`data-below-floor`, `MODEL_BELOW_FLOOR_REASON`, `ModelFloorGroupContext`, `modelFloorNanoUsd`,
`smartModelPoolFromCatalog`, `buildModelTokenPricing`) across **all** of `apps/web` — hook and
component alike, because a component-only grep cannot close a hook:

- **Clean in the picker**: zero floor-verdict hits in `model-selector/` except one type-only
  `ModelFloorGroupContext` import threading `floorGroup` through `model-selector-button.tsx`.
- **`useModelFloor` has ZERO production consumers** — `grep` returns only its own definition at
  `use-prompt-budget.ts:677`. The picker was its last caller.
- **`modelFloorNanoUsd`** is called only from inside `useModelFloor` (`:712`), so it dies with it.
- **`smartModelPoolFromCatalog` and `buildModelTokenPricing` SURVIVE** — used at `:407` and `:457`
  by the composer's live estimate, which is the media/text estimate path the 2026-07-27 ruling
  keeps until the send gate converts and G2/E4 land.

**So the engine is not yet deleted, and I am not claiming it is.** What changed is that its
deletion is now unblocked and provably contained: `useModelFloor` + `modelFloorNanoUsd` +
`UseModelFloorInput` + `ModelFloorResult`, against **42 references in
`use-prompt-budget.test.ts`** that must be re-homed rather than dropped (they carry F1's re-pinned
defect class).

## Files changed this cycle

| File | Why |
| --- | --- |
| `model-selector-modal.tsx` | sources the verdict from `useTurnOptions`; `isPremium`/`isPremiumGated` deleted; removal-before-refusal ordering made explicit |
| `model-list-item.tsx` | three booleans → one `Availability`; local copy deleted; `RowReasonAction` renders shared segments |
| `model-list-body.tsx` | `availabilityOf` replaces four gating props |
| `model-list-item.test.tsx` | 6 new typed-reason tests; legacy premium tests re-homed onto `availability` |
| `model-selector-modal.test.tsx` | mocks the producer instead of the floor hook; copy assertions retargeted to the shared vocabulary |
| `model-list-body.test.tsx` | fixture on the new prop; a pre-existing `getPinnedLabel: () => {}` type defect fixed in passing |
| `model-selector-button.test.tsx` | mocks `useTurnOptions` — the modal now pulls it |

## Self-gate

| Command | Result |
| --- | --- |
| `vitest run src/components/chat/model-selector/ src/hooks/billing/` (via `with-env`) | pass — **23 files, 545 tests**, `TESTS_EXIT=0` |
| `npx tsgo --noEmit` (apps/web) | pass — `WEB_TC_EXIT=0` |
| `npx tsgo --noEmit` (packages/shared) | pass — `SHARED_TC_EXIT=0` |
| `npx eslint src/components/chat/model-selector/ src/hooks/billing/` (from apps/web) | pass — `WEB_LINT_EXIT=0` |
| `npx eslint src/affordability/billing/` (from packages/shared) | pass — `SHARED_LINT_EXIT=0` |

All re-run **after** the restart, so they describe the current tree rather than the pre-kill one.

**Environment note worth adding to §Known Breakage:** running `npx vitest` directly from `apps/web`
made `model-selector-button.test.tsx` fail with a `ZodError` on `VITE_API_URL`/`VITE_PLATFORM` —
env-shaped, not a defect. The web suite needs `scripts/with-env.ts`, the same class as the
documented `turbo test --filter=@hushbox/api` entry but for web. I nearly attributed it to my own
change.

Five lint errors were fixed at the cause (import order, prettier, `no-useless-undefined`,
`prefer-query-selector`), none suppressed.

## Acceptance criteria

| Criterion | Status |
| --- | --- |
| All greying derives from `affordable` | **met for the picker**; effort menu and send gate outstanding |
| Every disabled option carries its typed reason as tooltip + accessible description | **met for the picker** |
| Premium rows marked, not removed; no premium access from the balance endpoint | **met in the picker and the produced value**; `chat-welcome.tsx` still derives it |
| Session-stable `nowMs` | met (report 3) |
| Re-pin F1's defect class | met on the adapter (report 3) |
| No funding from the balance endpoint | met (reports 2–3) |
| Verdict engine deleted, grep-clean | **not met** — now caller-free, deletion unblocked |
| Send gate from `admissible` | not done |
| Existential menu rule; intersection clamp retired | not done |
| Hold vs balance pair; one hold notice | not done |
| Below-floor row de-selectable | **behaviour preserved** and made explicit, not yet separately pinned |
| No text-modality pre-send cost figure | not done |
| Five component tests | 2 of 5 (picker greying, premium/trial marking) |
| `turnDimensions` on a smart-slot-only turn | not done |
| Widen `usePromptBudget`'s return | not done |

## Concerns and limitations

1. **The two-verdict-path midpoint persists** and is now asymmetric: the picker reads the producer
   while the composer still reads `useModelFloor`'s siblings. This is the state the plan says must
   not ship.
2. **`use-filtered-models.ts` still consults `canAccessPremium`** — for row ORDERING (premium
   interlacing), not for a verdict. Defensible, but it is still fed by `chat-welcome.tsx`'s
   balance-endpoint derivation, so criterion 3 is not fully closed until that site converts.
3. **The picker passes `EMPTY_PROMPT_BASIS`.** Correct — notion 1 is prompt-independent and the
   producer substitutes the empty basis for `affordable` regardless — but it means the picker never
   exercises the `admissible` branch, so nothing there would catch a send-gate regression.
4. I did **not** attempt the deletion this cycle. With 42 test references carrying F1's re-pinned
   defect class, doing it on the remaining context would have risked exactly the half-state above.

## Confidence

**High** on the picker conversion: four inversion proofs, 545 green tests, all gates re-run after
the restart, and the one regression I introduced was caught by existing tests and fixed at the
contract rather than the assertion. **High** on the sweep's conclusion, because it was run over
the hook vocabulary and not just components. **Not applicable** to the unconverted surfaces.
