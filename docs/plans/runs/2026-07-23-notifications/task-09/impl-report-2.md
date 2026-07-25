# Task 09 — Foreground layer + dismissal clearing — impl report 2 (fix round)

## Objective

Two validated findings from the audit of impl-report-1:

1. **[Critical]** `turbo lint --filter=@hushbox/web` red with 18 errors, all in this task's
   files — a CI and pre-push gate failing. Report 1 claimed `eslint <owned files>` green;
   that scoped run silently no-ops under ESLint v9 when launched from the wrong cwd.
2. **[Minor]** `ActivityEvent.conversationId` required by the store but never read by any
   store logic. Ruled: drop it.

The third audit item (SW-focused vs away-gate conflict) is a plan-level design question with
the founder — `sw/handlers.ts`, `use-activity-intake.ts`'s away gate and the away-gate logic
were left untouched on that axis.

## Files changed

| File                                                            | Why                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `apps/web/src/lib/notification-activity/sound.ts`                | optional chain; `.catch()` → awaited try/catch                            |
| `apps/web/src/lib/notification-activity/app-badge.ts`            | `.catch()` → awaited try/catch                                            |
| `apps/web/src/hooks/notifications/use-notification-clearing.ts`  | `.catch()` → awaited try/catch; `.filter()` takes a wrapper, not a ref     |
| `apps/web/src/components/notifications/activity-announcer.tsx`   | nested ternary extracted to a `plural` binding                            |
| `apps/web/src/stores/notification-activity.ts`                   | `conversationId` dropped from `ActivityEvent`; the arg is now optional     |
| `apps/web/src/hooks/notifications/use-activity-intake.ts`        | caller of the dropped field                                               |
| `apps/web/src/hooks/notifications/use-conversation-activity.ts`  | caller of the dropped field                                               |
| `apps/web/src/stores/notification-activity.test.ts`              | call sites of the dropped field; now-unused fixture id removed             |
| `apps/web/src/hooks/notifications/use-activity-intake.test.ts`   | `!== -1`, useless spread, `globalThis`                                     |
| `apps/web/src/components/notifications/notification-activity-layer.test.tsx` | `globalThis`                                                  |
| `apps/web/src/hooks/realtime/use-group-chat.test.ts`             | prettier formatting of the added block; `() => {}` unsubscribe             |

No file outside this task's ownership was touched. No lint rule, eslint config, `@ts-ignore`,
or `eslint-disable` was added — every fix is a code change.

## The 18 lint errors, each with its diff

### 1. `sound.ts:28` — `@typescript-eslint/prefer-optional-chain`

```diff
-  if (ctx === null || ctx.state !== 'suspended') return;
+  if (ctx?.state !== 'suspended') return;
```

Identical behavior (`undefined !== 'suspended'` on a null context still returns) and TS still
narrows `ctx` to non-null past the guard — `tsgo --noEmit` is clean.

### 2–3. `sound.ts:30` — `promise/prefer-await-to-then` + `unicorn/no-useless-undefined`

```diff
-  // A refused resume just leaves the app silent; sound is never the sole signal.
-  ctx.resume().catch(() => undefined);
+  void (async (): Promise<void> => {
+    try {
+      await ctx.resume();
+    } catch {
+      // A refused resume just leaves the app silent; sound is never the sole signal.
+    }
+  })();
```

### 4–5. `app-badge.ts:15` — same two rules

```diff
-  // Badging rejects on platforms that expose the API but refuse the write (an
-  // uninstalled PWA, a revoked permission). Nothing depends on the badge.
-  applied.catch(() => undefined);
+  void (async (): Promise<void> => {
+    try {
+      await applied;
+    } catch {
+      // Badging rejects on platforms that expose the API but refuse the write
+      // (an uninstalled PWA, a revoked permission). Nothing depends on the badge.
+    }
+  })();
```

### 6–7. `use-notification-clearing.ts:9` — same two rules

```diff
-/** Best-effort by nature: a shade that refuses to be tidied changes nothing. */
 function clear(conversationIds: readonly string[]): void {
-  notificationChannel.clearDelivered(conversationIds).catch(() => undefined);
+  void (async (): Promise<void> => {
+    try {
+      await notificationChannel.clearDelivered(conversationIds);
+    } catch {
+      // Best-effort by nature: a shade that refuses to be tidied changes nothing.
+    }
+  })();
 }
```

**Why the `void (async () => {…})()` shape and not `async` functions.** `promise/prefer-await-to-then`
exempts `.catch()` only inside an `await`/`yield` expression
(`node_modules/…/eslint-plugin-promise/rules/prefer-await-to-then.js`, `isInsideYieldOrAwait`);
all three call sites are synchronous `void`-returning functions, so there was no await to sit
inside. Making them `async` would push a floating promise onto every caller. `void (async …)()`
is the established repo idiom for exactly this — `hooks/notifications/use-enable-prompt.ts:59,70`
and `hooks/notifications/use-push-registration.ts:23`.

**Behavior is preserved, including timing.** An async IIFE body runs synchronously up to its
first `await`, and `await X` evaluates `X` synchronously — so `resume()`, `setAppBadge()` and
`clearDelivered()` are still invoked in the same tick. The three "never surfaces a refused …"
tests (which assert call counts right after the call, one of them across a single microtask
tick) pass unchanged. The rejection handler is still attached synchronously, so no unhandled
rejection is introduced.

### 8. `use-notification-clearing.ts:56` — `unicorn/no-array-callback-reference`

```diff
-    const readIds = conversations.filter(isFullyRead).map((conversation) => conversation.id);
+    const readIds = conversations
+      .filter((conversation) => isFullyRead(conversation))
+      .map((conversation) => conversation.id);
```

### 9. `activity-announcer.tsx:12` — `sonarjs/no-nested-conditional`

```diff
-  const message =
-    unreadCount > 0 ? `${String(unreadCount)} new notification${unreadCount === 1 ? '' : 's'}` : '';
+  const plural = unreadCount === 1 ? '' : 's';
+  const message = unreadCount > 0 ? `${String(unreadCount)} new notification${plural}` : '';
```

The four announcer tests (silent at zero, singular, plural, `role="status"`) still pass.

### 10. `use-activity-intake.test.ts:22` — `unicorn/consistent-existence-index-check`

```diff
-    if (index >= 0) handlers.splice(index, 1);
+    if (index !== -1) handlers.splice(index, 1);
```

### 11. `use-activity-intake.test.ts:31` — `unicorn/no-useless-spread`

```diff
-        for (const handler of [...handlers]) handler({ data });
+        for (const handler of handlers) handler({ data });
```

The defensive copy guarded against a handler unregistering during iteration; nothing in this
suite emits during teardown, and the copy is what the rule flags. Dropped rather than laundered.

### 12–13. `use-activity-intake.test.ts:131`, `notification-activity-layer.test.tsx:87` — `unicorn/prefer-global-this`

```diff
-      window.dispatchEvent(new Event('focus'));
+      globalThis.dispatchEvent(new Event('focus'));
```

Same object in the browser test environment; both focus-clears-the-count tests still pass.

### 14–18. `use-group-chat.test.ts:755–758` — four `prettier/prettier` + `unicorn/no-useless-undefined`

The test block added in round 1 was never formatted. Reflowed to prettier's output and the
unsubscribe stub changed to the repo's shape (`() => {}`, as in
`hooks/realtime/use-realtime-sync.test.ts:30`):

```diff
-      on: vi.fn((type: string, listener: (event: { conversationId: string; senderId?: string }) => void) => {
-        if (type === 'message:new') onMessage = listener;
-        return () => undefined;
-      }),
+      on: vi.fn(
+        (
+          type: string,
+          listener: (event: { conversationId: string; senderId?: string }) => void
+        ) => {
+          if (type === 'message:new') onMessage = listener;
+          return () => {};
+        }
+      ),
```

## The dropped field (Minor finding)

`ActivityEvent.conversationId` was required by the store's interface and read by nothing: the
count is app-wide and only `selfAuthored` gates it. Dropped, per the ruling — per-conversation
counts were not asked for and were not added.

```diff
-/** One observed notification-worthy event, whatever channel carried it. */
+/**
+ * One observed notification-worthy event, whatever channel carried it. The
+ * count is app-wide, so an event carries no identity — only whether it should
+ * be counted at all.
+ */
 interface ActivityEvent {
-  readonly conversationId: string;
   /**
    * True when this user caused the event (their own send echoed back to this
    * device). Their own activity is never activity to be told about.
    */
   readonly selfAuthored?: boolean;
 }
```

With the only remaining member optional, the argument itself became optional
(`recordActivity: (event?: ActivityEvent) => void`, guard `event?.selfAuthored === true`), so
the push-forwarding feed — which has nothing to say about an event — calls `recordActivity()`
rather than passing an empty object.

Cascade, all inside this task's ownership:

```diff
 // use-activity-intake.ts
-      const forwarded = forwardedPushSchema.safeParse(event.data);
-      if (!forwarded.success) return;
-      useNotificationActivityStore.getState().recordActivity({
-        conversationId: forwarded.data.payload.conversationId,
-      });
+      if (!forwardedPushSchema.safeParse(event.data).success) return;
+      useNotificationActivityStore.getState().recordActivity();
```

```diff
 // use-conversation-activity.ts
       useNotificationActivityStore.getState().recordActivity({
-        conversationId: event.conversationId,
         selfAuthored: currentUserId !== null && event.senderId === currentUserId,
       });
```

The shared payload schema still validates `conversationId` on the way in — only the store's
event shape lost it. `use-notification-clearing.ts` (which genuinely addresses notifications
by conversation id) is untouched by this change.

Store test call sites lost the field (`recordActivity({ conversationId: X })` →
`recordActivity()`), and the fixture id they used, now unreferenced, was removed. No assertion
changed: all ten store tests still assert the same counts, and both `recordActivity` arg
forms (absent, and `{ selfAuthored: true }`) remain exercised, so the new optional-chain
branch is covered on both arms.

## Self-gate

| Command                                                                | Result                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `npx turbo lint --filter=@hushbox/web --force` (the finding's gate)      | **pass — exit 0** (was 18 errors); full output below                |
| `pnpm test:web` (suite + per-file coverage gate), after the last edit    | **pass — exit 0**, 392 files / 6361 tests, no threshold failures     |
| `npx turbo typecheck --filter=@hushbox/web --force`                     | **pass — exit 0**                                                   |
| `npx eslint <touched files>` from `apps/web`                            | pass (kept only as a fast inner loop — never as evidence again)     |

### `npx turbo lint --filter=@hushbox/web --force` — full output

```
• turbo 2.9.18

   • Packages in scope: @hushbox/web
   • Running lint in 1 packages
   • Remote caching disabled

@hushbox/web:lint: cache bypass, force executing 3376c6363a0cf6da
@hushbox/web:lint:
@hushbox/web:lint: > @hushbox/web@0.0.0 lint /workspace/popper-mobile/.superset/projects/HushBox/apps/web
@hushbox/web:lint: > eslint .
@hushbox/web:lint:

 Tasks:    1 successful, 1 total
Cached:    0 cached, 1 total
  Time:    2m40.501s
```

Exit status captured as `PIPESTATUS=0`. For contrast, the same command before these edits
ended `✖ 18 problems (18 errors, 0 warnings)` / `run failed: command exited (1)`.

### `npx turbo typecheck --filter=@hushbox/web --force` — full output

```
• turbo 2.9.18

   • Packages in scope: @hushbox/web
   • Running typecheck in 1 packages
   • Remote caching disabled

@hushbox/web:typecheck: cache bypass, force executing 635eab0c6f04aa8e
@hushbox/web:typecheck:
@hushbox/web:typecheck: > @hushbox/web@0.0.0 typecheck /workspace/popper-mobile/.superset/projects/HushBox/apps/web
@hushbox/web:typecheck: > tsgo --noEmit && tsgo --noEmit -p tsconfig.native-tests.json
@hushbox/web:typecheck:

 Tasks:    1 successful, 1 total
Cached:    0 cached, 1 total
  Time:    6.222s
```

### `pnpm test:web` — summary and owned-file coverage

```
 Test Files  392 passed (392)
      Tests  6361 passed (6361)
   Duration  249.48s
```

Turbo task exited 0, so the per-file coverage gate passed (a shortfall fails `test` in this
repo). Coverage rows for the owned files, all `% Stmts / % Branch / % Funcs / % Lines`:

```
 src/lib/notification-activity |  100 | 100 | 100 | 100
  app-attention.ts             |  100 | 100 | 100 | 100
  app-badge.ts                 |  100 | 100 | 100 | 100
  sound.ts                     |  100 | 100 | 100 | 100
 src/components/notifications  |  100 | 100 | 100 | 100
  ...announcer.tsx             |  100 | 100 | 100 | 100
  ...ity-layer.tsx             |  100 | 100 | 100 | 100
 src/hooks/notifications       |  100 | 100 | 100 | 100
  ...ity-intake.ts             |  100 | 100 | 100 | 100
  ...vity-sinks.ts             |  100 | 100 | 100 | 100
  ...n-activity.ts             |  100 | 100 | 100 | 100
  ...n-clearing.ts             |  100 | 100 | 100 | 100
 src/stores                    |  100 | 100 | 100 | 100
  ...n-activity.ts             |  100 | 100 | 100 | 100
```

Unchanged from round 1: 100% across the board on every owned file.

## Acceptance criteria (re-checked after these edits)

All five Task 09 criteria plus the extended-scope criterion remain met exactly as recorded in
impl-report-1 — no test was weakened, deleted, or re-scoped, and the same 141 tests across the
task's own files pass. Concretely re-verified this round:

1. **Store increment rules / reset / `markAllSeen`** — met. The ten store tests are unchanged
   in intent and assertions; only the now-meaningless `conversationId` argument was dropped
   from their call sites. Away/watching, self-authored, and `markAllSeen` are still pinned.
2. **Title effect `(n) ` prefix** — met, untouched (`use-activity-sinks.ts` not edited).
3. **`setAppBadge` feature-detected, cleared on `markAllSeen`** — met. `app-badge.ts` kept its
   feature detection and its zero-routes-to-clear rule; only the rejection swallow was
   restructured. Its four tests pass, coverage still 100%.
4. **Sound: plays only when enabled; toggle is the unlock gesture; never the sole signal** —
   met, with the same scope note as round 1 (no settings toggle UI exists in this task's
   files). The prime path's guard and rejection handling were restructured, not changed: the
   six sound tests and the two store audio tests pass.
5. **Clearing on view and on foreground read-elsewhere** — met. `clearDelivered` is still
   called synchronously with the same conversation-id arrays; ten clearing tests plus both
   adapters' suites pass.
6. **Extended scope (`lastReadSeq` on the shared schemas + mock backend)** — met, untouched
   this round.

## Deviations, with reasons

None from the brief. One judgment call worth naming: the brief said "either use it or drop it"
for `conversationId`; dropping it left a lone optional member, so the parameter itself was made
optional so the push feed can call `recordActivity()` instead of `recordActivity({})`. That is
the minimal readable shape and adds no feature.

## Concerns and limitations

- **Every concern from impl-report-1 still stands unchanged** — nothing writes the read cursor,
  no UI toggles sound, the SW `pushsubscriptionchange` postMessage has no consumer, the
  foreground refetch costs one request per tab return. None was in scope this round.
- **The lint-verification failure mode is now proven, not theorized.** `npx eslint <files>` run
  from `apps/web` reports exit 0 on files that `eslint .` from the same directory reports 18
  errors on. Any future task in this run that reports a scoped eslint run as evidence should be
  disbelieved; only `turbo lint --filter=<package> --force` counts. The plan's standing
  amendment already says this — round 1 predated it.
- **The full-suite runs were made while other workstreams were editing this repo** (the diff
  contains billing, document, and reasoning-effort files this task never touched). Both
  `test:web` runs were fully green regardless, so nothing needed attribution this round.

## Confidence

**High.** Both findings are closed with the exact commands the finding demanded: the
package-wide lint gate is exit 0 (from 18 errors), typecheck is exit 0, the full web suite is
392/392 files and 6361/6361 tests with the per-file coverage gate green and every owned file
still at 100/100/100/100. Every change is behavior-preserving by construction (guard rewritten
to an equivalent, rejection swallow moved from `.catch` to an awaited `try/catch` with
identical call timing, ternary extracted, dead field removed), and the pre-existing tests —
not new ones — are what proves it.
