# D2 — effort badge — implementation report 1

## Objective

Surface the reasoning level D1 persists per generation on the answer itself: history read →
wire → the badge beside the model name, with `null` (no level recorded) and `off`
(reasoning resolved to none) kept apart at every layer.

## Status summary

The **history-read half is complete and pinned**. The **finish-frame half of criterion 1 was
not implemented**: it is unreachable from this task's file ownership, and the module the task's
file list names as the wire carrier (`packages/shared/src/schemas/api/sse-events.ts`) is dead
code. Evidence and the exact out-of-scope need are in *Acceptance criteria* and *Concerns*.

## Files changed

| File | Why |
| --- | --- |
| `apps/api/src/slices/conversations/adapters/stores.ts` | `reasoningTokensByContentItem` → `generationFactsByContentItem`: **one** query now returns both per-item facts; tokens sum, the level is taken. Also a `v8 ignore` on a pre-existing unreachable narrowing (see *Deviations*). |
| `apps/api/src/slices/conversations/ports/stores.ts` | `ContentItemRow.reasoningEffort: ResolvedReasoningEffort \| null`. |
| `apps/api/src/slices/conversations/domain/history.ts` | History view schema + projection gain `reasoningEffort` (`ResolvedReasoningEffort.nullable()`). |
| `apps/api/src/slices/conversations/domain/history.test.ts` | Fixture gains the now-required field. |
| `apps/api/src/slices/conversations/domain/shares.test.ts` | Same fixture requirement (public-share view ignores the field). |
| `apps/api/src/slices/conversations/routes.integration.test.ts` | Four new wire pins; `seedLlmCompletion` takes a `reasoning` object (max-params). |
| `packages/shared/src/schemas/api/conversations.ts` | `contentItemResponseSchema.reasoningEffort` optional — absent ⇔ null, `off` travels as itself. |
| `packages/shared/src/test-ids.ts` | `messageEffortChip` (literal `data-testid` is lint-banned); note added distinguishing it from the composer's `effortChip`. |
| `apps/web/src/hooks/chat/chat.ts` | History content-item type + `toContentItemResponse` map null → absent, `off` → `off`. |
| `apps/web/src/hooks/crypto/use-decrypted-messages.ts` | `pickReasoningEffort` — takes, never folds — onto the display `Message`. |
| `apps/web/src/lib/api.ts` | `Message.reasoningEffort?: ResolvedReasoningEffort`. |
| `apps/web/src/components/chat/message/message-item.tsx` | `NametagChip` extracted (Smart chip and the effort badge are now literally one chip); badge renders from `REASONING_EFFORT_LABELS`. |
| `apps/web/src/hooks/chat/chat.test.tsx`, `apps/web/src/hooks/crypto/use-decrypted-messages.test.ts`, `apps/web/src/components/chat/message/message-item.test.tsx` | The web pins. |

**Beyond the task's file list** (disclosed, non-colliding, same shape as D1's accepted excess):
`apps/web/src/hooks/chat/chat.ts`, `apps/web/src/hooks/crypto/use-decrypted-messages.ts` and
`packages/shared/src/test-ids.ts`. The first two are the middle links between `api.ts`'s type and
`message-item.tsx`'s render — the list names both ends of the chain and neither knot; the third is
forced by the lint rule banning literal test ids. None is in another live task's out-of-bounds set.

## Tests added

| Test | Behavior | Criterion |
| --- | --- | --- |
| api: `carries the persisted reasoning level on a settled AI content item` | A recorded rung reaches the wire. | 1 (history read) |
| api: `serves a reasoning-off level as off, distinct from an unrecorded one` | Two items in one message: `off` → `'off'`, no row level → `null`. | null/off, store + wire |
| api: `takes the level from the completion row that recorded one` | Three rows on one item (a level-less auxiliary charge + two steps at `max`) → `'max'`, tokens still 1204. | 3 (take-not-sum) |
| api: `gives each multi-model sibling its own resolved level` | Two sibling messages → `max` and `lite`. | 4 (multi-model) |
| web `chat.test.tsx`: `maps the persisted reasoning level from the wire` | Wire → history content item. | 1 |
| web `chat.test.tsx`: `keeps an off reasoning level rather than dropping it` | `off` is a value, not an absence. | null/off, wire→client |
| web `chat.test.tsx`: `drops a null wire reasoning level (field stays absent)` | null → absent. | null/off, wire→client |
| web `use-decrypted-messages`: `populates reasoningEffort from the content items` | Item level → message level. | 1 |
| web `use-decrypted-messages`: `keeps an off level on the message rather than dropping it` | `off` survives the pick. | null/off |
| web `use-decrypted-messages`: `leaves reasoningEffort absent when no content item recorded one` | No level → absent. | null/off |
| web `message-item`: `badges the resolved level beside the model name` | `High` badge inside the nametag container. | 2 |
| web `message-item`: `badges an off level as Min` | `off` ⇒ `Min` badge. | 2, null/off at render |
| web `message-item`: `renders no badge when no level was recorded` | Absent ⇒ no badge. | 2 |
| web `message-item`: `badges multi-model siblings with their own levels…` | Two siblings on screen show `Max` and `Lite`. | 4 |

### Reds watched, verbatim

api (`vitest run … -t "level"`, all four new tests):

```
FAIL … > carries the persisted reasoning level on a settled AI content item
FAIL … > serves a reasoning-off level as `off`, distinct from an unrecorded one
FAIL … > takes the level from the completion row that recorded one
FAIL … > gives each multi-model sibling its own resolved level
AssertionError: expected undefined to be 'high' // Object.is equality
AssertionError: expected undefined to be 'off'  // Object.is equality
AssertionError: expected undefined to be 'max'  // Object.is equality
AssertionError: expected undefined to be 'max'  // Object.is equality
      Tests  4 failed | 259 skipped (263)
```

web data chain:

```
FAIL |web| src/hooks/chat/chat.test.tsx > useMessages > maps the persisted reasoning level from the wire
AssertionError: expected undefined to be 'high' // Object.is equality
FAIL |web| src/hooks/chat/chat.test.tsx > useMessages > keeps an off reasoning level rather than dropping it
AssertionError: expected undefined to be 'off' // Object.is equality
FAIL |web| … use-decrypted-messages.test.ts > populates reasoningEffort from the content items
AssertionError: expected undefined to be 'high' // Object.is equality
FAIL |web| … use-decrypted-messages.test.ts > keeps an off level on the message rather than dropping it
AssertionError: expected undefined to be 'off' // Object.is equality
      Tests  4 failed | 79 passed (83)
```

web render:

```
FAIL |web| message-item.test.tsx > reasoning effort badge > badges the resolved level beside the model name
FAIL |web| message-item.test.tsx > reasoning effort badge > badges an off level as Min
FAIL |web| message-item.test.tsx > reasoning effort badge > badges multi-model siblings with their own levels…
TestingLibraryElementError: Unable to find an element by: [data-testid="message-effort-chip"]
      Tests  3 failed | 1 passed | 122 skipped (126)
```

**Two tests passed on their first run and are recorded as such, not as reds**: the two
"absent stays absent" assertions (`drops a null wire reasoning level`, `renders no badge when no
level was recorded`). A negative assertion is satisfied by the field not existing yet, so they
discriminate nothing on their own — their positive siblings (`keeps an off …`) are what move the
assertion the failing way, and those were red.

## Self-gate

| Command | Result |
| --- | --- |
| `vitest run apps/api/src/slices/conversations` (final, after last edit) | **pass** — 42 files, 732 tests, exit 0 |
| `vitest run apps/web/src/{components/chat/message,hooks/chat,hooks/crypto}` (final) | **pass** — 34 files, 696 tests, exit 0 |
| `vitest run packages/shared/src/schemas` | **pass** — 14 files, 479 tests, exit 0 |
| `turbo typecheck --force --continue` (repo-wide, after last edit) | **pass** — 16/16 successful, exit 0 |
| `eslint` from `apps/api` over 6 changed files | **pass** — exit 0 |
| `eslint` from `apps/web` over 7 changed files | **pass** — exit 0 |
| `eslint` from `packages/shared` over 2 changed files | **pass** — exit 0 |

`pnpm test:api` / `pnpm test:web` were **not** run (brief: G13 holds the api suite); every run above
is an isolated file/directory run, and every coverage run wrote to its own reports directory outside
the packages' coverage dirs.

### Scoped per-file coverage (one `--coverage.include` per run)

| File | Stmts / Branch / Funcs / Lines | Driving suites |
| --- | --- | --- |
| `apps/api/.../adapters/stores.ts` | 98.97 / **95.37** / 99.28 / 99.45 | whole `slices/conversations` dir (732 tests) |
| `apps/api/.../domain/history.ts` | 100 / 100 / 100 / 100 | same |
| `apps/web/src/hooks/chat/chat.ts` | 100 / 100 / 100 / 100 | `src/hooks/chat` (274 tests) |
| `apps/web/src/hooks/crypto/use-decrypted-messages.ts` | 98.88 / 98.61 / 100 / 100 | `src/hooks/crypto` |
| `apps/web/src/components/chat/message/message-item.tsx` | 99.23 / 98.02 / 97.72 / 99.17 | `src/components/chat/message` |
| `packages/shared/src/schemas/api/conversations.ts` | 100 / 100 / 100 / 100 | `src/schemas` |

Not measured, with reason: `ports/stores.ts` and `apps/web/src/lib/api.ts` (type-only additions —
no runtime code changed), `packages/shared/src/test-ids.ts` (one constant).

### First `stores.ts` measurement failed, and why the second passes

The first scoped run exited 1: **94.55% branches (104/110)**, below the 95% floor. The six uncovered
branches were at lines 197, 805, 858, 915, 979 and the `row.contentItemId === null` narrowing —
**none of them mine**; every branch my edit added was covered. Since my additions are covered, the
file was *below* the floor before this task too (removing covered branches from both numerator and
denominator lowers the ratio): the shortfall is pre-existing, not introduced.

I closed only the one inside the function I rewrote, and closed it honestly rather than by test:
`usageRecords.contentItemId` is nullable in the schema, so TypeScript demands the narrowing, but the
query's `WHERE contentItemId IN (…)` can never match a NULL — the branch is **unreachable at
runtime**, so it carries a `/* v8 ignore next -- … */` with that reason, the idiom already used
across `apps/api` (e.g. `workflows/engine/model-ports.ts`). The re-measure is 95.37% branches,
exit 0. **This is stated plainly because it is the "file crosses the gate because of what you
annotated" shape**: the other five pre-existing uncovered branches are still uncovered and belong to
the coverage workstream, not to this task.

## Acceptance criteria

**1. "The level reaches the client through the history read and the finish frame, mirroring how the
token count already does." — history read: MET. Finish frame: NOT MET (out of scope; raised).**

- History read: pinned end to end — four api integration tests over real rows through the real
  store, three web tests for wire → display `Message`.
- Finish frame: the live carrier for `reasoningTokens` is `metadata.usage.reasoningTokens` on the
  `finish` `InferenceEvent` (`packages/shared/src/inference.ts`, consumed at
  `apps/web/src/lib/chat-run.ts:226`). That metadata is `ProviderMetadata` — the provider's terminal
  facts. The resolved level is a request-side decision known only to the node executor, so carrying
  it live requires `packages/shared/src/inference.ts` **and**
  `apps/api/src/slices/workflows/nodes/model-call-execution.ts`, which is explicitly out of bounds
  for this task (D3 owns `workflows/**`). I did not make the change.
- The module this task's file list names for the wire —
  `packages/shared/src/schemas/api/sse-events.ts` — **is dead code**. An `-a` sweep of *every* symbol
  it exports (`doneContentItemSchema`, `doneEventDataSchema`, `stageDonePayloadSchema`,
  `modelTokenDataSchema`, … 18 names) finds zero consumers outside the file and its own test, and its
  doc comment points at `apps/api/src/lib/stream-pipeline.ts`, which no longer exists. So it is not a
  live wire and adding a field there would have surfaced nothing. It was left untouched.
- Consequence for behaviour today: the badge appears when the settled rows load. That is the same
  route the billed cost, the model name and the Smart chip already take — `use-authenticated-chat.ts`
  invalidates the conversation query at run-finished precisely because "billed cost is never on the
  wire". So the badge is consistent with every other settled display fact; it is simply not live
  during the stream.

**2. "The badge renders beside the model name, reusing the existing chip component; an absent level ⇒
no badge; `off` ⇒ a Min badge." — MET.** The badge renders inside the nametag container (asserted
with `within(...)`), immediately after the Smart chip. "Reusing the existing chip component" was
taken literally: the Smart chip's inline markup is now a `NametagChip` used by both, so there is one
chip implementation rather than a duplicated class string. Labels come from
`REASONING_EFFORT_LABELS`, the single id→label map, so `off` renders `Min` with no second mapping.

**3. "A test pins take-not-sum across a multi-step generation." — MET.** `takes the level from the
completion row that recorded one` seeds three completion rows on one content item — a level-less
auxiliary charge plus two agentic steps at `max` — and asserts the item serves `'max'` while the
tokens still sum to 1204. A fold over the rows, or reading the first row, yields `null`; the test
moves the failing way under either.

**4. "Each sibling's badge shows its own resolved level." — MET.** api: two sibling messages serve
`max` and `lite`. web: two `MessageItem`s rendered together produce badges `['Max', 'Lite']`.

## The null-versus-off pin, stated at each layer it crosses

- **Store** (`adapters/stores.ts`) — the fold keeps `reasoningEffort` as
  `prior?.reasoningEffort ?? row.reasoningEffort` over rows selected in the *same* query as the
  tokens, so an item whose only row has a NULL column maps to `null`, and an item whose row says
  `off` maps to `'off'`. Pinned by `serves a reasoning-off level as off, distinct from an unrecorded
  one`, which reads both cases off real rows in one response (positions 0 and 1 of one message).
- **Wire** (`domain/history.ts` → `packages/shared/.../conversations.ts`) — the api view types the
  field `ResolvedReasoningEffort.nullable()` (null is a value on the wire, `off` is a member of the
  enum); the client contract types it `ResolvedReasoningEffort.optional()` and `chat.ts` maps
  `null → absent`, everything else through unchanged. **No union was widened to hold a missing
  value** — the absent case is carried by optionality, never by a sentinel member, so the stop
  trigger did not fire. Pinned by the three `chat.test.tsx` tests (`high` maps, `off` maps,
  `null` → absent).
- **Render** (`use-decrypted-messages.ts` → `message-item.tsx`) — `pickReasoningEffort` returns the
  first item's level or `undefined`, and the badge's guard is
  `primaryMessage.reasoningEffort !== undefined`, not a truthiness test, so `off` badges as `Min`
  while absent renders nothing. Pinned by `keeps an off level on the message rather than dropping
  it`, `badges an off level as Min` and `renders no badge when no level was recorded`.

## One read, one source

The store's two facts come from a **single** `usage_records ⋈ llm_completions` query
(`generationFactsByContentItem`), the same query that already served the token count — the row set is
iterated once and folded into one map holding both facts. No surface reads the level from anywhere
else: the domain view projects it off the `ContentItemRow` the history read already carries, the
client reads it off the content item the message list already holds, and `message-item.tsx` reads it
off `primaryMessage`. Grep for producers/consumers of the level in web source returns exactly the
three files in this chain; no second query, no second fetch, no message-scoped refetch was added.

## Contract-change sweep (Global Constraint 10)

- `ContentItemRow` (new **required** field): producers/consumers are `adapters/stores.ts` (producer),
  `domain/{content-item-view,history,shares}.ts` (consumers), two test fixtures (updated). The
  public-share view projects fields explicitly, so it neither carries nor leaks the level.
- `contentItemResponseSchema` / `ContentItemResponse` (new **optional** field): consumers are
  `apps/web/src/{lib/api.ts,hooks/chat/chat.ts,hooks/crypto/use-decrypted-messages.ts,demo/mock-backend/store.ts}`.
  The demo mock backend compiles unchanged and deliberately emits no level (a demo transcript has no
  persisted generation); no other package (`scripts/`, `e2e/`, `apps/marketing`, `apps/admin`)
  references either symbol. `e2e/helpers/partial-failure.ts` declares its own structural row type and
  is unaffected.
- Repo-wide `turbo typecheck --force --continue`: 16/16 successful.

## Deviations

1. **`v8 ignore` added to a pre-existing unreachable narrowing** in the helper I rewrote — see the
   coverage section. It changes no behaviour and is annotated with the SQL reason; without it the
   file's pre-existing branch shortfall would have failed my own scoped gate.
2. **`seedLlmCompletion` signature changed** from four positionals to three plus a `reasoning`
   object, because a fifth parameter trips `max-params` (lint error, exit 1). Eleven pre-existing
   call sites in the same test file were updated mechanically.
3. **Three files outside the task's file list were edited** — listed and justified above.
4. **No E2E test written.** Global Constraint 11 keeps E2E unexecuted this run, and the badge is
   already pinned at unit and integration level; `e2e/chat/smart-model.spec.ts` is the natural home
   if the founder later wants it.

## Concerns and limitations

- **The finish-frame half is an out-of-scope need, not an omission I can close.** To make the level
  live it must ride the `finish` event: a field on `ProviderMetadata` (or a sibling event) in
  `packages/shared/src/inference.ts`, stamped in
  `apps/api/src/slices/workflows/nodes/model-call-execution.ts` (D3's tree), then threaded through
  `apps/web/src/lib/chat-run.ts` and the optimistic-message stores. That is a coherent follow-up
  task; it cannot be done from D2's ownership.
- **`packages/shared/src/schemas/api/sse-events.ts` is dead code** and the plan's D2 file list treats
  it as the live wire. Whoever sequences the follow-up should know the finish frame is
  `InferenceEvent`, not this file — and the dead module is itself a deletion candidate for whichever
  workstream owns cleanup.
- **D1's stated limitation carries through unchanged**: a `smartModel` slot pinned to a non-`off`
  wire records no level, so it shows no badge rather than a wrong one. Nothing here can detect that
  case, and the failure direction stays safe.
- **A pre-existing branch-coverage shortfall remains** on `adapters/stores.ts` (five uncovered
  branches at lines 197, 805, 858, 915, 979, all untouched by me). The file now passes its floor;
  those branches are still uncovered.
- **`routes.integration.test.ts` is concurrently modified** by the guest-funding workstream (it and
  `conversations/{routes,domain/index}.ts` were already dirty at my snapshot). My additions are
  appended inside the history `describe` and touch none of their hunks, but a merge-time collision in
  that one file is possible.

## Confidence

**High** for the history-read path: every layer has a red-first pin, the whole conversations slice
and the three web suites are green after the final edit, repo typecheck is 16/16, and per-file
coverage was measured with one include per run.

**Not applicable** to the finish-frame half — it is unimplemented and raised, not attempted.
