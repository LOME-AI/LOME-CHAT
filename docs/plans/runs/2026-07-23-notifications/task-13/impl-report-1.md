# Task 13 — Playwright notifications spec — impl report 1

## Objective

A new `e2e/notifications/` Playwright suite covering the one-time enable offer, the
settings card, and — subject to a spike — real service-worker push delivery through
Chromium's CDP `ServiceWorker.deliverPushMessage`.

## The spike, and what it decided

**Verdict: CDP push injection WORKS, and the delivery test is in the suite.** Two
constraints came out of the spike and shaped the design; a third was found later by
stressing the result.

### 1. `ServiceWorker.deliverPushMessage` works — but only on the full Chromium binary

Matrix run against a throwaway origin + worker (scratch harness, Playwright 1.60,
`~/.cache/ms-playwright`):

| Launch                                   | `Notification.permission` after `grantPermissions` | `showNotification` | CDP push → notification seen |
| ---------------------------------------- | -------------------------------------------------- | ------------------ | ---------------------------- |
| default (`chromium_headless_shell`)      | `denied`                                            | throws             | **no**                       |
| `channel: 'chromium'` (full, new headless) | `granted`                                           | ok                 | **yes**                      |
| headful under Xvfb                       | `granted`                                           | ok                 | **yes**                      |

On the headless shell the permission grant is accepted by
`navigator.permissions.query()` (`granted`) while `Notification.permission` still reads
`denied` and `showNotification` throws `No notification permission has been granted for
this origin` — the shell has no notification backend. `Browser.setPermission` and
`Notification.requestPermission()` do not change that.

So the spec carries `test.use({ channel: 'chromium' })`. The full binary is installed by
the `playwright install chromium` the suite and CI already run (both `chromium-1223` and
`chromium_headless_shell-1223` are present locally from that one command; CI's e2e job
runs `pnpm exec playwright install ${{ matrix.browser }}` with `browser: chromium` for
the chromium project).

### 2. `PushManager.subscribe()` cannot succeed in any configuration here — subscription assertion descoped

| Context                                  | `pushManager.subscribe()` error                                          |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| default incognito context                | `AbortError: Registration failed - permission denied`, plus the browser's own console line: *"Chrome currently does not support the Push API in incognito mode"* (every Playwright `browser.newContext()` is incognito) |
| `launchPersistentContext` (real profile) | `AbortError: Registration failed - push service not available`           |
| full chromium, notifications **granted** | `AbortError: Registration failed - permission denied`                     |

A subscription needs a live push service, which rule 1.4 forbids in the hot path anyway.
The acceptance criterion "Enable → … → subscription registered (assert via API/dev
surface)" is therefore **not met as written and cannot be**: no browser in this harness
will issue a subscription, so the app never reaches its
`POST /notifications/web-subscriptions`. What the spec asserts instead is everything up
to that seam: the permission flips to `granted`, the app **registers and activates the
real `/sw.js`** (`subscribeAndRegister` registers the worker and awaits
`serviceWorker.ready` before `subscribe()` rejects), and the offer retires. The
subscribe→POST half stays covered by `web-adapter.test.ts` (17 unit tests, per Task 08).

### 3. Notification click has no programmatic trigger — descoped

There is no CDP method for it (the `ServiceWorker` domain has `deliverPushMessage`,
`dispatchSyncEvent`, `dispatchPeriodicSyncEvent` and nothing else; there is no
notification domain), and a `Notification` handle obtained from `getNotifications()`
exposes no click. So "click → app lands on `/chat/:id`" is **not met and cannot be** at
E2E level; `handlers.test.ts` covers `notificationclick` (focus-or-open, invalid-id drop).

### 4. Found by stressing: the focused-window rule cannot be asserted deterministically

The first delivery design used "another tab in front" for *away* and `bringToFront()` for
*looking at it*, and asserted both halves of the worker's focus rule. Both halves flipped
under parallel load — the browser must hold the **host's** focus for a tab to count as
focused, which no run can promise while several browsers run at once:

- `--repeat-each=8 --workers=4`: 1/8 failed — the focused push was **not** suppressed
  (received 3 notifications, expected 2).
- after reshaping: `--repeat-each=12 --workers=6`: 1/12 failed the other way — the *away*
  push produced **no** notification (received `[]`).

`Emulation.setFocusEmulationEnabled` does not reach the worker's view either (probed
directly: with another tab in front and emulation on, the push still notified).
`document.visibilityState` / `document.hasFocus()` report `visible` / `true` for every
page under automation regardless of which is in front, so there is no page-side signal to
gate on.

Resolution: the suite states *away* as **no window of the app open at all**
(`page.goto('about:blank')`, then back). With zero window clients the worker's
`windows.some(client => client.focused)` is false by construction. The app-in-front half
of the rule is left to `handlers.test.ts`, which already pins it. This is a genuine user
state (a push is the only thing that can reach you), not a workaround for a broken test.

Re-stressed after the change: **12/12 at 6 workers, 24/24 at 12 workers, 20/20 at 10
workers — 56 consecutive passes, zero flakes.**

## Files changed

| File                                    | Why                                                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `e2e/notifications/notifications.spec.ts` (new) | The four journeys. Semantic locators only.                                                              |
| `e2e/notifications/push-harness.ts` (new)       | Preferences API read/write, offer locator, permission, worker state, leave/return, CDP delivery, notification readback. All `page.evaluate` and protocol work lives here, never in the spec (rule 3.3). |

Nothing else was touched — `git status` lists `e2e/notifications/` as this task's only
repo footprint. No fixture was needed, so `e2e/fixtures.ts` is untouched.

## The spec's test list

All in `test.describe('Notifications', { tag: '@chromium-only' })`, so only the `chromium`
project runs them (every other browser project `grepInvert`s the tag) — confirmed by
`playwright test e2e/notifications/ --list`, which selects the 4 tests in `[chromium]`
and nowhere else.

1. **`offers notifications once, and remembers "Later" on this device`** — the offer is
   visible for an eligible fresh session; neither answer holds focus; "Later" hides it;
   after a reload whose preferences read has landed, it is still gone.
2. **`takes the browser permission from the offer and registers the push service worker`**
   — permission is staged with `grantPermissions` (the platform prompt is browser chrome
   no test can click), Enable → `Notification.permission` becomes `granted`, the real
   `/sw.js` is active, the offer is gone, and it stays gone on the next load
   (suppressed-when-already-granted).
3. **`shows one generic, content-free notification for a push that arrives while the app
   is not open`** — an already-permitted device registers its worker at app start; leave
   the app; CDP-inject `{category:'message', conversationId}`; come back and find exactly
   one notification carrying the fixed per-category copy with `tag === conversationId`;
   a second push for the same conversation replaces rather than stacks (tag collapse);
   no visible text contains the conversation id (G1).
4. **`saves every notification preference to the account, and turning them all off
   retires the offer`** — a category toggle, quiet hours on (both bounds + timezone as one
   write), a bound change through the hour Select, then the account switch off — each
   proven against `GET /notifications/preferences`, not the switch (rule 1.5) — and with
   the account switch off the offer no longer appears on `/chat`.

## Commands run, and their output

- `npx turbo lint typecheck --filter=@hushbox/e2e --force` — **EXIT=0**, run **after the
  last edit** (`Tasks: 2 successful, 2 total`, `eslint .` and `tsgo --noEmit`, 44.3s).
  An earlier `eslint notifications/` reported 12 errors (prettier layout,
  `unicorn/no-await-expression-member`, `unicorn/no-array-sort`); all were fixed —
  `savedPreference(request, field)` replaced the `(await fetch…).field` reads and
  `toSorted` replaced `sort`.
- `tsx scripts/with-env.ts playwright test e2e/notifications/ --list` — exit 0; the 4
  tests listed under `[chromium]` only.
- **The suite itself was not run**, and the reason is environmental, not the spec's:
  `pnpm e2e` declares `reuseExistingServer: false` for all four webServers, and two of
  the ports it needs are held by **orphaned dev servers from another session** —
  `wrangler dev --port 8788` (~3 h old) and `pnpm --filter @hushbox/sandbox dev` on 7400,
  both re-parented to init, neither started by this task. Killing another agent's servers
  is out of bounds, so the official run is blocked here. The `apps/web/dist` present on
  the box is a **production** build (`VITE_API_URL=https://api.hushbox.ai`), so it cannot
  stand in either, and rebuilding it (`pnpm build:e2e`) rewrites the committed
  `.env.development` and the shared `dist/` other agents are using.

  What **was** executed against real Chromium instead, over a static server on the
  existing `dist` (a scratch Playwright config in the scratchpad, importing the shipped
  harness module by absolute path — no repo file involved):

  - `notificationPermission()` → `default` before the grant, `granted` after
    `allowNotifications()` — the offer's precondition and test 2's mechanism.
  - `enableOffer()` resolves with no strict-mode violation on the real app shell (which
    renders 2 `status` regions).
  - `waitForPushServiceWorker()` (poll + CDP `ServiceWorker.enable` + registration
    capture) against the shipped `dist/sw.js`.
  - `leaveApp()` / `deliverPush()` / `returnToApp()` / `deliveredNotifications()` →
    `[{title:'New message', body:'You have a new message.', tag:<id>}]`, then the same
    tag with the `runCompletion` copy after the second push (collapse), then the
    no-id-in-text assertion — i.e. **test 3's entire body, on the real worker**, 56/56
    green up to 12 parallel workers.
  - Also observed directly on the shipped worker: pushes with a non-uuid
    `conversationId` and with an unknown category are dropped (no notification), which is
    the strict-schema validation working end to end.

  What remains CI-verified only: the app-glue that needs the e2e bundle + local API —
  the offer actually rendering once preferences load, the Enable click driving the app's
  own flow, and the settings-card round-trip (tests 1, 2 and 4, and test 3's first three
  lines). Every one of those selectors is taken from the components as shipped
  (`role="switch"` names `All notifications` / `Finished runs` / `Quiet hours`,
  `role="combobox"` names `From` / `Until`, buttons `Enable` / `Later`), and the same
  names are what Task 10's 23 component tests query.

## Acceptance criteria

- **Prompt: appears once for an eligible fresh session** — met (test 1).
- **Enable → permission granted** — met (test 2). **→ subscription registered (assert via
  API/dev surface)** — **not met, and not achievable**: see spike finding 2. Test 2
  asserts the furthest observable point, the activated real `/sw.js`.
- **Later → never re-shows across reload** — met (test 1), with the reload gated on the
  preferences response so "still hidden" is a decision the app reached, not a screen it
  had not drawn.
- **Suppressed when permission already granted** — met (test 2's second load).
- **Settings: card round-trips prefs (toggles, quiet hours incl. validation)** — met
  (test 4), against server truth. "Validation" is asserted as the structural
  both-or-neither invariant the card enforces (a whole `{start, end, timezone}` object or
  `null` — the UI has no path that writes half a window); the rejection of a half-filled
  body is server-side and pinned by the slice's own tests, and cannot be provoked
  through the UI.
- **Global-off suppresses the prompt** — met (test 4's last step).
- **Delivery: CDP-injected push → notification with generic per-category text + tag** —
  met (test 3). **`tag` is the raw `conversationId`, not an alias** — that is what the
  shipped worker sets, per Task 07's recorded deviation (the strict I1 payload has no
  alias field; the tag never leaves the device). The spec asserts the tag equals the
  conversation id and that no visible text contains it.
- **→ click → app lands on `/chat/:id`** — **not met, and not achievable**: spike
  finding 3.
- **Suite green at retries=0** — the delivery machinery is proven at retries=0 (56/56
  under parallel stress). The four assembled tests have not been run, for the
  environmental reason above.
- **Runtime within the shared budget** — 4 tests in one project; the delivery journey
  measured 0.7–2.1 s per run in the scratch harness (app boots dominate the other three).

## Deviations with reasons

1. **`test.use({ channel: 'chromium' })` at file scope.** Required: the suite's default
   headless shell cannot show a notification at all. It must be file-level — Playwright
   rejects `use({ channel })` inside a describe ("forces a new worker"), which the first
   `--list` caught. Combined with `@chromium-only`, no other project loads a test from
   the file, so no non-chromium project is ever asked to launch a chromium channel.
2. **"Away" is stated as "the app is not open", not "another window is in front"** —
   spike finding 4. The focused-suppression half of the worker's rule is deliberately not
   asserted here.
3. **Expected notification copy is a literal in the harness**, not imported from
   `apps/web/src/sw/notification-copy.ts`. This is the test of what a person reads; a copy
   table feeding both sides would agree with itself no matter what it said. (The
   CODE-RULES duplication ban targets logic that must agree to be correct, with an
   explicit carve-out for independent authorities.)
4. **The pushed `conversationId` is a fixed synthetic uuid, not a real conversation.**
   The worker never looks an id up, and a real one would couple the test to
   `useClearReadElsewhere`, which closes notifications for conversations the user has
   fully read — an id outside the user's list cannot be tidied away mid-assertion.
5. **No `e2e:notifications` script was added to the root `package.json`** — out of this
   task's file ownership. Not every suite dir has one (`e2e/security`, `e2e/contracts`
   have none); the suite runs via
   `pnpm e2e:prepare && tsx scripts/with-env.ts playwright test e2e/notifications/ --project=chromium`.
   Raised for the orchestrator.
6. **Helpers live in `e2e/notifications/push-harness.ts`, not `e2e/helpers/`** — the
   file-ownership bound is `e2e/notifications/**`, and `e2e/admin/helpers/` is the
   precedent for a suite owning its own helper layer.

## Concerns and limitations

- **The whole suite depends on the full `chromium` binary being installed wherever it
  runs.** CI installs it (`playwright install chromium` fetches both binaries), and a
  developer who has run `pnpm e2e:browsers` has it. If a future CI change installs only
  the headless shell, all four tests fail at once, loudly, with the permission error —
  not silently.
- **Test 2's service-worker assertion rests on reading Task 08's adapter**: the worker is
  registered by `activeRegistration()` before `pushManager.subscribe()` rejects, so the
  rejected registration attempt still leaves an active worker. Verified by reading
  `web-adapter.ts`, not by running the app's own flow (the e2e bundle was unavailable).
  It is the single most likely place for a first red run.
- **The suppressed-while-focused behaviour is now E2E-unverified** by choice; if that
  rule regresses, only `handlers.test.ts` catches it.
- **Two orphaned dev servers (ports 8788 and 7400) from another session are blocking every
  E2E run on this box**, not just mine. Someone with the authority to reclaim them should.
- The suite writes account preferences for the shared `test-alice` persona; every test
  states the preferences it needs first, so order does not matter, but test 4 leaves the
  persona with notifications globally off and a quiet window set. No other spec reads
  those fields.

## Confidence

**Medium-high.** The novel machinery — the part that could have been fiction — is proven
against the real shipped service worker, 56 consecutive runs at up to 12 workers with no
flake, after two genuine flakes were found and designed out. The two descoped criteria
are backed by reproducible evidence rather than an assumption. What holds it below high
is that the four assembled tests have never executed as a suite: the app-glue
assertions (offer render, Enable click, settings round-trip) are built from the shipped
components' accessible names and the same API the app uses, but they are, honestly,
unrun.
