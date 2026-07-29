# E1 — impl report 14 (two Criticals from both auditors, plus three Minors)

## Status

**DONE_WITH_CONCERNS.** Both Criticals closed, each reproduced red first and each proven by
inversion. The group residual closed at both halves. All three Minors closed. Gate status in the
return message.

---

## CRITICAL A — case C: the hold wording on an ordinary free-tier state

**My previous fix stated the right rule and did not implement it.** The docblock said "refused for
FUNDING, and the same funding hold-blind would have sent" — but with `heldNanoUsd = 0`,
`affordable` and `admissible` are evaluated against the **same funding**, so the antecedent was
about the **empty basis**, not about a hold.

**Red first:** `AssertionError: expected 'funds_held_by_run' to be 'prompt_too_long'`.

The scale matters and I want it recorded: `FREE_ALLOWANCE_CENTS_VALUE = 5`, so a free user's whole
daily allowance is **$0.05**. Any long conversation puts them in case C — nothing running, told to
wait. Waiting never helps.

**Fix — the discriminator is evidence, not inference.** `useTurnOptions` now exposes `heldNanoUsd`
from the same snapshot that produced the pair, and:

```ts
if (refusal !== 'insufficient_funds' || !options.affordable.sendable) return refusal;
return heldNanoUsd > 0n ? 'funds_held_by_run' : 'prompt_too_long';
```

With nothing held, a funding refusal the empty basis would have cleared is a **length** problem —
§Notices 4 tests the minimum-answer floor first, then attributes to length.

**One older pin had to be corrected, not just added to:** the hold test asserted the hold wording
from `pair(true, false)` with nothing held — i.e. it certified the very inference now refuted. It
now supplies actual held funds.

**Residual, stated in the code rather than hidden:** when funds are held *and* the prompt is long,
both causes are live and this names the hold. That is the safe side — the hold clears itself and
"wait" becomes true within seconds.

**Inversion:** dropping `heldNanoUsd > 0n` reddens case C.

## CRITICAL B — the send gate refused every non-text modality

`PromptInput` is the media composer. `turn-core.ts` returns `modality_not_priceable` for every
non-text modality, `sendRefusalOf` passed it through, `hasBlockingError` went true, and **image and
video generation could not be sent at all** — with this cycle's notice fold now also printing
*"The selected model can't produce this kind of content"* on every media composition.

**Red first**, pinned in `use-prompt-budget.test.ts` where the real logic runs:
`AssertionError: expected 'modality_not_priceable' to be undefined`.

**Fix, per the ruling:** the send gate consumes `admissible` **only when
`activeModality === 'text'`**. That is the founder's text-arm ruling applied to the gate — the
producer declines to price media, so it has no verdict to impose there. I did **not** make the
producer price media; that is core estimator work and nobody's task.

**Both halves pinned**: media not gated, and text still gated (`insufficient_funds` →
`hasBlockingError` true), so narrowing to text cannot weaken text.

**Why it shipped unseen, and what I changed about that:** every existing media test mocked
`useTurnOptions` into a sendable pair. The new pins do not mock the refusal away, and two
composer-level tests render `PromptInput` in **image mode** and assert Send is enabled with no
modality notice.

## IMPORTANT — the group re-resolution, one layer out

`useResolveBilling` still received a **hold-aware** `effectiveRemainingNanoUsd`, so inside the
settle-then-release window the client resolved `self` where the server resolves `owner` —
rendering `payer_switched_to_personal` (telling a member they pay for a turn the owner funds) and
denying a link guest a turn admission would admit.

The group dimension is no longer passed to the client funding decision at all;
`useGroupBillingContext` and `GroupBillingContext` are deleted. Three tests that pinned the
threading are removed — they encoded the re-resolution itself, and the property is now the
server's, pinned by the adapter's payer tests.

**What legitimately remains:** `useConversationBudgets` still feeds `hasDelegatedBudget` (the
informational "the owner's budget covers your messages" notice) and the loading gate. That is
display, not verdict.

## Minors

- **Two more false-closure docblocks deleted.** Report 12 claimed the argument was deleted; **one
  of three was.** The other two sat on the public result type — where the next reader meets it
  first — asserting the proof while `sendRefusalOf` twelve lines away refuted it. Both replaced
  with a pointer to the real rule. Vocabulary sweep across `apps/web`: **clean**.
- **A comment this cycle's own edit falsified:** the media block still said a text turn "falls
  through to the token-based computation below" — I deleted that computation last cycle. Corrected.
- **A fixture contradicting its own file:** `{spendable:'0', held:'0', payer:'owner'}` is the state
  the docblock sixteen lines above declares unservable. Relabelled `'self'` with a note that the
  assertion is about the figure, not the label.

## Self-gate

| Command | Result |
| --- | --- |
| `npx tsgo --noEmit` (apps/web) | pass — `TC_EXIT=0`, zero web errors |
| `npx eslint src/hooks/billing/ src/components/chat/input/` | pass — `LINT_EXIT=0` |
| `vitest run src/hooks/billing/ src/components/chat/input/` | pass — 506 tests |
| `pnpm test:web` (alone) | **`TESTWEB_EXIT=0` — GREEN.** 396 files, **6,447 tests passed**, **zero** coverage-threshold errors |

The status was read from a file the wrapper cannot touch, not from the background notification —
which said "exit code 0" for the run that exited 1 two cycles ago, and says the same here. It
carries no information in either direction; only the captured status does.

`markdown-renderer.tsx` produced no threshold error on this run, reproducing the load-dependence
the plan documents and the other auditor measured across four runs (absent / 75% / 100%).

One `eslint --fix` was killed at 120s again and wrote nothing; re-run narrowly per the standing
rule.

## Concerns

1. **Media is now ungated by the produced verdict by design.** It keeps the path it had before this
   run. G2 and E4 own it. Nothing in E1 makes the producer price media, and nothing should.
2. The `apps/api` typecheck error is D1's, unchanged.
3. I carried the auditor's qualification: `use-budget-calculation.ts` is not purely a token
   concern — its `maxOutputTokens` drives the informational `answer_may_be_shortened` notice. It
   gates nothing, so the load-bearing half of my earlier claim holds; the phrasing was generous.

## Confidence

**High** on both Criticals: each reproduced red with the exact expected/received values, each fixed
at the cause, each proven by an inversion with byte-exact restore. **High** on the group half —
the wiring is deleted and the vocabulary sweep is clean.
