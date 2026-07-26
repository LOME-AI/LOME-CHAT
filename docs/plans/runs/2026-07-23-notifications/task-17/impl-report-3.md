# Task 17 — impl report 3 (fix pass, one validated Minor)

## Objective

The audit passed. One validated Minor: the third absence assertion in
`e2e/notifications/notifications.spec.ts` — `await expect(offer).toBeHidden()` after
`reloadWithPreferences`, in "takes the browser permission from the offer…" — was the only
one of the three that did not expand the sidebar first. It was non-vacuous only because
`sidebarOpen` happens to survive a reload through the UI store's `partialize`. Its two
siblings were given an explicit expand for exactly this reason; this one was made to match.

Nothing else changed.

## Files changed

- `e2e/notifications/notifications.spec.ts` — the sidebar page object is bound to a
  `const` (it was constructed inline for the single use) and `ensureSidebarExpanded()` is
  called again after the reload, before the absence assertion.

## The diff, in full

```diff
@@ -92,7 +92,8 @@ test.describe('Notifications', { tag: '@chromium-only' }, () => {

     await authenticatedPage.goto('/chat', { waitUntil: 'domcontentloaded' });
     await waitForAppStable(authenticatedPage);
-    await new SidebarPage(authenticatedPage).ensureSidebarExpanded();
+    const sidebar = new SidebarPage(authenticatedPage);
+    await sidebar.ensureSidebarExpanded();

     const offer = enableOffer(authenticatedPage);
     await expect(offer).toBeVisible();
@@ -111,6 +112,10 @@ test.describe('Notifications', { tag: '@chromium-only' }, () => {
     // Answered platforms are never asked again.
     await reloadWithPreferences(authenticatedPage);
     await waitForAppStable(authenticatedPage);
+    // Expanded explicitly rather than relying on the collapsed/expanded state
+    // surviving the reload: the assertion below only means something while the
+    // place the offer would render is on screen.
+    await sidebar.ensureSidebarExpanded();
     await expect(offer).toBeHidden();
   });
```

The binding change is forced, not cosmetic: the same page object is now used twice in the
test, and constructing a second `SidebarPage` for the second call would be the worse of
the two shapes. The wording of the new comment deliberately echoes the sibling at `:80`
without copying it, since the two say the same thing about different moments.

No assertion was added, removed, weakened, or reordered. No helper was introduced —
`ensureSidebarExpanded()` is the existing public page-object method the two siblings
already use, and it is idempotent (it clicks only while the collapsed control is visible),
so the call is a no-op whenever the state did persist.

## Tests added

None, and none are owed: this is a change to a test's own setup that removes a way for an
existing assertion to pass for the wrong reason. The behavior under test is unchanged.

## Self-gate

- `playwright test e2e/notifications/ --project=chromium --retries=0` — **pass**, 4/4
  (47/47 including the per-persona auth setup project the suite depends on). Full output:

```
$ npx tsx scripts/with-env.ts playwright test \
    --config=playwright.TEMPORARY-DELETE-ME.reuse-sandbox.config.ts \
    e2e/notifications/ --project=chromium --retries=0
…
  ✓  45 [chromium] › e2e/notifications/notifications.spec.ts:52:3 › Notifications › offers notifications once, and remembers "Later" on this device @chromium-only (2.1s)
  ✓  47 [chromium] › e2e/notifications/notifications.spec.ts:86:3 › Notifications › takes the browser permission from the offer and registers the push service worker @chromium-only (2.4s)
  ✓  46 [chromium] › e2e/notifications/notifications.spec.ts:165:3 › Notifications › saves every notification preference to the account, and turning them all off retires the offer @chromium-only (2.6s)
  ✓  44 [chromium] › e2e/notifications/notifications.spec.ts:122:3 › Notifications › shows one generic, content-free notification for a push that arrives while the app is not open @chromium-only (2.6s)

  47 passed (1.8m)

E2E report (source of truth for debugging): e2e/report/2026-07-25T17-43-03/REPORT.md (0 failed, 0 flaky, 47 passed)
EXIT=0
```

- `npx turbo lint typecheck --filter=@hushbox/e2e --force` — **pass** (exit 0), run after
  the last edit:

```
• Packages in scope: @hushbox/e2e
   • Running lint, typecheck in 1 packages
   • Remote caching disabled

@hushbox/e2e:typecheck: cache bypass, force executing e37bd874585a3595
@hushbox/e2e:lint: cache bypass, force executing 17069fd65693552a
@hushbox/e2e:lint: > eslint .
@hushbox/e2e:typecheck: > tsgo --noEmit

 Tasks:    2 successful, 2 total
Cached:    0 cached, 2 total
  Time:    47.832s

EXIT=0
```

`pnpm e2e:prepare` ran first (stack + catalog + seed, exit 0).

## The first attempt failed on concurrent work — attribution

The first pass of both gates was red, and neither red was mine.

**Playwright, 17:35:51 — 4 failed.** All four failed identically, at the first line of each
test (`saveNotificationPreferences`, an API `PUT`), before any code path this pass touches:

```
Test timeout of 60000ms exceeded.
Error: apiRequestContext.apply: Request context disposed.
Call log:
  - → PUT http://localhost:8788/notifications/preferences
```

The step timeline shows the request itself hanging (`PUT "/notifications/preferences"
(59.7s) FAILED`), and the run's `server-api.log` shows why — the API worker could not
rebuild:

```
✘ [ERROR] Could not resolve "../money.js"
    ../../packages/shared/src/models/premium-check.ts:14:29
✘ [ERROR] Could not resolve "../nano-usd.js"
✘ [ERROR] Could not resolve "../../model-descriptor.js"
✘ [ERROR] Could not resolve "./modality.js"
```

Those four modules were being moved into `packages/shared/src/affordability/` by another
workstream **while the run was in flight**: the destination files carry mtimes of
13:33–13:36 EDT, and the run started 13:35:51 EDT. `git status -- packages/shared` went
from clean at the start of this pass to 66 changed paths minutes later, none of them mine.
The 43 auth-setup tests that ran before the move passed, which is what puts the break
inside the run rather than before it.

**`turbo lint typecheck --filter=@hushbox/e2e`, same window — failed**, entirely on that
same in-flight move (`Cannot find module '../money.js'`, `'./modality.js'`,
`'../estimate/index.js'`, … — 15 errors, every one in `packages/shared`, zero in `e2e/`).

Both went green on a clean re-run minutes later once the other workstream's tree settled,
with no change to my edit in between. Nothing was fixed, reverted, or touched outside
`e2e/notifications/notifications.spec.ts`.

## The temporary config — created, used, deleted

Port 7400 is still held by another workstream's orphaned sandbox server (`/render.html`
answers `200`), and the shipped config sets `reuseExistingServer: false` on that entry, so
the run aborts without a workaround. Per the brief I created exactly one file:

```
playwright.TEMPORARY-DELETE-ME.reuse-sandbox.config.ts
```

```ts
import base from './playwright.config';

const servers = Array.isArray(base.webServer) ? base.webServer : [];

export default {
  ...base,
  webServer: servers.map((server) =>
    server.name === 'Sandbox' ? { ...server, reuseExistingServer: true } : server
  ),
};
```

It flips that one entry and nothing else. It is **deleted**:

```
$ ls playwright*.ts
playwright.config.ts

$ git status --porcelain -- 'playwright*'
 D playwright.tmp-reuse-sandbox.config.ts
```

The remaining `D` line is **not** this file. It is impl-2's temporary config, which a
concurrent founder commit swept into HEAD while it existed (impl-2 concern 1); its
deletion is still an uncommitted worktree deletion because this agent may not write git
state. This pass's config was created and removed inside this pass and never reached an
index, which is why it appears nowhere in `git status`.

## Acceptance criteria

The audit's single validated Minor:

- **The third absence assertion expands the sidebar explicitly, matching its two
  siblings** — **met**. `await sidebar.ensureSidebarExpanded()` now precedes the
  `toBeHidden()` at what is now line 118; the assertion can no longer be satisfied by a
  collapsed rail if `partialize` or the storage key ever changes.
- **Nothing else changed** — **met**. The diff above is the whole change; `git diff` over
  the spec shows two hunks and no other file in the repo is modified by this pass.
- **No new helper, no weakened or added assertions, no retries/sleeps/skips** — **met**.
  The only call added is to an existing page-object method already used twice in the same
  file.

## Deviations

None.

## Concerns and limitations

1. **The repo is being refactored underneath this run.** `packages/shared` is mid-move by
   another workstream; both gates were red for it once and green minutes later. A gate run
   against this tree can go red at any moment for reasons that have nothing to do with
   this task, and the auditor should expect to re-run rather than attribute.
2. **impl-2's temporary config is still an uncommitted deletion in HEAD** (unchanged from
   impl-2 concern 1). It needs to ride the next commit; no git write is permitted here.
3. **Port 7400 remains occupied** by an orphaned sandbox server from another workstream.
   Any future Playwright run in this checkout hits the same abort until that process is
   reaped.

## Confidence

**High.** The change is two lines plus a comment, the assertion it protects passes, and
the full 4/4 suite is green on a clean run with the lint/typecheck gate green after the
last edit. The one thing outside my control — a concurrent refactor of `packages/shared` —
is documented with the evidence that separates it from my work.
