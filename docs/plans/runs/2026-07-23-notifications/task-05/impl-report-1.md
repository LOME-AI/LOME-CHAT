# Task 05 — Event sources + read cursor — impl report 1

## Objective

Fire `notifyEvent` for run-completion (presence-aware, from the ConversationRoom DO
terminal sink) and for membership events (added-to-conversation, fork/share activity, from
the conversations routes via `waitUntil`); add the monotonic read-cursor write route (I5)
and expose read state on the conversation payloads the client already fetches. Attempt the
membership-reader hoist.

## Files changed

New:

- `apps/api/src/slices/conversations/adapters/push-membership-reader.ts` — the hoisted
  active-user-member read (`PushMembershipReader` + `createPushMembershipReader`), in a
  module with NO `@hushbox/realtime` value import. **The hoist landed** (below).
- `apps/api/src/slices/conversations/adapters/push-membership-reader.test.ts` — the unit
  tests moved out of `realtime-room-bindings.test.ts` with the function.
- `apps/api/src/slices/conversations/ports/notify.ts` — `ConversationEventNotification`,
  `NotifyConversationEvent`, `NotifyConversationEventFactory`: the best-effort capability
  the routes fire, typed in this slice so it never imports the notifications barrel.
- `apps/api/src/slices/conversations/read-cursor.integration.test.ts` — the read-cursor
  route + read-state exposure, end-to-end over real Postgres.
- `apps/api/src/slices/conversations/membership-notifications.integration.test.ts` — which
  mutations fire the capability, with which actor/target set, and the best-effort proof.
- `apps/api/src/adapters/push-notify.integration.test.ts` — the composition-root
  capabilities over real membership/preferences/device-token rows, asserted through the
  mock transports' capture log (`listCapturedPushes`).

Modified:

- `apps/api/src/adapters/push-notify.ts` — one internal `createCategoryPushNotify(category,
  infra)`; `createRunCompletionPushNotify` (the DO sink, category `runCompletion`),
  `createChatMessagePushNotify` (unchanged behavior, category `message`),
  `createMembershipPushNotify` (new, category `membership`). The forced duplication of the
  membership query is GONE — it now imports the hoisted module.
- `apps/api/src/adapters/conversation-room.ts` — binds `createRunCompletionPushNotify`.
- `apps/api/src/app.ts` — wires `notifyConversationEvent: createMembershipPushNotify` into
  the conversations manifest.
- `apps/api/src/slices/conversations/routes.ts` — optional `notifyConversationEvent` dep;
  `notifyMembershipEvent` helper (waitUntil + swallow + warn); `PATCH
  /conversations/:conversationId/read`; three membership call sites.
- `apps/api/src/slices/conversations/domain/members.ts` — `advanceLastReadSeqTransition`.
- `apps/api/src/slices/conversations/domain/schemas.ts` — `readCursorBodySchema`.
- `apps/api/src/slices/conversations/domain/conversations.ts` — `lastReadSeq` on
  `MembershipView` and `ConversationListEntry` (bigint column → exact `number` on the wire).
- `apps/api/src/slices/conversations/ports/stores.ts` — `advanceLastReadSeq` on the members
  store; `lastReadSeq` on `MemberRecord` and `ConversationListRecord`.
- `apps/api/src/slices/conversations/adapters/stores.ts` — the `GREATEST` write; the column
  added to the member projection and the list projection.
- `apps/api/src/slices/conversations/adapters/realtime-room-bindings.ts` — reader removed,
  now imported from the hoisted module (import list trimmed accordingly).
- `apps/api/src/slices/conversations/{domain,ports}/index.ts`, `.../index.ts` — barrel wiring.
- `apps/api/src/slices/conversations/domain/test-fixtures.ts` — `lastReadSeq: 0n` default.
- Test-only edits forced by the above: `adapters/stores.integration.test.ts` (new
  read-cursor describe), `adapters/realtime-room-bindings.test.ts` +
  `.integration.test.ts` (reader tests moved / import repointed),
  `src/adapters/push-notify.test.ts` (renamed factory, repointed type import, copy assertion
  now pins the run-completion strings).

**`packages/realtime/src/**` was NOT touched** — see Deviations.

## Tests added

Read cursor (store, `adapters/stores.integration.test.ts`):

- `advances the cursor to a higher sequence` — the write applies.
- `keeps the higher cursor when the same write replays` — replay idempotency.
- `never regresses the cursor on an out-of-order lower write` — GREATEST monotonicity.
- `answers null for a caller with no active membership` — the zero-rows arm.
- `never advances another member of the same conversation` — caller-scoped WHERE (authz).

Read cursor (route + exposure, `read-cursor.integration.test.ts`):

- `advances the caller cursor to the acknowledged sequence` (200 + body).
- `converges on the same cursor when the identical write replays` — I5 replay.
- `never regresses the cursor when a lower write arrives out of order` — I5 out-of-order.
- `refuses a caller who is not an active member` (404).
- `rejects a negative sequence at the boundary` (400).
- `carries the cursor on the single-conversation membership payload`.
- `carries the cursor on the conversation list entry`.
- `defaults an unread conversation to a zero cursor`.

Run completion (`src/adapters/push-notify.integration.test.ts`, real Postgres + mock transports):

- `notifies an absent, unmuted member exactly once under the run-completion category` —
  exactly one captured send, `category: 'runCompletion'`, exactly that member's token.
- `excludes a member present at fire time` — presence snapshot suppression.
- `excludes a member who muted the conversation`.
- `excludes a member who turned the run-completion category off`.

Membership (same file): `notifies only the targeted new member under the membership
category`; `notifies every eligible member when no recipient is targeted`.

Membership event sources (`membership-notifications.integration.test.ts`):

- `notifies the added member alone when a user joins a conversation`.
- `notifies every member when a fork is created`.
- `notifies every member when a conversation is shared by link`.
- `fires no notification when the mutation itself is refused`.
- `commits the membership and answers 200 when the capability throws` — the best-effort
  proof (row committed, 200 returned, throw never reaches the request path).

Hoisted reader (`push-membership-reader.test.ts`): the three moved unit tests; its real-DB
coverage stays in `realtime-room-bindings.integration.test.ts` (import repointed) — moving
that block would have duplicated an 80-line seeding harness.

## TDD record (red verified for each)

- Store: 5 tests red — `TypeError: stores.members.advanceLastReadSeq is not a function`.
- Route + exposure: 8 tests red — the PATCH answered the 404 HTML fallback (`SyntaxError:
  Unexpected non-whitespace character after JSON`) and `body.membership.lastReadSeq` was
  `undefined`.
- Composition-root capabilities: red as a suite-load failure —
  `Cannot find module '../slices/conversations/adapters/push-membership-reader.js'` — then
  red on the missing `createRunCompletionPushNotify` / `createMembershipPushNotify` exports.
- Membership event sources: 3 tests red with `expected [] to deeply equal [ {…} ]` (no
  capability fired); the best-effort test red at `expected 500 to be 200` — which surfaced a
  real harness gap (`app.request` supplies no ExecutionContext), fixed by giving the test a
  collecting `ExecutionContext` and awaiting the collected tasks AFTER the response.

## Self-gate (all after the last edit)

| Check | Result |
| --- | --- |
| `vitest run src/slices/conversations src/adapters` | **pass** — 63 files, 872/872 |
| `vitest run` full `@hushbox/api` package (`--exclude template-html.test.ts`) | **pass** — 462 files, 6323 passed, 2 skipped, 0 failed |
| `turbo test --filter=@hushbox/realtime --force` | **pass** — 2 files, 24/24 (package untouched) |
| `tsc --noEmit` (apps/api) / `turbo typecheck --filter=@hushbox/api --force` | **pass** |
| `eslint <23 owned files>` from `apps/api`, after the last edit | **pass**, exit 0 |
| `pnpm arch:check` | **pass** — 11 rules over 1958 files |
| Coverage ≥95% per file, full-package run | see below |

Coverage, full-package run (`--coverage.include` per owned file, template-html excluded):

- `src/slices/conversations/adapters/stores.ts` — 98.97 stmts / **95.28 branches** / 100
  funcs / 100 lines. The 5 uncovered branch arms (lines 197, 858, 915, 979, 1043) are all
  pre-existing `rows[0] ?? null` / empty-list arms in code I did not touch; my
  `advanceLastReadSeq` adds one fully-covered branch, so the file's ratio moved up, not down
  (98/104 = 94.23% before → 101/106 = 95.28% now).
- Second full-package run over the remaining owned files: `routes.ts` 98.87 stmts /
  **95.17 branches** / 98.31 funcs / 99.4 lines (uncovered lines 1071, 1370 are pre-existing
  guest-read arms), and every other owned file reported at 100% and therefore omitted from
  the table — `src/adapters/push-notify.ts`, `adapters/push-membership-reader.ts`,
  `domain/members.ts`, `domain/conversations.ts`, `domain/schemas.ts`, `ports/notify.ts`.
  Aggregate over the owned set: 99.39 stmts / 97.67 branches / 99.17 funcs / 99.67 lines.
  Both full-package runs reported 462 files, 6323 passed, 0 failed.

### Attributed failures (not mine)

- `src/slices/notifications/domain/templates/template-html.test.ts` — 7 snapshot
  mismatches (a removed Google-Fonts `<link>`). `git status` shows `domain/templates/**`
  and its `__snapshots__` byte-identical to HEAD, so nothing here produced it; it is the
  concurrent email-builder workstream's red, already recorded in Task 04's reports.
- **Cross-agent test contention.** Another implementer is running suites against the same
  local Postgres/Redis/vite cache during this task (`pgrep` showed a concurrent
  `turbo test --filter=@hushbox/web` waiting on a coverage run). Three transient failures
  appeared only in multi-directory runs and never reproduced: two chat trial-quota tests, a
  chat regenerate test (`expected 201, got 400`), a chat admission test (`expected 503, got
  400`), and one `Cannot find module .vite/.../deps_ssr/@hushbox_shared.js` suite-load
  error. `src/slices/chat/routes.integration.test.ts` passes 187/187 in isolation, and the
  full-package run above passed 6323/6323, so none of them is attributable to this task.

## Acceptance criteria (checked literally)

- **"Run-completion push: integration test — run terminal settle notifies non-present,
  non-muted, prefs-on members exactly once; present users excluded; failed runs do not
  notify (only successful completion)."** — **met**, in two halves that together cover the
  sentence. (a) Who gets notified: `push-notify.integration.test.ts` fires the exact
  capability the DO sink is bound to, over real `conversation_members` /
  `notification_preferences` / `device_tokens` rows, and asserts exactly one captured send
  carrying `category: 'runCompletion'` and only the eligible member's token — with present,
  muted and category-off members each proven excluded. (b) When it fires: the terminal sink
  itself already fires only for a succeeded paid run, pinned in `packages/realtime`
  (`room-core.test.ts`: `fires push for a succeeded paid run with the sender and present
  users`, `does not fire push for a failed run`, `does not fire push for a stopped run`,
  `does not fire push for a trial run`). Those tests were already green and are unchanged;
  this task re-pointed the sink's binding to the run-completion category, so the "failed
  runs do not notify" guarantee is inherited, not re-implemented. `createRunCompletionPushNotify`
  is bound ONLY in `conversation-room.ts`, so the runless send path is untouched and stays
  `message`.
- **"Membership events: integration tests for added-to-conversation and share/fork
  activity, category `membership`."** — **met**. Sources and targets:
  `membership-notifications.integration.test.ts` (member added → the added member alone;
  fork created → every member; link shared → every member; refused mutation → nothing).
  Category: `push-notify.integration.test.ts` asserts the captured payload carries
  `category: 'membership'` for both the targeted and the untargeted shapes.
- **"`PATCH /conversations/:id/read` monotonic (GREATEST) with an idempotency test (replay +
  out-of-order writes); member read state exposed where the conversations list/member
  payload is already served."** — **met** for the server payload: five store tests and
  three route tests pin GREATEST monotonicity (replay and out-of-order lower write both
  converge on the committed maximum), and `lastReadSeq` now rides `membershipView`
  (GET /conversations/:id) and the list entry (GET /conversations), each proven by an
  integration test. **Caveat raised, not a paraphrase:** the shared client-side mirror
  schemas (`packages/shared/src/schemas/api/conversations.ts`) are outside this task's file
  ownership and still lack the field, so the client's TYPE does not yet carry it — see
  Concerns.
- **"All best-effort call sites use `waitUntil`; no notification failure can fail a domain
  transaction (test: a sender throwing does not surface)."** — **met**. Every membership
  call site goes through `notifyMembershipEvent`, which builds the capability INSIDE the
  fire-and-forget task (so even a synchronous throw from a misconfigured push sender becomes
  a caught rejection) and hands the promise to `c.executionCtx.waitUntil`. Pinned by
  `commits the membership and answers 200 when the capability throws`. The DO sink's
  equivalent guarantee is already pinned in `room-core.test.ts` (`completes the run when the
  push capability throws` / `… rejects asynchronously`).
- **Membership-reader hoist** — **LANDED**. `createPushMembershipReader` now lives in
  `adapters/push-membership-reader.ts`, which imports only `drizzle-orm`, `@hushbox/db` and
  the lib result/error helpers — no `@hushbox/realtime`, so `app.ts` can reach it without
  dragging the workerd-only DO runtime into the node environment. `push-notify.ts`'s
  `createChatPushMembershipReader` copy is deleted; `realtime-room-bindings.ts` imports the
  same function. One implementation, two consumers, no third copy.

## Deviations (with reasons)

1. **`packages/realtime/src/**` was not modified**, although the plan lists it. The DO
   terminal sink is category-blind: it hands the injected capability a
   `RoomPushNotification` and the composition root decides the category. Re-pointing the
   binding in `conversation-room.ts` is the whole change; editing `room-core.ts` would have
   been churn. `test:realtime` was run as a regression check (24/24).
2. **Membership events pass `presentUserIds: []`, not a live presence snapshot.** The plan's
   design doc allows "what the broadcast path already knows or none", and the conversations
   routes know none. Reading presence would add a DO round trip and a failure branch to
   every membership mutation; the cost of the empty snapshot is at most one redundant nudge
   to a member who is already watching (and who has just received the membership broadcast
   frame). Run-completion, which the objective calls presence-aware, keeps the DO's real
   fire-time snapshot.
3. **"Share activity" is the shared-link mint (`POST /:id/links`), not the message share
   (`POST /:id/shares`).** A link mint grants conversation access to someone outside it —
   membership-adjacent in the way the category means — and it already seats a real guest
   member row. Message shares publish one message publicly and were left out to keep the
   change minimal; adding them later is one call to the same helper.
4. **`lastReadSeq` crosses the wire as `number`, not a bigint string.** The column is
   `bigint` (Task 02), but its values are message sequences, and `messages.sequence_number`
   is `int4` — so `Number()` is exact by construction, and the client compares the cursor
   against a message's own numeric sequence. The bigint stays confined to the store port;
   `membershipView` / the list projection convert once. This is not money.
5. **`push-notify.test.ts`'s copy assertion changed target.** It asserted the `message`
   copy under a describe that now covers the run-completion factory; it now asserts the
   `runCompletion` strings. The `message` copy is still exercised through
   `createChatMessagePushNotify` and the notifications slice's own tests.
6. **One `eslint-disable catch-swallow/no-silent-catch`** on the helper's catch, with an
   inline justification, matching the identical existing carve-out on the chat route's push
   side-band. The catch is not silent — it logs `membership notification failed` with the
   conversationId — but the rule's heuristic only recognizes `throw`/`captureError`/`err`.
7. **Files edited outside the plan's Task-05 list**, each forced: `src/app.ts` (the only
   place the new dep can be bound), `src/adapters/conversation-room.ts` (the sink's
   binding), `src/adapters/push-notify.test.ts` (renamed export + repointed type import),
   `adapters/realtime-room-bindings.{test,integration.test}.ts` (the reader moved out).

## Concerns and limitations

- **OUT-OF-SCOPE NEED — the client-side mirror schemas do not carry `lastReadSeq`.**
  `packages/shared/src/schemas/api/conversations.ts` holds `membershipViewSchema`
  (documented as "Mirrors the server's `membershipView` serializer exactly") and
  `conversationListItemSchema`; the web app consumes both as TYPES (`apps/web/src/hooks/
  chat/chat.ts`). The server payload now carries the field, but until those two schemas
  gain it, Task 09's foreground read-state sync has no typed access. That package is outside
  this task's ownership and the standing amendment flags it as concurrently edited, so I did
  not touch it. Whoever takes it must also update the demo mock backend
  (`apps/web/src/demo/mock-backend/**`), because `store.test.ts` parses
  `listConversationsResponseSchema` and a required new field would fail it — make it
  `.default(0)` or emit it from the mock.
- **The read cursor has no writer in the product yet.** The route exists and is proven; the
  client call site is Task 09's.
- **Notification volume on fork/link creation is per-member, uncollapsed at the source.**
  The composite sender's per-conversation collapse alias is what keeps at most one pending
  notification per conversation on the device; that is Task 04's mechanism and it applies
  unchanged here.
- **Shared-file coordination:** `src/app.ts` is a repo-level composition root other
  workstreams touch; my edit is one dep line plus one import. The notifications slice barrel
  changed under me mid-task (Task 06's `device-token-retention` export) — I read from it,
  never wrote to it.
- **`apps/api/coverage-task05*/` directories** were produced by the coverage runs and have
  been deleted; nothing else untracked belongs to this task beyond the six new source/test
  files listed above.
- **The notifications slice moved under me mid-task.** Task 06's implementer added
  `device-token-retention` to the slice barrel and `deadTokens: []` to `push-mock.ts` while
  this task ran. My integration tests read that mock's capture log; the final full-package
  run (started after those edits) is green, but the two tasks share that seam.

## Confidence

**High** on the read cursor, the membership event sources, the category re-point, and the
hoist: every one is pinned by an integration test over real Postgres, the full `@hushbox/api`
suite is green (6323 tests) with the one documented external red excluded, and typecheck,
lint, arch:check and the per-file coverage gate all pass after the last edit. **Medium** on
the run-completion criterion only in the sense that its "failed runs do not notify" half
rests on pre-existing `packages/realtime` tests rather than a new one — the behavior is
pinned, but by tests this task did not write. The one genuinely open item is the shared
mirror-schema gap, raised above rather than silently resolved.
