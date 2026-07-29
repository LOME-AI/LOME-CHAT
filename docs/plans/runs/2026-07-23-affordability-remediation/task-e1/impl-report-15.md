# E1 — impl report 15 (vacuous composer tests; over-corrected group disclosures)

## Status

**DONE.** Both items closed: the test-evidence defect and the addendum Critical. Gate green.

---

## 1. The two composer tests were vacuous, and their docblock certified the opposite

`prompt-input.test.tsx` mocks `use-prompt-budget` wholesale, so the real `sendRefusalOf` never
runs there. Both tests set `hasBlockingError: false, sendRefusal: undefined` — **values already
identical to `defaultBudget`** — then asserted those same values back out through the DOM.
Deleting the `isTextTurn` guard could not have reddened either.

And the docblock claimed the opposite: *"These tests DELIBERATELY do not mock the refusal away."*
True of my hook-level pin, false of those two. **A comment certifying strength a test lacks is
worse than a weak test, because it stops the next reader from looking** — and it was sitting on the
artifact meant to prevent exactly that.

**I took the second option** (state what they actually pin) rather than the first (unmock the
hook), because unmocking would drag `usePromptBudget`'s whole dependency tree into a component
suite and make it a second home for hook logic. The guard is already pinned where it executes.

I did not merely rewrite the paragraph — **the tautology had to go too**. The pair now reads:

- **`renders the media composer chrome in image mode`** — the Send control is present and the
  text-only search affordance is absent. Both are the composer's own decisions from
  `activeModality`. This pins the **premise** that made the guard's absence user-facing: this
  component is the surface that sends image and video generations.
- **`disables Send in image mode when it IS handed a blocking verdict`** — the composer's wiring,
  not a fixture echoed back. **Inversion:** forcing `hasBlockingError: false` at the
  `canSubmitMessage` call reddens it.

The new docblock states the scope exactly, including the sentence that matters: *"this file mocks
`use-prompt-budget` wholesale … NOTHING in this describe can detect a change to it"*, with a
pointer to `use-prompt-budget.test.ts` as the test to change if the rule changes.

## 2. My over-correction killed the group disclosures

I removed the **whole group dimension** where the finding asked only for the **hold-aware input**
to stop reaching the decision. Consequence, exactly as measured: `deriveClientFundingInputs` always
yielded `isSolo: true`, so `owner_balance` and `payerSwitch` had **no reachable producer**. A member
in an owner-funded conversation was told *"This message uses your free daily allowance"* — while
the owner's budget paid and they were charged nothing. §Notices 5 fired nowhere in the product.

**The fix reintroduces no client-side rule**, which is the whole reason it is available: the served
snapshot already carries `payer: 'self' | 'owner'`, hold-blind and server-authoritative.
`useTurnOptions` now exposes it, and `withServedPayer` restates the verdict in terms of the payer
**the server named**:

```ts
if (payer === 'owner') return { ...result, fundingSource: 'owner_balance' };
if (!isGroupMember) return result;                    // solo self-funding is not a switch
return { ...result, payerSwitch: 'group_headroom_insufficient' };
```

The single `payer === 'owner'` branch reads the server's answer to pick a **sentence**; nothing
client-side decides which payer applies. Verified by grep: that is the only comparison of its kind
in `apps/web`, and `hasDelegatedBudget` is live input again.

**Three pins, two of which redden when the derivation is reverted:**

- owner-funded → `fundingSource: 'owner_balance'`, `group_budget_pays` present,
  `free_allowance_pays` **absent** (the wrong sentence explicitly excluded)
- server says `self` on a **group** conversation → `payer_switched_to_personal`
- server says `self` on a **solo** conversation → **no** disclosure (self-funding alone is not a
  switch)

## 3. The residual comment now states what is guaranteed

I took the auditor's strengthening, which is better than my reasoning and better than the plan's:
the decisive asymmetry is **what each notice asks the user to do**. "Wait" costs nothing and is
reversible; **"shorten your message" asks for irreversible destruction of a draft and would not
unblock the send, because the hold is still there.** A false "wait" self-corrects; a false
"shorten" leaves the user with less text and the same block.

Citation corrected: **§Notices 3** ("waiting is an action"), not §Notices 4 — which is written about
money-versus-length and does not cover hold-versus-length. The surviving §Notices 4 citation is on
the zero-hold arm, where money-versus-length is exactly the question.

And I bounded the claim to what holds: the hold claim is **true in every case that reaches it** and
transient; releasing the hold does **not** always send — at a small spendable with a long history it
yields `prompt_too_long`. So the notice self-corrects **to the length wording**, not to a send. My
earlier "the safe side" was slightly stronger than the code guarantees.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:web` (alone) | **`TESTWEB_EXIT=0`** — 396 files, **6,450 tests**, **zero** threshold errors |
| `npx tsgo --noEmit` (apps/web) | pass — `TC_EXIT=0`, zero web errors |
| `npx eslint src/hooks/billing/ src/components/chat/input/` | pass — `LINT_EXIT=0` |

A `max-params` error on my own test helper was fixed at the cause — `pair` takes an options object
rather than five positionals — not by raising the limit. One `eslint --fix` was killed at 120s
again and wrote nothing; re-run narrowly per the standing rule.

## Concerns

1. `withServedPayer` trusts `served.payer` completely. That is the intent — the server is the
   authority — but it means a wrong `payer` on the wire produces a wrong disclosure with no client
   cross-check. The alternative is a second authority, which is the defect this closes.
2. The `apps/api` typecheck error is D1's, unchanged.

## Confidence

**High.** Each item was reproduced or measured before the fix, each fix is proven by an inversion
with byte-exact restore, and the gate is green from a captured status rather than a wrapper's.
