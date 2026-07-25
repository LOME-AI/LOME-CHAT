# Task 13 — Playwright notifications spec — impl report 2 (fix pass)

## Objective

Fix the three validated audit findings and the pooled-persona hygiene item, then
prove the suite green by running it: `playwright test e2e/notifications/
--project=chromium --retries=0` → 4/4.

Nothing else was changed. The spike verdict, harness/spec split, descopes and every
selector stand exactly as report 1 left them — the auditor verified them and the
delivery journey's body already passed.

## Files changed

| File                                      | Why                                                                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/notifications/notifications.spec.ts` | The settings gate, the two console-guardrail opt-outs, the pooled-persona restore.                                                        |
| `e2e/notifications/push-harness.ts`       | One exported constant: the incognito Push-API console pattern, with the reason it is browser chrome rather than an app fault.              |

No other repo file was touched. `git status` after the run lists `e2e/notifications/`
as this task's only untracked footprint (`playwright.config.ts` shows a Sandbox
webServer block that was already in the working tree before this pass — another
workstream's; see the run section).

## Fix 1 — the settings criterion was never verified (Critical)

`waitForAppStable` gates on `data-app-stable`, which only the chat index emits, so
on `/settings` it burned the 15 s `APP_STABLE` budget and failed at line 153. The
whole settings criterion below it never ran.

```diff
-    await authenticatedPage.goto('/settings', { waitUntil: 'domcontentloaded' });
-    await waitForAppStable(authenticatedPage);
-
+    // `/settings` emits no app-stability signal — that one belongs to the chat
+    // index — so the card's own arrival is the gate: the preferences read lands,
+    // then the switches replace the loading block.
+    await gotoWithPreferences(authenticatedPage, '/settings');
+    const globalSwitch = authenticatedPage.getByRole('switch', { name: 'All notifications' });
+    await expect(globalSwitch).toBeVisible();
+
     const categorySwitch = authenticatedPage.getByRole('switch', { name: 'Finished runs' });
@@
-    await authenticatedPage.getByRole('switch', { name: 'All notifications' }).click();
+    await globalSwitch.click();
```

Two gates, both app-state: `gotoWithPreferences` (already in the harness) waits for
the `GET /notifications/preferences` the card itself issues, then the `All
notifications` switch becoming visible proves the card swapped its skeleton for the
controls — the card renders a `skeletonBlock` while `isPending`, so the switch's
existence *is* the loaded signal. No new wait mechanism, no wall-clock anything. The
locator was needed later in the test anyway, so it is hoisted rather than duplicated.

## Fix 2 — teardown console guardrail (Critical)

Both registration-path tests passed their bodies and died at
`e2e/fixtures.ts:1013` on Chromium's own line: *"Chrome currently does not support
the Push API in incognito mode (https://crbug.com/41124656)"*. Every Playwright
context is incognito-like, so it fires unconditionally — in CI too.

In the harness, named and justified:

```diff
+/**
+ * Chromium's own refusal to hand out a push subscription in an incognito
+ * profile, which every Playwright browser context is. The browser logs it as a
+ * console error the moment the app calls `pushManager.subscribe()`, so any test
+ * that drives the registration path has to allow it — it is browser chrome, not
+ * an app fault, and the app's rejected subscribe is handled (the permission and
+ * the registered worker are what the suite asserts on instead).
+ */
+export const PUSH_API_INCOGNITO_CONSOLE_ERROR = /does not support the Push API in incognito/;
```

Applied to exactly the two tests that reach `pushManager.subscribe()` — test 2 (the
Enable click) and test 3 (an already-permitted device re-registering at app start):

```diff
     await saveNotificationPreferences(authenticatedRequest, ALL_NOTIFICATIONS_ON);
+    expectConsoleErrors(authenticatedPage, [PUSH_API_INCOGNITO_CONSOLE_ERROR]);
```

Tests 1 and 4 never grant permission, so they never reach `subscribe()` and keep the
guardrail at full strength. The pattern is one browser sentence — it cannot mask an
app error, an accessibility hint, or a failed request.

## Fix 3 — pooled-persona hygiene

Test 4 left the shared `test-alice` with `globalEnabled: false`, `runCompletion:
false` and a quiet window. It now hands the account back:

```diff
     await expect(enableOffer(authenticatedPage)).toBeHidden();
+
+    // The account is a pooled persona shared with every other suite: hand it
+    // back in the state it was found in, which is also the state a new account
+    // starts in. This is the only test that leaves preferences off.
+    await saveNotificationPreferences(authenticatedRequest, ALL_NOTIFICATIONS_ON);
```

`ALL_NOTIFICATIONS_ON` is verifiably the as-found state, not an approximation of it:
`packages/db/src/schema/notification-preferences.ts` defaults `global_enabled` and
every category to `true` and leaves both quiet-hour columns `NULL`.

The restore is the last statement of the test body, not an `afterEach` — rule 2.7
bans spec-level hooks. A test that fails before reaching it leaves the persona dirty,
which is the same exposure as before this fix and strictly better after it; every
test in the suite states the preferences it needs first, so no notifications test can
be affected either way.

## Self-gate

| Command                                                                                                              | Result                        |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `npx tsx scripts/with-env.ts playwright test --config=<scratch> e2e/notifications/ --project=chromium --retries=0`    | **pass — 47 passed (1.6m)**, of which the 4 notifications tests; 43 are the `setup-chromium` auth dependency |
| same, `--repeat-each=3`                                                                                              | **pass — 12/12 notifications runs, 0 flaky** |
| `npx turbo lint typecheck --filter=@hushbox/e2e --force`                                                              | **EXIT=0** — `Tasks: 2 successful, 2 total`, run after the last edit |

### The passing run, verbatim

```
✓  45 [chromium] › e2e/notifications/notifications.spec.ts:76:3 › Notifications › takes the browser permission from the offer and registers the push service worker @chromium-only (4.9s)
✓  47 [chromium] › e2e/notifications/notifications.spec.ts:51:3 › Notifications › offers notifications once, and remembers "Later" on this device @chromium-only (4.9s)
✓  44 [chromium] › e2e/notifications/notifications.spec.ts:106:3 › Notifications › shows one generic, content-free notification for a push that arrives while the app is not open @chromium-only (5.6s)
✓  46 [chromium] › e2e/notifications/notifications.spec.ts:149:3 › Notifications › saves every notification preference to the account, and turning them all off retires the offer @chromium-only (5.5s)

  47 passed (1.6m)

E2E report (source of truth for debugging): e2e/report/2026-07-25T02-45-30/REPORT.md (0 failed, 0 flaky, 47 passed)
```

Preceded by `pnpm e2e:prepare` (containers, migrations, catalog refresh, seed — all
clean: *"catalog:refresh: all E2E_MODELS present"*, *"309 personas processed"*).

The `--repeat-each=3` confirmation run, 4 tests × 3 = 12 executions, every one a `✓`,
`0 failed, 0 flaky`. Per-test wall time rises to 12–26 s there purely from running 12
browsers at once on a 24-core box; nothing in the suite scales on wall clock.

### The one config deviation, and its exact extent

`playwright.config.ts` declares `reuseExistingServer: false` for all four webServers,
and port 7400 (Sandbox) is still held by another workstream's orphaned dev server —
so the shipped config refuses to start. Verified: 7400 `OPEN`, while 4173/8788/7000
are free.

Per the brief's allowance I ran through a temporary root-level config that imports
the shipped one and changes **one field**:

```ts
import base from './playwright.config';
export default {
  ...base,
  webServer: servers.map((server) =>
    server.name === 'Sandbox' ? { ...server, reuseExistingServer: true } : server
  ),
} satisfies PlaywrightTestConfig;
```

It sat at the repo root rather than in the scratchpad on purpose: Playwright resolves
`testDir`, `globalSetup`, `globalTeardown`, `reporter` and every `storageState` against
the config file's own directory, so a scratchpad copy would have silently diverged from
the real harness on all of them — the run would have proven the wrong thing. Nothing
else in the config was altered; every project, timeout, worker count, reporter,
guardrail and setup dependency is the shipped one. The file was **deleted immediately
after the run** and `git status` confirms it is gone.

The `playwright.config.ts` diff visible in the working tree (a new `Sandbox` webServer
block) is **not mine** — it predates this pass and belongs to the sandbox-origin
workstream. It is, in fact, the very server whose port collision forced the workaround.

## Acceptance criteria

Report 1's evidence for the spike-bound criteria stands unchanged and is not restated
here. What this pass changes:

- **Settings: card round-trips prefs (toggles, quiet hours incl. validation)** — now
  genuinely **met and executed**: category toggle, quiet-hours-on (whole window in one
  write), a bound change through the `From` Select, and the global switch — each polled
  against `GET /notifications/preferences`, all four passing.
- **Global-off suppresses the prompt** — **met and executed** (the `/chat` load after
  the global switch goes off).
- **Prompt: appears once / Later never re-shows / suppressed when already granted** —
  **met and executed** (tests 1 and 2 now pass end to end, including teardown).
- **Delivery: CDP-injected push → generic per-category copy, `tag` = raw
  `conversationId`, no visible text containing the id** — **met and executed**. The
  corrected plan criterion (device-local tag = raw `conversationId`) is exactly what the
  spec asserts; no assertion changed.
- **Suite green at retries=0** — **met**: 4/4 in the required command, and 12/12 under
  `--repeat-each=3`.
- **Runtime within the shared suite budget** — met: 4.9–5.6 s per test, ~21 s of test
  work for the whole suite.

Still **not met and not achievable**, unchanged from report 1 with its recorded
evidence: `subscription registered` (no browser here issues a push subscription) and
`click → app lands on /chat/:id` (no programmatic notification-click trigger exists).

## Deviations with reasons

Report 1's six deviations all stand. One addition:

7. **The verification run used a temporary root-level config** whose only difference is
   `reuseExistingServer: true` on the Sandbox webServer, forced by a port another
   workstream holds. Described in full above; the file is deleted.

## Nothing was weakened — how that was verified

- `grep -nE "retries|test\.slow|waitForTimeout|sleep|setTimeout|test\.skip|test\.fixme|\.only|toPass|soft" e2e/notifications/*.ts` → **no matches**.
- No assertion was deleted or loosened: the diff is three additions (a visibility gate,
  two guardrail opt-outs, one restore call) plus one navigation swapped for the harness's
  existing preferences-gated navigation. Every `expect` from report 1 is still present
  and still asserts the same thing.
- The console opt-out is one browser-emitted sentence on two of four tests, never a
  blanket disable; tests 1 and 4 keep the guardrail whole.
- `--retries=0` was passed explicitly on both runs; the config's own retry setting was
  never touched.

## Concerns and limitations

- The suite still needs the **full `chromium` binary**, not the headless shell. CI's
  `playwright install chromium` fetches it; a future CI change that installs only the
  shell fails all four tests loudly with the permission error.
- The suppressed-while-focused rule remains E2E-unverified by choice (report 1, spike
  finding 4) — `handlers.test.ts` is its only guard.
- **The orphaned dev server on port 7400 still blocks every unmodified E2E run on this
  box**, for every workstream, not just this task. Someone with the authority to reclaim
  it should; nothing in this task can.
- Test 4's restore does not run if the test fails partway, since spec-level hooks are
  banned. No notifications test is affected (each states its own preferences), and no
  other spec reads these fields today.

## Confidence

**High.** Every criterion this pass touches was executed, not reasoned about: 4/4 at
`--retries=0`, then 12/12 under repeat-each, with the console guardrail live and the
full teardown passing. The two permanently-unachievable criteria carry report 1's
reproducible evidence. What keeps it short of certainty is the config workaround — one
field, on a webServer this suite never contacts, but the shipped config has still never
started clean on this box.
