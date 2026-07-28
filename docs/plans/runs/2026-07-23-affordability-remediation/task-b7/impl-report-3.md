# B7 — fix cycle 2

Addresses the single Minor finding. No mechanism changed: the precedence rule, which
notices fire, and the reason set are untouched — this is a copy edit inside two existing
table entries plus the pin that would have caught the class.

## Finding — two info-notice action clauses contradicted the block they render beside

**Accepted.** The distinction the finding draws is the right one and my cycle-2 wording
("an info notice makes no competing demand") was too narrow: a dismissible notice makes
no competing *demand*, but its action clause is still an *offer*, and an offer the
verdict refuses is as misleading as a contradictory demand.

Both cases are real and both are mine to fix — one because the clause is new in this
task, one because this task took ownership of the wording when it moved into the table.

### `group_budget_pays`

| | |
| --- | --- |
| was | The conversation owner's budget covers your messages, so you won't be charged. **Send when you are ready.** |
| now | The conversation owner's budget covers your messages, so you won't be charged. **Ask them for more if it runs out.** |

The clause now states what the sender can do about the funding source rather than
instructing a send that a disabled composer refuses. It stays a genuine action (§Notices
3), and it stays distinct from `payer_switched_to_personal`'s owner-directed action,
which is about changing who pays rather than extending an allocation that is still
covering.

### `free_allowance_pays`

| | |
| --- | --- |
| was | This message uses your free daily allowance. Add credit **for longer conversations.** |
| now | This message uses your free daily allowance. Add credit **for more messages each day.** |

The offer is now about how many messages the day holds — the turn-count sense — instead
of implying that money moves a context bound. The `ROUTES.BILLING` link is unchanged:
credit genuinely is the remedy for the allowance running out, which is what this notice
is about.

Both entries carry a one-line comment recording *why* the clause is verdict-neutral, in
the "what this code guarantees" form rather than a claim about what another surface
does.

### The pin, and why it is derived rather than listed

`budget.test.ts` §"informational notices that render beside a block" — two tests,
watched failing first (both red on the old copy):

- *never invites the send the block refuses* — no co-rendered informational wording
  matches `/\bsend\b/i`.
- *never offers money as the remedy for a length refusal* — none matches
  `/\blonger\b|\blength\b/i`.

The set under test is **computed from the producer**, not restated: the test drives
`generateNotifications` at 150% capacity across every approved funding shape (owner,
personal, free, trial, and the two payer-switch variants), asserts a blocking notice is
present in each, and collects whatever non-blocking wordings came back. An info notice
that starts co-rendering later is covered without editing the test — which matters
because a hand-listed set is exactly the drift this run keeps penalising.

Scope note: the pin deliberately covers only notices the producer actually renders
beside a block. `answer_may_be_shortened` still says "for longer replies" and is
correct — `pushWarningNotifications` runs only when the turn is neither denied nor over
capacity, so it never appears next to a length refusal.

## Files changed this cycle

| File                                               | Why                                                     |
| -------------------------------------------------- | --------------------------------------------------------- |
| `packages/shared/src/affordability/notices.ts`     | Two action clauses reworded verdict-neutral, with reasons |
| `packages/shared/src/affordability/budget.test.ts` | The producer-derived co-rendering pin                    |

Nothing else. The vocabulary is still 22 reasons; no severity, no trigger, no precedence
changed.

## Your correction on the coverage-crash entry — noted, and it matches what I have

Recorded here so the run's record is consistent: the single
`Something removed the coverage directory ".../coverage/.tmp"` abort I reported has not
recurred in **five** further `pnpm test:shared` runs across cycles 1 and 2, all exit 0.
It stands as one unreproduced event. Narrowing the §Known Breakage entry back to that is
the right call, and generalising from my single sighting would have been the same
one-data-point error — I reported it as "worth adding if another agent hits it" and
should have said plainly that one sighting is not a pattern.

## Self-gate

| Command                                                  | Result                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| `pnpm test:shared`                                        | **pass** — exit 0, 128/128 files; `notices.ts`, `budget.ts`, `error-codes.ts` each 100/100/100/100 |
| `pnpm test:web`                                           | **pass — exit 0**, 395/395 files, and this run printed **no** coverage error at all |
| `npx turbo typecheck --force --continue`                  | pass — 16/16, uncached                                                  |
| `eslint <9 files>` from `packages/shared`                 | exit 0                                                                  |
| `eslint <6 files>` from `apps/web`                        | exit 0                                                                  |
| `eslint <5 files>` from `e2e`                             | exit 0                                                                  |

Worth flagging on the web run: the `markdown-renderer.tsx` branch-coverage failure that
made `test:web` exit 1 in both previous cycles **did not occur this time** — same file
list, same untouched component, clean exit. That is direct confirmation of §Known
Breakage's "load-dependent, not deterministic" characterisation, and it means neither a
green nor a red web run should be read as evidence about that entry.

Lint set re-derived from `git status` after the final edit anywhere (a prettier `--fix`
on `notices.ts`), grouped by package: three packages carry this task's changes —
`packages/shared`, `apps/web`, `e2e` — one eslint run each, from the package directory,
exit status captured on the eslint command itself. Only `packages/shared` changed this
cycle; the other two were re-run rather than assumed. The shared suite and the web suite
both ran after that last edit, so no gate predates it.

## Criteria affected

| Criterion                                            | Verdict | Change                                                                              |
| ------------------------------------------------------ | ------- | -------------------------------------------------------------------------------------- |
| Every reason's copy contains an action clause         | met     | Both rewordings remain actions; the structural requirement is unchanged                |
| No copy names an amount, token count or threshold     | met     | Enumeration still clean over all 22 reasons                                             |
| One condition, one wording                            | met     | Distinctness assertion still passes after the rewording                                 |
| Notices never contradict the verdict                  | met     | New: no co-rendered informational offer invites a refused send or misattributes a remedy |

## Concerns

- `group_budget_pays` and `payer_switched_to_personal` now both direct the sender to the
  conversation owner. They remain distinct conditions with distinct wordings and
  distinct asks — one extends a live allocation, the other reverses a payer switch — but
  they are the closest pair in the vocabulary, and a future edit that blurs either would
  be the first place I would look for a re-merged condition.
- The co-rendering pin covers the producer's own output. A surface that renders a notice
  the producer did not pair with a block — a picker tooltip, say — is outside it; E1 owns
  that surface and its own greying tests.

## Confidence

**High.** The finding was reproducible from the copy, the fix is two strings plus a pin
watched failing first, and every gate is green — including, this run, `pnpm test:web`
outright.
