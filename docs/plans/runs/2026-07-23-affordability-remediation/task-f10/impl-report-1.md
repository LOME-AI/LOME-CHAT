# F10 — Premium-derived model surfaces read the payer's snapshot

## Objective

`use-resolve-default-model.ts` and `use-model-validation.ts` both called the **unscoped**
funding door (`useSpendable(null)`). For a link guest that query is disabled, so premium
access resolved to `false` and the guest's default model and strongest-model text were chosen
as if the payer had no premium access — while the composer graded the same guest at the
payer's tier. An owner-funded **member** was misgraded identically. Both surfaces now read the
payer-scoped snapshot, and premium availability at them matches the option sets the composer
produces for the same caller.

## Files changed

| Path                                                     | Why                                                                                                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/hooks/models/use-payer-premium-access.ts` (new) | The single derivation of "can the payer of this conversation reach premium models", plus the pending gate. Both surfaces read it, so they cannot disagree. |
| `apps/web/src/hooks/models/use-resolve-default-model.ts`  | Takes the funding scope; premium reach now comes from the payer's snapshot through the shared hook. Its own `useSession` / `useSpendable(null)` reads are gone. |
| `apps/web/src/hooks/models/use-model-validation.ts`       | Same. `getValidationState` and its `servedTier` parameter deleted — that logic is now the shared hook, not a second copy.                     |
| `apps/web/src/components/shared/app-shell.tsx`            | Supplies the funding scope the shell has: the route's conversation (`$id` on chat, `$conversationId` on the share route), `null` for `new` / no conversation. |
| `apps/web/src/components/chat/layout/chat-layout.tsx`     | Passes the composer's own `conversationId`, so the resolver and the option sets read one cache entry. `conversationIdOrNull` hoisted so the added `??` replaces the existing one (complexity stays at 10). |
| `apps/web/src/components/chat/page/chat-welcome.tsx`      | Passes `null` — the welcome screen precedes any conversation.                                                                                |
| `apps/web/src/hooks/models/use-resolve-default-model.test.ts` | New reds + existing call sites given an explicit scope; `hasServedFunding` kept real via `importOriginal`.                                |
| `apps/web/src/hooks/models/use-model-validation.test.ts`  | Same.                                                                                                                                        |
| `apps/web/src/hooks/models/use-model-validation.loop.test.ts` | Mock lifted to `importOriginal` (the hook's dependency moved deeper).                                                                     |
| `apps/web/src/components/shared/app-shell.test.tsx`       | Pins which scope the shell hands to model validation, over all four route shapes.                                                            |

## Design notes

**Why a shared hook rather than two edits.** The two surfaces must answer the same question
identically — they interact (the validator drops a selection, the resolver refills it) and both
must agree with the option sets. Writing `tierCanAccessPremium(served.payerTier)` plus a pending
gate twice is the mirrored-logic shape Global Constraint 5 bans. One hook, two readers.

**Why the scope is a parameter, not a router read inside the hooks.** Every conversation-scoped
hook in this repo takes the id (`useSpendable`, `useResolveBilling`, `useGroupChat`,
`useClearConversationNotifications`). Measured, not assumed: `useParams({ strict: false })`
**throws** outside a `RouterProvider` (`TypeError: Cannot read properties of null (reading
'isServer')`, probe run and deleted), so a router read inside a leaf hook would have forced a
router mock into every tree that renders `ChatLayout` or `ChatWelcome` — including
`components/chat/input/chat-prompt-input.test.tsx`, which is F4's territory. Keeping the read at
`AppShell` (the one caller with no other source, and the same position `sidebar.tsx` reads it
from) needed **no** test change: `app-shell.test.tsx` already mocks `useParams`.

**The funding read count went down, not up.** `useSpendable` keys on the scope, so on
`/chat/<id>` these two surfaces now land on the same cache entry as `useResolveBilling`,
`useBudgetCalculation` and `useTurnOptions` — one request. Before, `useSpendable(null)` from the
model hooks was a **second** cache entry alongside the composer's scoped one. The
stop-and-report trigger for a second read is therefore not met; the change removes one.

## Tests added

| Test                                                                                        | Behaviour                                                                       | Criterion |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------- |
| `use-resolve-default-model` › picks an owner-funded member's default from the owner's paid tier | Member in an owner-funded conversation gets the premium default the owner can reach | payer-scoped read; member pinned |
| `use-resolve-default-model` › picks an owner-funded link guest's default from the owner's paid tier | Guest, unscoped door closed, gets the owner's premium default                    | payer-scoped read; guest pinned |
| `use-resolve-default-model` › waits for the payer snapshot of a link guest instead of defaulting below it | Guest with a door but no snapshot yet chooses nothing (the resolver runs once) | availability matches the option sets |
| `use-resolve-default-model` › leaves a solo self-funded caller reading its own unscoped door | Solo caller still reads `useSpendable(null)` and still gets its own tier's answer | solo unchanged |
| `use-model-validation` › substitutes the strongest model an owner-funded member's payer can reach | Dropped text selection refilled from the owner's tier                          | payer-scoped read; member pinned |
| `use-model-validation` › substitutes the strongest model an owner-funded link guest's payer can reach | Same for a guest                                                             | payer-scoped read; guest pinned |
| `use-model-validation` › rewrites nothing for a link guest whose payer snapshot has not arrived | No selection rewrite from a tier that was never served                         | availability matches the option sets |
| `use-model-validation` › leaves a solo self-funded caller reading its own unscoped door      | Unchanged for a solo caller                                                       | solo unchanged |
| `app-shell` › is the open conversation on a chat route                                       | `$id` becomes the funding scope                                                   | payer-scoped read |
| `app-shell` › is the shared conversation on the link-guest share route                       | `$conversationId` becomes the funding scope                                       | guest pinned |
| `app-shell` › is none for a conversation that does not exist yet                             | `new` is not a conversation                                                       | solo unchanged |
| `app-shell` › is none on a route that names no conversation                                  | Non-chat routes read the caller's own door                                        | solo unchanged |

### Reds, watched, verbatim

`use-resolve-default-model.test.ts` before the fix — the member and guest surfaces chose nothing
(only a premium model existed and they graded at the sender's tier), and the pending guest chose
the cheaper model and would never revisit it:

```
 FAIL  |web| src/hooks/models/use-resolve-default-model.test.ts > useResolveDefaultModel > the payer, not the sender, decides which default is reachable > picks an owner-funded member's default from the owner's paid tier
AssertionError: expected "vi.fn()" to be called with arguments: [ 'image', …(1) ]

Number of calls: 0

 FAIL  |web| src/hooks/models/use-resolve-default-model.test.ts > useResolveDefaultModel > the payer, not the sender, decides which default is reachable > picks an owner-funded link guest's default from the owner's paid tier
AssertionError: expected "vi.fn()" to be called with arguments: [ 'image', …(1) ]

Number of calls: 0

 FAIL  |web| src/hooks/models/use-resolve-default-model.test.ts > useResolveDefaultModel > the payer, not the sender, decides which default is reachable > waits for the payer snapshot of a link guest instead of defaulting below it
AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times

 Test Files  1 failed (1)
      Tests  3 failed | 13 passed (16)
```

`use-model-validation.test.ts` before the fix — same three shapes on the strongest-model text
fallback:

```
       × substitutes the strongest model an owner-funded member's payer can reach 4ms
       × substitutes the strongest model an owner-funded link guest's payer can reach 2ms
       × rewrites nothing for a link guest whose payer snapshot has not arrived 3ms
AssertionError: expected "vi.fn()" to be called with arguments: [ 'text', …(1) ]
Number of calls: 0
AssertionError: expected "vi.fn()" to be called with arguments: [ 'text', …(1) ]
Number of calls: 0
AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times
Number of calls: 1
 Test Files  1 failed (1)
      Tests  3 failed | 17 passed (20)
```

`app-shell.test.tsx` before the shell supplied a scope (implementation reverted by hand and
re-written after the red, per TDD):

```
       × is the open conversation on a chat route 16ms
       × is the shared conversation on the link-guest share route 10ms
AssertionError: expected "vi.fn()" to be called with arguments: [ 'conv-7' ]
AssertionError: expected "vi.fn()" to be called with arguments: [ 'conv-shared' ]
 Test Files  1 failed (1)
      Tests  2 failed | 18 passed (20)
```

**Both solo pins passed before and after** — they characterize the no-move requirement rather
than driving a change, and are labelled as such rather than presented as reds.

## Self-gate

| Command                                                                                                   | Result |
| ----------------------------------------------------------------------------------------------------------- | ------ |
| `vitest run src/hooks/models src/components/shared/app-shell.test.tsx src/components/chat/layout src/components/chat/page src/routes/_app` (after final edit) | pass — 29 files / 580 tests, exit 0 |
| `vitest run src/components src/routes src/hooks` (broad web sweep)                                          | 261 files / 4570 tests **passed**, exit 1 — see attribution below |
| `vitest run src/hooks/models --coverage --coverage.include='src/hooks/models/**'`                            | the three owned files 100 % stmts / 100 % branch / 100 % funcs |
| `vitest run src/components/shared/app-shell.test.tsx --coverage --coverage.include='src/components/shared/app-shell.tsx'` | 100 % / 100 % / 100 %, exit 0 |
| `vitest run src/components/chat src/routes --coverage --coverage.include='src/components/chat/**'`           | `chat-layout.tsx` 100/100/100 · `chat-welcome.tsx` 100/95.83/100 (both above the floor) |
| `npx turbo typecheck --force --continue` (repo-wide, uncached)                                              | pass — 16/16 |
| `npx eslint --fix <all ten changed files>` from `apps/web`, after the last edit                             | pass — exit 0 |

`pnpm test:web` was **not** run: the brief forbids it while other agents are live (shared
coverage directory). Every figure above comes from a scoped run with its reports directory
redirected out of `apps/web/coverage`.

### Failures attributed outward

- **Broad sweep exit 1 with zero test failures.** One unhandled error, from
  `src/components/auth/two-factor-setup.test.tsx`: `ReferenceError: window is not defined` inside
  an `input-otp` `setTimeout` firing after teardown. Not mine — the file passes in isolation
  (31/31, exit 0), and a grep of both the test and its component for `AppShell`,
  `useModelValidation`, `useResolveDefaultModel`, `ChatLayout`, `ChatWelcome` returns **zero**
  hits, so nothing I changed is in its module graph.
- **`markdown-renderer.tsx` branches 75 %** in the chat coverage run — the standing
  load-dependent entry in §Known Breakage, file untouched.
- **`use-premium-model-click.ts` / `use-selected-model-capabilities.ts`** below floor in the
  models-only coverage run: the documented narrow-suite denominator artifact (their driving
  suites live outside `src/hooks/models`). Both files unchanged by this task.

## Acceptance criteria

1. **Both surfaces read the payer-scoped snapshot — met.** Both now obtain premium reach from
   `usePayerPremiumAccess(conversationId)`, which calls `useSpendable(conversationId)`. Neither
   file mentions `useSpendable` any more.
2. **Premium availability at the surface matches the produced option sets for the same caller —
   met.** The option sets read `useSpendable(conversationId)` in `use-turn-options.ts:203`; these
   surfaces now read the same hook with the same scope, hence the same cache entry and the same
   `payerTier`. The pending gate is the same shared predicate (`hasServedFunding`) the adapter
   hook uses at `use-turn-options.ts:212`, so neither surface can answer from a snapshot the
   composer is still waiting on.
3. **Pinned for an owner-funded member and an owner-funded guest — met.** Four tests, two per
   surface, each red before the change (transcripts above).
4. **No surface calls the unscoped door for a premium decision — met.** Binary-inclusive sweep,
   `grep -rnaE "useSpendable\(\s*(null|undefined)?\s*\)" apps packages e2e scripts`: the only
   remaining source hits are inside `apps/web/src/hooks/billing/use-spendable.test.ts` (F4's own
   tests of the solo scope, not a premium decision). The other hits are in `apps/web/dist/**`, a
   stale build artifact. The `-a` flag was used on every sweep in this task, per the ugrep NUL
   caveat.
5. **Solo self-funded experience unchanged — met.** Two characterization pins assert both that
   `useSpendable` is still called with `null` for a solo caller and that the resulting choice is
   unchanged; both passed before and after. `hasServedFunding(true, …)` is `true` for any scope,
   so an authenticated caller's pending gate is byte-for-byte the old `isAuthenticated` gate.

## Deviations

- **Three component files outside the plan's `Files:` line were edited**:
  `components/shared/app-shell.tsx`, `components/chat/layout/chat-layout.tsx`,
  `components/chat/page/chat-welcome.tsx` (plus `app-shell.test.tsx`). Making the hooks
  payer-scoped requires a scope to be supplied, and the plan's file list names only where the
  defect lives. None of the three is in another live task's territory (F4 owns
  `components/chat/input/**`, not `layout/` or `page/` or `shared/`). Raised to the orchestrator.
- **A third hook file was added** (`use-payer-premium-access.ts`) rather than editing only the two
  named. Reason under Design notes: the alternative is the same predicate written twice.
- **No dedicated test file for the new hook.** Its every branch is driven to 100 % through the two
  consumers, including both pending arms, and a separate file would re-assert the same behaviour
  one level lower. Stated rather than assumed: the JSON coverage report shows 100 % statements,
  branches and functions for it.

## Concerns and limitations

- **A fourth premium authority exists and is dead, pre-existing.** `useTierInfo()`
  (`hooks/billing/use-tier-info.ts`) derives `canAccessPremium` from the **balance** endpoint —
  the sender's, never the payer's. Its only consumer is `chat-layout.tsx:260`, which feeds it to
  `resolveChatLayoutDerivedState`, whose `canAccessPremium` output is **never destructured** at
  `chat-layout.tsx:288-295`. So it decides nothing today. It is not the unscoped funding door,
  so the third-surface stop trigger did not fire; it is reported rather than removed because
  deleting live-looking code is outside this task and `useTierInfo` may have an intended reader.
- **`'new'` as the pre-creation route id is now spelled in a sixth place** (`app-shell.tsx`),
  joining `chat.$id.tsx`, `chat.index.tsx`, `auth-chat-helpers.ts`, `use-authenticated-chat.ts`
  and `authenticated-chat-page.tsx`. There is no shared constant for it; introducing one would
  touch five files this task does not own.
- **The create hop is the one window where the shell's scope and the composer's differ.** While
  the route still says `/chat/new` and the composer has already resolved the real id, the shell
  reads `null`. Both answer *self* there — a conversation just created is owned by its creator —
  so the tier is identical and only the cache key differs, transiently. `useResolveDefaultModel`
  is unaffected: `ChatLayout` passes the composer's own value.

## Confidence

**High.** Every criterion is pinned by a test watched red for the stated reason; the two
no-move requirements are pinned by tests that passed on both sides; the negative claim is a
binary-inclusive sweep; repo-wide typecheck and the lint gate are green after the last edit; and
the one non-green exit is a teardown timer in a file provably disjoint from everything changed.
