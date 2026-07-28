# E1 — impl report 8 (criterion 3 CLOSED: no balance-derived premium anywhere in `apps/web`)

## Status

**DONE_WITH_CONCERNS.** Both choice-hooks now read the served tier, which closes criterion 3
completely. The send gate — the last instance of the two-verdict state — is **not** done; I ran
out of context before starting it rather than half-landing it.

No git write this cycle. No `notices.ts` or `smart-model/prompts.ts` touched.

---

## What landed: the two choice-hooks

Both derived premium access from `/billing/balance`:

```ts
const purchasedNano = balanceData ? parseNanoUSD(balanceData.purchased.balanceNanoUsd) : 0n;
const canAccessPremium = isAuthenticated && purchasedNano > 0n;
```

Both now ask the shared tier authority about the **payer's served tier**:

```ts
const canAccessPremium = spendableData !== undefined && tierCanAccessPremium(spendableData.tier);
```

- `use-model-validation.ts` — chooses the text fallback when the catalog drops a model.
- `use-resolve-default-model.ts` — chooses a default for a non-text modality.

Neither greys anything; both are *choices*. They still mattered, because a second derivation of
"can this payer reach premium" is free to drift from the one the picker renders — and these two
choose **which model the user ends up on**.

**Inversion:** forcing `canAccessPremium = true` in `use-resolve-default-model` reddens
*"does nothing when only premium models exist and user cannot access premium"*. Restored byte-exact.

### Criterion 3, swept and closed

```
grep "purchasedNano > 0n|balance > 0|canAccessPremium =" apps/web/src  (non-test)
→ use-resolve-default-model.ts:73   served tier
→ use-model-validation.ts:37        served tier
→ model-selector-modal.tsx:91       read off affordable.all
```

Three sites, none reading a balance. **Criterion 3 is closed.**

### The loop tests got stronger, not just moved

`use-model-validation.loop.test.ts` existed because dropping a premium selection and substituting a
premium fallback could cycle unboundedly. Premium entries are no longer dropped, so the engine of
that loop is gone. The tests now pin the stronger fact — the text selection is left **exactly** as
it was — rather than the weaker "at most 4 setter calls", which a reintroduced loop of length 3
would still satisfy.

## Follow-on breakage I caused and fixed

Adding `useSpendable` to the two hooks pulled a real query into suites that only mocked
`billing`: `chat.index.test.tsx` failed with `billingKeys.spendableFor is not a function`. Mocked
`use-spendable` there. This is the third suite this task has had to mock as a hook moved deeper —
`model-selector-button`, `chat-header`, now `chat.index`. Worth noting as a pattern: **converting a
leaf to read served data pushes a mock requirement up every render tree that contains it**, and the
failure surfaces as a missing-export TypeError rather than an assertion.

## Self-gate

| Command | Result |
| --- | --- |
| `vitest run` — billing hooks, models hooks, model-selector, chat-welcome, chat-header, chat.index (via `with-env`) | pass — **33 files, 667 tests**, `TESTS_EXIT=0` |
| `npx tsgo --noEmit` (apps/web) | pass — `WEB_TC_EXIT=0` |
| `npx eslint` over the changed set (from `apps/web`) | pass — `WEB_LINT_EXIT=0` |

Typecheck caught two orphaned `makeBalance` imports that lint and tests did not — the same
ordering lesson as before.

## Acceptance criteria

| Criterion | Status |
| --- | --- |
| No funding or premium access from the balance endpoint | **MET — closed this cycle** |
| Premium marked, not removed from the selection store | met (report 7) |
| Verdict engine deleted, grep-clean | met (report 6) |
| Re-pin F1's defect class | met (report 6) |
| All greying from `affordable`; typed reasons; premium as a reason | met for the picker |
| Session-stable `nowMs` | met |
| Below-floor row de-selectable | met |
| **Send gate from `admissible`** | **not done** |
| Effort menu / intersection clamp | not done |
| Hold vs balance pair; one hold notice | not done |
| No text-modality pre-send cost figure | not done |
| Five component tests | 2 of 5 |
| `turnDimensions` on a smart-slot-only turn | not done |
| Widen `usePromptBudget`'s return | not done |

## Concerns

1. **The send gate is the whole remainder of the two-verdict state.** Picker, adapter, selection
   store and both choice-hooks are one engine; the composer is the sole holdout. Everything needed
   to convert it now exists — `useTurnOptions` returns `admissible` with `sendable` and `refusal`,
   and `noticeText` renders the reason — so it is plumbing plus the `admissible ⊂ affordable`
   evidence, not a design question.
2. **`use-model-validation` and `use-resolve-default-model` now gate on a query that is disabled
   for unauthenticated users**, so `spendableData` is permanently `undefined` for trial and guest.
   That is correct (`tierCanAccessPremium` is false for both tiers either way) but it means the
   `isReady` guard never blocks them — I checked this rather than assuming it, because a guard that
   never fires is the shape that hides a loading bug.

## Confidence

**High** on criterion 3 — it is a grep over the whole of `apps/web` with three named sites, each
reading a served value, plus an inversion proof. **High** on the loop-test rewrite being a
strengthening rather than a weakening. **Not applicable** to the send gate.
