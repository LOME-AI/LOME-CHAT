# Task 09 — Foreground layer + dismissal clearing — impl report 3 (founder-ruling round)

## Objective

Implement the founder ruling of 2026-07-24: **delete the dead SW→page `push-event` path.**
The service worker posted `{type:'push-event', payload}` only to *focused* clients, while the
activity store counts only while the user is *away* — mutually exclusive, so the page-side
intake could never fire in production. Semantics are unchanged (a present user gets no
signal); the unreachable code is gone rather than shipped.

Authorized to cross two tasks' files for this one change: the SW (`apps/web/src/sw/**`,
Task 07's) and the page-side intake (`apps/web/src/hooks/notifications/**`, Task 09's).

## Files changed

| File                                                             | Why                                                                                    |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `apps/web/src/sw/handlers.ts`                                     | `handlePush` no longer posts to focused clients; the focused-client **suppression stays** |
| `apps/web/src/sw/handlers.test.ts`                                | the forwarding test became two: suppression retained, "hands a focused client nothing"   |
| `apps/web/src/hooks/notifications/use-activity-reset.ts`          | replaces `use-activity-intake.ts` with the message listener, its schema and imports gone |
| `apps/web/src/hooks/notifications/use-activity-reset.test.ts`     | replaces `use-activity-intake.test.ts`; the five push-intake tests are gone              |
| `apps/web/src/hooks/notifications/use-activity-intake.ts`         | **deleted**                                                                             |
| `apps/web/src/hooks/notifications/use-activity-intake.test.ts`    | **deleted**                                                                             |
| `apps/web/src/components/notifications/notification-activity-layer.tsx`      | calls the renamed hook; docstring no longer claims it collects activity   |
| `apps/web/src/components/notifications/notification-activity-layer.test.tsx` | drove the layer through the deleted path; now drives it through the store |
| `apps/web/src/hooks/notifications/use-conversation-activity.ts`   | docstring orphan: it named the worker-forwarded pushes as the other feed                 |

Nothing else was touched. No file outside `apps/web/src/sw/**` and the Task 09 client surface
was edited; `packages/shared` was not edited (see §Shared schema below).

## 1. The SW side

`handlePush` before (`handlers.ts:99–124`):

```ts
/**
 * Validate the push body, then either hand it to a focused tab (which renders it
 * in-app) or raise a generic, content-free OS notification tagged by conversation
 * so a newer push for the same conversation collapses onto the older one.
 */
export async function handlePush(scope: ServiceWorkerScope, event: PushEventLike): Promise<void> {
  const parsed = pushEventPayloadSchema.safeParse(readPushData(event));
  if (!parsed.success) return;
  const payload = parsed.data;

  const windows = await scope.clients.matchAll(WINDOW_QUERY);
  const focused = windows.filter((client) => client.focused);
  if (focused.length > 0) {
    for (const client of focused) {
      client.postMessage({ type: 'push-event', payload });
    }
    return;
  }

  const copy = notificationCopyForCategory(payload.category);
  await scope.registration.showNotification(copy.title, {
    body: copy.body,
    tag: payload.conversationId,
    data: payload,
  });
}
```

after:

```ts
/**
 * Validate the push body, then raise a generic, content-free OS notification
 * tagged by conversation so a newer push for the same conversation collapses
 * onto the older one.
 *
 * A user with the app in front of them gets nothing: no OS notification (it
 * would interrupt a window they are already reading) and no in-page signal
 * either — the conversation list shows the activity where they are looking.
 */
export async function handlePush(scope: ServiceWorkerScope, event: PushEventLike): Promise<void> {
  const parsed = pushEventPayloadSchema.safeParse(readPushData(event));
  if (!parsed.success) return;
  const payload = parsed.data;

  const windows = await scope.clients.matchAll(WINDOW_QUERY);
  if (windows.some((client) => client.focused)) return;

  const copy = notificationCopyForCategory(payload.category);
  await scope.registration.showNotification(copy.title, {
    body: copy.body,
    tag: payload.conversationId,
    data: payload,
  });
}
```

The focused-client **check** is retained verbatim in effect — the early return still suppresses
`showNotification` whenever any window client is focused. Only the postMessage went. Payload
validation, generic per-category copy, `tag: payload.conversationId`, and `data: payload`
(G1) are untouched, as is `handleNotificationClick` and the whole
`handlePushSubscriptionChange` postMessage fallback (`handlers.ts:184–187`), which is why
`WindowClientLike.postMessage` remains on the interface.

### TDD record (SW)

The removal was driven red-first. `handlers.test.ts`'s single
"posts the push-event message to a focused client and skips the notification" was split into
two one-behavior tests, the second of which is the regression pin for the ruling:

```ts
  it('shows no notification while a client is focused', async () => { … expect(showNotification).not.toHaveBeenCalled(); });

  it('hands a focused client nothing', async () => {
    const focused = makeClient({ focused: true });
    const scope = makeScope({ clients: [focused] });
    await handlePush(scope, pushEvent({ category: 'runCompletion', conversationId: VALID_ID }));

    expect(focused.postMessage).not.toHaveBeenCalled();
  });
```

Watched fail before the code change, for exactly the right reason
(`npx vitest run src/sw/handlers.test.ts` → `1 failed | 15 passed`):

```
Number of calls: 1
    Array [ Object { "payload": {...}, "type": "push-event" } ]
 ❯ src/sw/handlers.test.ts:93:37
     93|     expect(focused.postMessage).not.toHaveBeenCalled();
```

Then green after the edit: `npx vitest run src/sw` → 4 files, 23 tests passed.

## 2. The page side

`use-activity-intake.ts` had two effects. The first — the whole SW message intake — is deleted:

```ts
// deleted, with its schema and both imports
const forwardedPushSchema = z.object({
  type: z.literal('push-event'),
  payload: pushEventPayloadSchema,
});

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const handler = (event: MessageEvent): void => {
      if (!forwardedPushSchema.safeParse(event.data).success) return;
      useNotificationActivityStore.getState().recordActivity();
    };
    navigator.serviceWorker.addEventListener('message', handler);
    return (): void => {
      navigator.serviceWorker.removeEventListener('message', handler);
    };
  }, []);
```

The second effect — the away-gated reset on focus/visibility — is kept **byte-identical**
(founder: do not alter the away-gate or the activity semantics). Orphans cleaned:

- `import { z } from 'zod'` and `import { pushEventPayloadSchema } from '@hushbox/shared'` —
  the only consumers of both in this file.
- The file/hook **name**: with intake gone, the hook only resets the count, so
  `use-activity-intake.ts` / `useActivityIntake` became a stale name (CODE-RULES durable
  naming: a wrong name is worse than none). Renamed to `use-activity-reset.ts` /
  `useActivityReset`, with the docstring rewritten to describe what is left. Its one caller,
  `notification-activity-layer.tsx`, was updated. Flagged as a judgment call in §Deviations.
- `use-conversation-activity.ts`'s docstring, which pointed at the deleted path
  ("…this only ever sees the conversation on screen — **pushes forwarded by the service
  worker cover the rest**") now reads "…activity anywhere else reaches the user as an OS
  notification instead." Comment only; no code change in that file.

### Tests removed (they covered only the deleted path)

From the intake suite: "counts a push the worker forwarded to this tab", "ignores a worker
message that is not a forwarded push", "ignores a forwarded push whose payload does not hold
up", "stops listening once the layer unmounts" (SW listener teardown), "mounts cleanly where
there is no service worker" (the `'serviceWorker' in navigator` guard is gone), plus the
`installServiceWorker` helper.

### Tests kept / adjusted

- `use-activity-reset.test.ts` keeps the three away-gate tests verbatim in intent (clears on
  focus, clears on becoming visible, keeps the count while still away) and replaces the
  removed teardown test with one that pins the *remaining* cleanup: after unmount, a focus and
  a visibilitychange no longer clear the count. 4 tests, all passing.
- `notification-activity-layer.test.tsx` drove the layer by emitting a forwarded push. It now
  drives it through the store's own entry point — the same call the surviving socket feed
  makes — so both layer behaviors stay pinned:

```ts
/** The store's feeds live elsewhere; the layer only presents what they record. */
function observeActivity(): void {
  act(() => {
    useNotificationActivityStore.getState().recordActivity();
  });
}
```

  "turns observed activity into a title, and an announcement" + "clears everything when the
  user comes back". The `installServiceWorker` helper and the `navigator.serviceWorker`
  teardown in `afterEach` went with it.

### Shared schema: nothing orphaned

`pushEventPayloadSchema` / `PushEventPayload` keep live consumers and were **not** touched:
`apps/api/src/slices/notifications/adapters/push-webpush.ts:1,56` (send side) and
`apps/web/src/sw/handlers.ts:1,45,105` (receive side), plus
`packages/shared/src/notifications/index.test.ts`. The `push-event` *message* shape was never
a shared export — it was the local `forwardedPushSchema`, which is gone with its only
consumer. `grep -rn "push-event" apps packages e2e scripts docs` (excluding this run's dir)
now returns **zero** hits.

## Not touched (explicitly verified)

- **`handlePushSubscriptionChange`'s postMessage fallback** — intact, all three of its tests
  pass unchanged (`handlers.test.ts:198–233`).
- **The away-gate and activity semantics** — `stores/notification-activity.ts` untouched; its
  10 tests pass.
- **The socket-fed in-app feed** — `use-conversation-activity.ts` logic untouched (docstring
  only) and `use-group-chat.ts` untouched. Proof below.
- **`push` payload validation, generic copy, `tag`** (G1) — untouched; the six validation /
  copy / tag tests in `handlers.test.ts` pass unchanged.
- **`packages/shared`**, `docs/`, and every other task's files.

## Self-gate

| Command                                                    | Result                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `npx turbo lint --filter=@hushbox/web --force`               | **pass — exit 0** (7m08s, cache bypass); re-run captured `EXIT=0`, cache miss |
| `npx turbo typecheck --filter=@hushbox/web --force`          | **pass — exit 0**                                                        |
| `pnpm test:web` (suite + per-file coverage gate), after last edit | **pass — exit 0**, 392 files / 6378 tests                          |

### `npx turbo lint --filter=@hushbox/web` — full output, with exit code

```
EXIT=0
• turbo 2.9.18

   • Packages in scope: @hushbox/web
   • Running lint in 1 packages
   • Remote caching disabled

@hushbox/web:lint: cache miss, executing 59424efabd385e07
@hushbox/web:lint:
@hushbox/web:lint: > @hushbox/web@0.0.0 lint /workspace/popper-mobile/.superset/projects/HushBox/apps/web
@hushbox/web:lint: > eslint .
@hushbox/web:lint:

 Tasks:    1 successful, 1 total
Cached:    0 cached, 1 total
  Time:    6m0.408s
```

(The immediately preceding `--force` run produced the identical body, `Tasks: 1 successful`,
`Time: 7m8.037s`. Both were real executions — cache bypass / cache miss, not replays.)

### `npx turbo typecheck --filter=@hushbox/web --force` — full output

```
• turbo 2.9.18

   • Packages in scope: @hushbox/web
   • Running typecheck in 1 packages
   • Remote caching disabled

@hushbox/web:typecheck: cache bypass, force executing 58858ef592b59d87
@hushbox/web:typecheck:
@hushbox/web:typecheck: > @hushbox/web@0.0.0 typecheck /workspace/popper-mobile/.superset/projects/HushBox/apps/web
@hushbox/web:typecheck: > tsgo --noEmit && tsgo --noEmit -p tsconfig.native-tests.json
@hushbox/web:typecheck:

 Tasks:    1 successful, 1 total
Cached:    0 cached, 1 total
  Time:    8.354s
```

### `pnpm test:web` — exit 0, summary and owned-file coverage

```
EXIT=0
 Test Files  392 passed (392)
      Tests  6378 passed (6378)
   Duration  484.19s

 Tasks:    1 successful, 1 total
```

Turbo exited 0, so the per-file coverage gate passed. Owned rows
(`% Stmts / % Branch / % Funcs / % Lines`):

```
 src/sw                       |  100 | 100 | 100 | 100
  handlers.ts                 |  100 | 100 | 100 | 100
 src/hooks/notifications      |  100 | 100 | 100 | 100
  ...vity-reset.ts            |  100 | 100 | 100 | 100
  ...n-activity.ts            |  100 | 100 | 100 | 100
  ...vity-sinks.ts            |  100 | 100 | 100 | 100
  ...n-clearing.ts            |  100 | 100 | 100 | 100
 src/components/notifications |  100 | 100 | 100 | 100
  ...ity-layer.tsx            |  100 | 100 | 100 | 100
  ...announcer.tsx            |  100 | 100 | 100 | 100
 src/lib/notification-activity|  100 | 100 | 100 | 100
 src/stores                   |  100 | 100 | 100 | 100
```

Both arms of the new `windows.some((client) => client.focused)` branch are exercised
(focused → suppressed; unfocused → shown), which is why `handlers.ts` holds 100% branch.

### Evidence the required behaviors still hold

| Behavior the ruling must not break                        | Proof (all green in the `pnpm test:web` run above)                                          |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| SW suppresses `showNotification` when a client is focused    | `src/sw/handlers.test.ts` — "shows no notification while a client is focused" (16 tests ✓)      |
| SW still shows it otherwise, generic copy + tag + data       | same file — "shows a generic notification when no client is focused", "stores the validated payload as notification data" |
| SW hands a focused client nothing (the ruling)               | same file — "hands a focused client nothing"                                                    |
| `pushsubscriptionchange` fallback intact                     | same file — the three `handlePushSubscriptionChange` tests                                      |
| Socket-fed badge path still works                            | `src/hooks/notifications/use-conversation-activity.test.ts` (5 ✓), `src/hooks/realtime/use-group-chat.test.ts` (44 ✓, incl. "counts a message from another member as activity while the user is away") |
| Store / away-gate semantics unchanged                        | `src/stores/notification-activity.test.ts` (10 ✓)                                               |
| Sinks (title, badge, sound) unchanged                        | `src/hooks/notifications/use-activity-sinks.test.ts` (12 ✓)                                     |
| Layer still presents and clears                              | `src/components/notifications/notification-activity-layer.test.tsx` (2 ✓)                        |

## Acceptance criteria

The ruling's own criteria:

1. **SW stops posting `push-event` to focused clients** — met; `grep -rn "push-event"` over
   `apps packages e2e scripts docs` (outside the run dir) returns nothing, and a test pins it.
2. **The focused-client check itself is retained** — met; the early return still suppresses
   `showNotification`, pinned by its own test.
3. **Page-side intake removed, with its orphans** — met; the listener, `forwardedPushSchema`,
   both imports, the stale hook name, the stale sibling docstring, and the five push-only
   tests are gone.
4. **`pushsubscriptionchange` fallback, away-gate, socket feed, and G1 payload/copy/tag
   untouched** — met, each with a passing test above.
5. **Shared `push-event` type/schema judged** — no shared type existed for the message; the
   payload schema keeps two live consumers and was left alone.

Task 09's five plan criteria plus its extended-scope criterion are unaffected and still met as
recorded in impl-report-1 and re-verified in impl-report-2: nothing in the store, sinks,
clearing, adapters, or shared schemas changed this round, and all of their tests pass. The one
criterion whose *evidence* moved is criterion 1 (increment rules / reset on focus /
`markAllSeen`): the reset half was pinned in `use-activity-intake.test.ts` and is now pinned in
`use-activity-reset.test.ts`, same three assertions.

## Deviations, with reasons

1. **Renamed the hook and its file** (`use-activity-intake.{ts,test.ts}` →
   `use-activity-reset.{ts,test.ts}`, `useActivityIntake` → `useActivityReset`), which forced a
   one-line import change and a docstring change in `notification-activity-layer.tsx`. Not
   literally requested. Reason: after the removal the hook takes in nothing — it only resets
   the count on return — so the old name described a behavior the file no longer has, which
   CODE-RULES (durable naming) treats like a wrong comment. Both files are inside Task 09's
   ownership. Raised.
2. **Split one SW test into two** rather than editing it in place, because the surviving
   assertion and the new regression pin are two behaviors and the repo forbids "and" tests.
3. **The layer test now drives the store directly** instead of through a transport. The
   transport it used no longer exists; `recordActivity()` is exactly what the surviving feed
   (`use-conversation-activity`) calls, so the layer is still tested through its real input.

## Concerns and limitations

- **OUT-OF-SCOPE: `docs/NOTIFICATIONS.md` now has two stale lines** (Task 00's file; docs are
  read-only to me). §Doctrine 3 says "Display-point routing — a focused tab choosing to show an
  in-app signal instead of a system notification — is allowed", and §Dismissal & the foreground
  layer says the store counts events "(socket frames + pushes routed in by the service
  worker)". Neither is true after this ruling: a focused tab now shows *nothing*, and the SW
  routes nothing into the page. Someone who owns that doc needs one edit to each.
- **The badge's only feed is now the open conversation's socket.** That was already true in
  production (the push path could never fire), but it is now also true in the code: activity in
  a conversation that is not on screen reaches the user only as an OS notification. This is the
  founder-ruled semantics, recorded here so the next reader does not mistake it for a gap.
- **Every concern from impl-report-1 still stands** — nothing writes the read cursor, no UI
  toggles sound. Neither was in scope this round.
- **Other workstreams are editing this repo concurrently** (the tree carries billing, document,
  and reasoning-effort changes this task never touched). All three gates were fully green
  regardless, so nothing required attribution — including the standing amendment's known-red
  `use-prompt-budget.ts`, which did not fire in this lint run.

## Confidence

**High.** The change is a deletion whose two halves are each pinned by a passing test written
red-first (SW) or preserved intact (page side), the three demanded gates are exit-0 with full
output captured — lint as a genuine cache-miss execution, not a replay — every owned file is at
100/100/100/100, and the four things the brief forbade touching each still have their own green
tests.
