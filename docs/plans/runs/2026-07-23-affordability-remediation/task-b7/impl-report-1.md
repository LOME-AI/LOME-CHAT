# B7 — Notices: typed reasons, derived copy — implementation report 1

## Objective

One money vocabulary: every condition carries a typed reason, its human sentence is
produced in exactly one place, every notice names an action, and severity is derived
from whether the condition blocks.

## Files changed

| File                                                                | Why                                                                                                       |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/affordability/notices.ts` **(new)**            | The one copy home: `NOTICE_REASONS`, `NOTICE_COPY`, `noticeText`, `noticeFor`; owns `BudgetError`/`MessageSegment` |
| `packages/shared/src/affordability/notices.test.ts` **(new)**       | The enumeration over every reason (one wording, an action, no magnitude, structural severity)              |
| `packages/shared/src/affordability/budget.ts`                       | Chooses reasons only; every sentence now comes from `notices.ts`. Payer-switch disclosure rewired to `payerSwitch` |
| `packages/shared/src/affordability/budget.test.ts`                  | Ids/copy assertions become derivation assertions; audit sections E/F/G rewritten for the new disclosure trigger |
| `packages/shared/src/error-codes.ts`                                | Seven wire messages read from the vocabulary instead of re-typing the sentence                             |
| `packages/shared/src/error-codes.test.ts`                           | Pins wire↔notice wording identity for those seven                                                          |
| `packages/shared/src/affordability/billing/client-billing.ts`       | Comment only — its docblock claimed `generateNotifications` renders `DenialReason` names, no longer true    |
| `packages/shared/src/affordability/billing/client-billing.consistency.test.ts` | Denial-reason id set and one test title follow the new vocabulary                          |
| `packages/shared/src/test-ids.test.ts`                              | Sample id argument was a retired notice name                                                              |
| `apps/web/src/components/billing/payment-form.tsx`                  | The negative-balance top-up disclosure (deficit + net credit) before submit                                |
| `apps/web/src/components/billing/payment-form.test.tsx`             | Three tests for that disclosure                                                                           |
| `apps/web/src/hooks/billing/use-prompt-budget.test.ts`              | New notice ids; the member-cap-0 case now pins the disclosure firing                                      |
| `apps/web/src/components/chat/input/prompt-input.test.tsx`          | New ids; render fixtures no longer reproduce retired product copy                                         |
| `apps/web/src/components/chat/budget/budget-messages.test.tsx`      | Same — fixtures made obviously synthetic                                                                  |
| `apps/web/src/stores/chat-error.test.ts`                            | Asserted a re-typed copy of `CONCURRENT_RUN`; now asserts pass-through                                    |
| `e2e/helpers/link-assertions.ts`, `e2e/group/group-chat-billing.spec.ts` | Notice ids in test-id builders                                                                        |
| `e2e/chat/smart-model.spec.ts`, `e2e/chat/trial-chat.spec.ts`       | Copy assertion / comment carrying retired wording                                                         |
| `e2e/sharing/link-guest-chat.spec.ts`                               | Asserted "Top up" is absent for a guest; the premium CTA is now "Add credit", so the guard had gone vacuous |

## The vocabulary — every reason and its single wording

Severity is declared once (`blocking` yes/no) and `type` is computed from it.

**Blocking (rendered `error`, non-dismissible)**

| Reason                          | Wording                                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `premium_requires_account`      | This model is available with an account. **Sign up** to chat with premium models.                                             |
| `premium_requires_credit`       | Premium models run on a paid balance. **Add credit** to unlock them.                                                          |
| `trial_message_cap_exceeded`    | This message is too costly for the free trial. Shorten it, or **sign up** to keep chatting.                                   |
| `insufficient_funds`            | Your balance can't cover this message. **Add credit**, or choose a more affordable model.                                     |
| `prompt_too_long`               | This conversation is too long for the selected model to answer. Shorten your message, start a new conversation, or choose a model that reads more. |
| `model_output_cap_too_low`      | This model can't write a usable answer for a conversation this size. Choose a different model.                                |
| `option_not_offered`            | The selected model doesn't offer that setting. Choose a different setting, or a different model.                              |
| `model_not_priceable`           | This model isn't available to send to right now. Choose a different model.                                                    |
| `modality_not_priceable`        | The selected model can't produce this kind of content. Choose a different content type, or a different model.                 |
| `free_allowance_exhausted`      | Your free daily allowance can't cover this message. **Add credit**, or come back tomorrow.                                    |
| `guest_no_group_budget`         | No budget is allocated to you in this conversation. Ask the conversation owner to allocate some.                              |
| `group_owner_funds_unavailable` | The conversation owner's budget can't cover this message. Ask the conversation owner for budget, or try again shortly.        |
| `funds_held_by_run`             | Your funds are reserved by a reply that's still generating. Wait for it to finish, then send again.                           |
| `run_already_in_progress`       | This conversation is already generating a reply. Wait for it to finish, then send again.                                      |
| `conversation_read_only`        | You have read-only access to this conversation. Ask the conversation owner for permission to send.                            |

**Informational (dismissible)**

| Reason                       | Tone    | Wording                                                                                                       |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `payer_switched_to_personal` | info    | This message will be charged to your own balance. Ask the conversation owner for budget to change that.         |
| `group_budget_pays`          | info    | You won't be charged — the conversation owner's budget covers your messages. Send when you are ready.           |
| `free_allowance_pays`        | info    | This message uses your free daily allowance. **Add credit** for longer conversations.                          |
| `trial_preview_pays`         | info    | You are chatting in the free preview. **Sign up** for full access.                                              |
| `context_near_capacity`      | warning | This conversation is getting long for the selected model, so replies may be cut short. Start a new conversation to keep full-length replies. |
| `answer_may_be_shortened`    | warning | Your balance is running low, so replies may be shortened. **Add credit** for longer replies.                    |

Bold = the linked segment. Every row's second sentence is the action clause, which is a
non-empty tuple field on the entry type — an action-less entry does not typecheck.

### Evidence that no condition has two phrasings left anywhere

1. **Structural:** `NOTICE_COPY` is `Record<NoticeReason, NoticeCopy>`; one entry per
   reason, so "two wordings for one reason" is unrepresentable.
2. **Pairwise distinct:** `notices.test.ts` "gives every reason exactly one wording,
   shared with no other reason" asserts `new Set(wordings).size === wordings.length`.
3. **The wire end derives:** `error-codes.test.ts` "words each shared condition once"
   asserts `friendlyErrorMessage(code) === noticeText(reason)` for
   `INSUFFICIENT_ADMISSION`, `MODEL_TIER_LOCKED`, `PREMIUM_REQUIRES_ACCOUNT`,
   `GROUP_BUDGET_EXHAUSTED`, `TRIAL_MESSAGE_TOO_EXPENSIVE`, `CONCURRENT_RUN`,
   `CONTEXT_LENGTH_EXCEEDED`. Those seven no longer hold a literal string.
4. **The notice end derives:** `budget.test.ts` asserts whole-object equality against
   `noticeFor(reason)` for the denial, funding-source, group and read-only notices — no
   literal sentence remains in that suite.
5. **Repo sweep:** grepping the retired sentences ("Insufficient balance", "Free
   preview", "Using free allowance", "memory limit", "read-only access", "already
   generating a response", "balance or budget is too low", "premium model needs
   credits", "No group budget is left", "exceeds the usage limit", "No budget
   allocated", "won't be charged", "Allocated budget used up") over `apps`, `packages`,
   `e2e`, `scripts` returns only `notices.ts` itself. Two live re-typings were found and
   removed by this sweep: `apps/web/src/stores/chat-error.test.ts` held the
   `CONCURRENT_RUN` sentence, and web render fixtures reproduced four retired sentences
   verbatim.

### Collapses performed, and the ones deliberately refused

**Collapsed** (one condition that had several phrasings):

- balance-too-low: `INSUFFICIENT_ADMISSION` + `insufficient_balance` notice +
  `RefusalCode.insufficient_funds` (which had no copy) → `insufficient_funds`.
- premium-locked: `MODEL_TIER_LOCKED` + `premium_requires_balance` notice →
  `premium_requires_credit`; `PREMIUM_REQUIRES_ACCOUNT` stays its own condition (below).
- guest-has-no-budget: `GROUP_BUDGET_EXHAUSTED` + `guest_budget_exhausted` notice →
  `guest_no_group_budget`.
- too-long: `capacity_exceeded` notice + `CONTEXT_LENGTH_EXCEEDED` +
  `RefusalCode.prompt_too_long` → `prompt_too_long`. Same cause, same action set.

**Refused, because collapsing would change which condition the user sees:**

- `insufficient_funds` vs `free_allowance_exhausted`. The free-tier condition carries an
  action the paid one does not ("come back tomorrow"), and §Notices 3 makes the action
  the point of the notice.
- `premium_requires_account` vs `premium_requires_credit` — B3's split, which I agree
  with and kept. Different actions (sign up / add credit) reach different users;
  `error-codes.test.ts` already pinned those two as distinct copy before this task.
- `funds_held_by_run` vs `insufficient_funds` — required distinct by §Notices 9.
- `run_already_in_progress` vs `funds_held_by_run` — same action, different cause; the
  first is this conversation, the second is the payer's money elsewhere.

`option_not_offered` got copy that names a *setting*, not a rung, per the brief's note
that it is now reachable only via a pinned id outside the declared domain.

## Acceptance criteria

| Criterion                                                                | Verdict | Evidence                                                                                                                                                                     |
| ------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Copy derives from the typed reason in one place; enumeration test asserts exactly one wording per reason | met | `notices.ts` is the only table; `notices.test.ts` §"the notice vocabulary" (7 tests) enumerates `NOTICE_REASONS`                                          |
| **Every** reason's copy contains an action clause                        | met     | `action` is `readonly [MessageSegment, ...MessageSegment[]]` (structural) + `notices.test.ts` "gives every reason an action clause" over the enumeration                       |
| No copy names an amount, a token count or a threshold                    | met     | `notices.test.ts` "names no amount, token count or threshold in any wording" — regex `\d\|[$¢%]\|tokens?\|cents?\|dollars?\|thresholds?\|limits?` over cause + action, every reason |
| Severity structural and biconditional; blocked send always carries a notice; a notice never blocks a permitted send | met | `notices.test.ts` §"severity is structural" (3 tests, both directions) + `budget.test.ts` §"severity tracks the verdict in both directions" (3 tests: every denial → exactly one error; read-only → one error; every approved source at red capacity and low tokens → no error) |
| Precedence money-then-length, pinned where both would be true            | met     | `notices.test.ts` §"precedence between money and length" — `refusalPrecedence(['prompt_too_long','insufficient_funds'])` renders the money wording                            |
| Hold ≠ balance copy; hold action is "wait"; no payment path; names no conversation | met | `notices.test.ts` §"a hold is not poverty" (4 tests)                                                                                                                    |
| The guest reason implies no top-up path                                  | met     | `notices.test.ts` "gives a guest with no allocation no top-up path" — no segment links `ROUTES.BILLING`, and the action names the owner                                       |
| Payer-switch disclosure fires for no-allocation as well as ran-out       | met     | `budget.ts` reads `billingResult.payerSwitch`; `budget.test.ts` has both cases plus a negative; `use-prompt-budget.test.ts` pins it at the hook with `capNanoUsd: '0'`         |
| Disclosure fires on `payerSwitch: 'group_headroom_insufficient'`         | met     | F2's constant is wired directly; no new value invented                                                                                                                        |
| Concurrent-run refusal has a typed reason, one wording, an action        | partial | `run_already_in_progress` exists with one wording and an action, and `CONCURRENT_RUN` derives from it. The **per-wallet** concurrent-run cap is still collapsed server-side — see Deviations |
| Owner's-wallet-moved group refusal gets its own typed reason             | partial | `group_owner_funds_unavailable` exists with copy that names the owner, no magnitude and no disclosure of owner activity. It has **no producer yet** — see Deviations           |
| Top-up against a negative balance discloses deficit and net credit       | met     | `payment-form.tsx` `negativeBalanceDisclosure`; three tests in `payment-form.test.tsx` (deficit + net credit, deficit alone before an amount is entered, silent when non-negative) |
| The notices that named a cause with no action gain one                   | met     | Six did, not three: capacity warning, low balance, delegated-budget-active, delegated-budget-exhausted, read-only, guest. All now carry actions structurally                   |

## Self-gate

| Command                                                                              | Result                     |
| ------------------------------------------------------------------------------------ | -------------------------- |
| `pnpm test:shared`                                                                   | pass — 128 files, exit 0   |
| `pnpm test:web`                                                                      | 395/395 test files pass; the run exits 1 **only** on the §Known Breakage `markdown-renderer.tsx` branch-coverage entry (75% < 95%) — that file is unmodified vs `HEAD` (`git diff --stat HEAD` empty) and untouched by this task |
| `npx turbo typecheck --force --continue`                                             | pass — 16/16, uncached     |
| `eslint <9 changed files>` from `packages/shared`                                    | exit 0                     |
| `eslint <6 changed files>` from `apps/web`                                           | exit 0                     |
| `eslint <5 changed files>` from `e2e`                                                | exit 0                     |

Per-file coverage on the files this task owns (from the suite runs):
`notices.ts` 100/100/100/100 · `budget.ts` 100/100/100/100 · `error-codes.ts`
100/100/100/100 · `payment-form.tsx` 100 stmt / 95.74 branch / 100 fn / 100 line.

The lint set was derived from `git status` after the last edit anywhere, filtered to the
files this task changed: three packages present (`packages/shared`, `apps/web`, `e2e`),
one run each, from the package directory, exit status captured on the eslint command
itself. `git status` also lists `apps/api`, `apps/admin`, `apps/marketing`,
`packages/config`, `packages/db`, `packages/ui` and `scripts` — none of those carry a
change from this task; they belong to the concurrent workstreams named in §Known
Breakage.

TDD: `notices.test.ts` was written first and watched fail on the missing module;
`budget.test.ts`'s rewrite was watched fail 68/83 before `budget.ts` was rewritten; the
`error-codes.ts` derivation test was watched fail on the old `INSUFFICIENT_ADMISSION`
sentence; the payment-form tests were watched fail 2/3 (the third — "says nothing when
the balance is not negative" — passes vacuously before the feature exists, which is
noted rather than claimed as red).

## Deviations, with reasons

1. **The per-wallet concurrent-run cap still collapses to `INSUFFICIENT_ADMISSION`.**
   `AdmissionRefusalReason` (`apps/api/src/slices/billing/domain/admission.ts:53`) is
   `'insufficient-balance' | 'run-cap' | 'budget-exceeded'`, and
   `apps/api/src/slices/chat/domain/runtime.ts:613` deliberately maps all three onto one
   wire code. So three conditions share one wording — the inverse of §Notices 2 — and a
   run-cap refusal reads "Your balance can't cover this message", which is false. The
   typed reason and copy for the condition the user actually meets (one run per
   conversation → `CONCURRENT_RUN`) are delivered; separating the per-wallet cap needs an
   emitter change in `apps/api`, which is outside B7's file list and scoped checks.
2. **`group_owner_funds_unavailable` and `funds_held_by_run` have copy but no producer.**
   Both are required by B7's criteria as typed reasons; neither is emitted yet. The
   owner-funds refusal needs the same `apps/api` un-collapse as (1); the held-funds
   notice is a client-surface condition E1–E3 will render from the produced
   `TurnOptions`. They are vocabulary entries, which is what §Extending calls for, but
   an auditor should not expect to find a call site.
3. **Read-only became a blocking error rather than an info notice.** The biconditional
   criterion is explicit, and a read-only member's send *is* blocked
   (`use-prompt-budget.ts` already ORs it into `hasBlockingError`). The visible change:
   the read-only bar renders as a non-dismissible error instead of a dismissible hint,
   and it gained an action ("Ask the conversation owner for permission to send").
4. **The payer-switch disclosure no longer appears on a refused send.** It previously
   fired from `hasDelegatedBudget` and rode denials "for context". `payerSwitch` is set
   only on an approved fall-through, so a denial now states its refusal alone. This is
   what §Notices 5 asks for ("the send succeeds — so it never enters the refusal
   vocabulary"), and it deleted the guest-suppression special case in `budget.ts`.
   `budget.test.ts` sections E/F/G were rewritten around this; section G's premise (a
   guest falling through to `trial_fixed` while holding a delegated budget) was replaced
   with the real guest behaviour — refused, never switched — per the brief's note that a
   trial-tier group fall-through is unreachable today.
5. **Notification `id` values are now the typed reason.** The id was a second name for
   the same fact. Renaming rippled into web tests and five e2e files (ids inside
   `TEST_ID_BUILDERS.budgetMessage(...)`). No criterion demanded it; leaving it would
   have left the vocabulary two-named.
6. **The top-up disclosure's copy lives in the payment surface, not in `notices.ts`.**
   It interpolates two amounts, so it cannot live in a table whose enumeration test
   forbids magnitudes. It is a §Fee Structure payment disclosure, not a refusal —
   §Notices 6's no-magnitude rule governs refusals — and it is not keyed by a reason, so
   it is outside the "one wording per condition" enumeration by construction. Recorded
   here because it is the one user-facing money sentence this task did not single-home.
7. **No barrel changes.** `notices.ts` is consumed intra-package by `budget.ts` and
   `error-codes.ts`; nothing new is exported from `packages/shared/src/index.ts` (B8
   owns that file) or from `affordability/index.ts`. B8 owns landing `notices(decision,
   options)` as a documented export, including whatever name reconciliation that needs.

## Concerns and limitations

- **`generateNotifications` is still the producer's name.** §The public surface
  documents `notices(decision, options)`. Renaming is B8's explicitly-owned naming
  question, so it was left alone; the signature also differs (it takes context, not a
  `decision`/`options` pair), which is exactly the mismatch B8 is told to report rather
  than paper over.
- **E2E copy assertions re-type sentences.** `e2e/chat/smart-model.spec.ts` matches
  `/free daily allowance can't cover this message/i` and
  `e2e/sharing/link-guest-chat.spec.ts` matches `Add credit`. A UI assertion has to name
  the text it expects, and the vocabulary is not reachable from `e2e` without a root
  barrel export (B8-owned). If B8 exports the vocabulary, these two are worth deriving.
- **`prompt_too_long`'s copy now serves three former conditions**, one of which is a
  provider-returned error (`CONTEXT_LENGTH_EXCEEDED`). Its action mentions choosing "a
  model that reads more" precisely so the provider case keeps the remedy its old copy
  named. If a future reader thinks the wording is doing two jobs, the collapse rationale
  is above rather than in a code comment.
- **The magnitude regex bans the word "limit"**, which is why no wording says "usage
  limit" or "memory limit". That is a deliberate reading of "no threshold", stricter
  than the letter of §Notices 6; a copy author who wants the word will hit a test.
- The web suite's exit code cannot be used as a gate while the `markdown-renderer.tsx`
  coverage entry stands; this task's judgment rests on the file list and the per-file
  numbers, as §Known Breakage instructs.

## Confidence

**High** on the vocabulary, the derivation and the structural properties — they are
enumerated over the closed reason set and pinned at both ends, and the whole shared
suite plus a repo-wide typecheck are green.

**Medium** on two criteria marked partial above: the concurrent-run-cap and
owner-funds-moved conditions have their typed reason and wording, but the server still
collapses both into `INSUFFICIENT_ADMISSION`, so the user does not yet see them. Whether
that satisfies B7 or needs a follow-up in `apps/api` is the orchestrator's call.
