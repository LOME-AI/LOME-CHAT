# Task 20 — impl report 1

## Objective

Prove end to end, in a real browser, that a real message from another user arriving while
the user is genuinely not focused raises the tab title to `(1) HushBox` and drives
`navigator.setAppBadge(1)`, and that returning to the app clears both.

## Files changed

- `e2e/helpers/window-attention.ts` (new) — the away/back window levers (both CDP calls in
  one named pair) plus the wrap-and-delegate app-badge spy and its readers; all raw
  protocol and page evaluation lives here, never in the spec (rule 3.3).
- `e2e/group/realtime.spec.ts` — one added journey test, `@chromium-only`, on the existing
  group-conversation + `setupRealtimePair` fixtures (Pillar 4.1). No existing test touched.
- `e2e/notifications/push-harness.ts` — `leaveApp`'s doc comment narrowed (comment only, no
  behavior change).

## Tests added

- `Real-time WebSocket events › a message arriving while the user is looking away raises the
  unread title and app badge, and returning clears both` (`@chromium-only`).
  One journey, all invariants asserted inline:
  - baseline title is `HushBox` and the platform Badging API is present (so the badge half
    cannot be silently vacuous);
  - after `minimizeAndBlurWindow`, `document.hasFocus()` is `false` (the precondition
    assertion);
  - Bob (AI off) sends → `expect(page).toHaveTitle('(1) HushBox')` and the last badge call
    is `{kind:'set', count:1, settled:'fulfilled'}`;
  - after `restoreAndFocusWindow`, focus returns, the title is bare `HushBox` again, and
    the last badge call is `{kind:'clear', count:null, settled:'fulfilled'}` — zero routes
    through `clearAppBadge`, never `setAppBadge(0)`;
  - `'setAppBadge' in navigator` is still true at the end.

### Red → green (the lever is load-bearing)

The first version of the spec omitted the away lever and was run as written. It failed on
exactly the assertion the lever exists to enable, with the app behaving correctly:

```
    Error: expect(page).toHaveTitle(expected) failed
    Expected: "(1) HushBox"
    Received: "HushBox"
    - Expect "toHaveTitle" with timeout 10000ms
    > 102 |     await expect(authenticatedPage).toHaveTitle(`(1) ${APP_TITLE}`);
```

(A focused page does not count arrivals — `notification-activity.ts:41`.) The two CDP
calls were then added and the assertion passed. The earlier assertions in that same red run
also passed, which is where the F5 claim that the Badging API is real in this headless
browser was confirmed rather than assumed.

## Self-gate

| command | result |
| --- | --- |
| `turbo lint typecheck --filter=@hushbox/e2e --force` (after the LAST edit) | pass — 2 successful, 2 total |
| `eslint group/realtime.spec.ts helpers/window-attention.ts notifications/push-harness.ts` from `e2e/` | pass — exit 0 |
| touched suite at `--retries=0` (`playwright test e2e/group/realtime.spec.ts --project=chromium --retries=0`) | pass — 47 passed, 0 failed, 0 flaky |

Suite output (43 of the 47 are the `setup-chromium` persona-auth dependency project):

```
  ✓  44 [chromium] › e2e/group/realtime.spec.ts:138:3 › Real-time WebSocket events › typing indicator shows for other member (10.0s)
  ✓  46 [chromium] › e2e/group/realtime.spec.ts:82:3 › Real-time WebSocket events › a message arriving while the user is looking away raises the unread title and app badge, and returning clears both @chromium-only (10.4s)
  ✓  45 [chromium] › e2e/group/realtime.spec.ts:18:3 › Real-time WebSocket events › user-only message appears for other member in real time (10.8s)
  ✓  47 [chromium] › e2e/group/realtime.spec.ts:46:3 › Real-time WebSocket events › AI streaming: Bob sees Alice user message immediately and AI response progressively (12.2s)

  47 passed (3.0m)

E2E report: e2e/report/2026-07-27T04-38-49/REPORT.md (0 failed, 0 flaky, 47 passed)
EXIT=0
```

The green run used the final spec and final helper (both mtimes precede the run's start);
the only later edit is the push-harness comment, which the group suite does not import.

### Two earlier runs failed for a cause outside this task

Two attempts before the green one failed with **all four** realtime tests — the three
pre-existing ones included — dying in the `groupConversation` fixture on
`group-chat creation failed: 404`, i.e. before any of this task's code executed. Cause,
with evidence:

- `apps/api/.dev.vars`, `.env.development` and `.env.scripts` were rewritten at the exact
  second each run started, back to **development** mode (no `E2E="true"`), undoing the
  `e2e:prepare` that had just written e2e mode. Wrangler watches `.dev.vars`, so the API
  worker reloaded under the running suite.
- `pnpm test:api` (`package.json:25`) begins with `pnpm ensure-stack`, which is
  `generateEnvFiles(rootDir, Mode.Development)` — it rewrites those three files (and the
  four `.github/workflows/*.yml` env blocks).
- A concurrent `pnpm test:api` process was observed running during both attempts.
- Probed directly afterwards with the e2e env restored, `POST /dev/group-chat` answers
  `400` for an empty body and `201` for a real persona payload — the route is fine.

The green run was taken in a window when no `vitest`/`turbo test --filter=@hushbox/api`
process was running. (Even so, `.dev.vars` changed md5 between that run's start and end —
the window is narrow.)

## Acceptance criteria

| criterion | status | evidence |
| --- | --- | --- |
| Extends `e2e/group/realtime.spec.ts` on the existing fixtures; tagged `@chromium-only` | met | one added test at `realtime.spec.ts:82`, `{ tag: '@chromium-only' }`, using `groupConversation` + `setupRealtimePair`; the tag shows in the passing run line |
| Group conversation mandatory | met | uses the `groupConversation` fixture (2 members) — `use-group-chat.ts` opens the socket only when `members > 1` |
| Bob turns AI off before sending | met | `bobChatPage.getAiToggleButton()` clicked, asserted `AI response off` before the send |
| Badge spy via `context.addInitScript` BEFORE any navigation | met | `installAppBadgeSpy(authenticatedPage.context())` is the first statement; `createPageFixture` creates the page without navigating, and the first navigation is `setupRealtimePair`'s `gotoConversation` |
| Spy is wrap-and-delegate, not replace | met | it wraps only when the API exists, binds the real methods, returns the real promise, and records how the real promise settled; the test asserts `'setAppBadge' in navigator` is true both before and after, and asserts `settled: 'fulfilled'` on both calls — a stub returning nothing could not be fulfilled |
| Records both `setAppBadge` arguments and `clearAppBadge` calls | met | each entry carries `kind` + `count`; `set` recorded `count: 1`, `clear` recorded `count: null` |
| Precondition assertion `document.hasFocus() === false` after going away | met | `await expect.poll(() => hasWindowFocus(authenticatedPage)).toBe(false)` (the raw `page.evaluate(() => document.hasFocus())` sits in the helper per rule 3.3) |
| Title asserted with `expect(page).toHaveTitle('(1) HushBox')`, never `page.title()` | met | both title assertions are `toHaveTitle`; base title from `apps/web/index.html:154`, format from `use-activity-sinks.ts:28-31` |
| Restore fires a real `focus`; title returns to bare `HushBox`; spy recorded `clearAppBadge` | met | `restoreAndFocusWindow` → focus true → `toHaveTitle('HushBox')` → last call `{kind:'clear', count:null, settled:'fulfilled'}`, covering `use-activity-reset.ts:9-23` and `app-badge.ts:12`'s zero-routes-through-clear rule in the same journey |
| Both CDP mechanisms in ONE named helper pair in `e2e/helpers/`, unconfusable with `leaveApp`/`returnToApp` | met | `minimizeAndBlurWindow` / `restoreAndFocusWindow` in `e2e/helpers/window-attention.ts`; the names state the two mechanisms (window state + focus emulation) and cannot be read as navigation, which is what `leaveApp`/`returnToApp` do; the helper's own doc states the distinction |
| `push-harness.ts:229-243` comment NARROWED, not deleted | met | before/after below |
| Green at `--retries=0`; no `waitForTimeout`, no sleeps | met | suite output above; no timer call anywhere in the change (lint bans them repo-wide, and the gate is green) |
| Test-only; no production code changes | met | `git diff --stat` touches `e2e/` only |

### `push-harness.ts` comment — before

```
 * This, rather than "another window is in front", is how the suite states
 * "away". The worker withholds a notification only from a window focused on the
 * conversation it is about, and which window the host considers focused is not
 * something a run can promise while a parallel matrix drives several browsers at once — both
 * directions of that were seen to flip under load, and focus emulation does not
 * reach the worker's view. With no window of the app open at all there is
 * nothing to be focused and the outcome is fixed. The app-in-front half of the
 * rule is left to the worker's own unit tests rather than raced here.
```

### after

```
 * This, rather than "another window is in front", is how the suite states
 * "away" *to the service worker*. The worker withholds a notification only from
 * a window focused on the conversation it is about, and it reads that from the
 * `focused` flag on the clients `clients.matchAll()` returns — a
 * browser-process-wide view that no per-page focus control reaches, so both
 * directions of it were seen to flip under load. With no window of the app open
 * at all there is nothing to be focused and the outcome is fixed. The
 * app-in-front half of the rule is left to the worker's own unit tests rather
 * than raced here.
 *
 * This limitation is the worker's alone. A page's own attention state
 * (`document.hasFocus()`) is inside the page target and *is* controllable — see
 * the window-attention helper, which the group suite uses to test the unread
 * count and app badge on a genuinely unfocused window.
```

(The mechanism sentence is stated as the worker actually reads it — `client.focused` on the
result of `clients.matchAll({type:'window', includeUncontrolled:true})`, `sw/handlers.ts:140-141`
— rather than repeating the plan's `matchAll({focused:true})` shorthand, which the code
does not use.)

### Helper source (the two levers and the spy)

```ts
export async function minimizeAndBlurWindow(page: Page): Promise<void> {
  const session = await protocolSession(page);
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  const { windowId } = await session.send('Browser.getWindowForTarget');
  await session.send('Browser.setWindowBounds', {
    windowId,
    bounds: { windowState: 'minimized' },
  });
}

export async function restoreAndFocusWindow(page: Page): Promise<void> {
  const session = await protocolSession(page);
  const { windowId } = await session.send('Browser.getWindowForTarget');
  await session.send('Browser.setWindowBounds', {
    windowId,
    bounds: { windowState: 'normal' },
  });
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
}
```

Both CDP calls are present in the away lever, as F5 requires (each alone measured 0/6).
The return lever restores the window first and re-enables focus emulation second, so the
page sees the window's own `focus` event rather than one manufactured by the override, and
the page is left in the state the harness normally maintains.

The spy (`installAppBadgeSpy`) installs nothing when the platform has no Badging API —
inventing one would make `app-badge.ts:11`'s capability check pass on a browser where it
should not. When it does install, it binds the real methods first, and every wrapper
returns the real promise:

```ts
const realSet = navigator.setAppBadge.bind(navigator);
...
value: (count?: number): Promise<void> => record('set', count ?? null, () => realSet(count)),
```

`record` pushes an entry, calls through, and marks the entry `fulfilled`/`rejected` from the
real promise's own settlement. `Object.defineProperty` on the `navigator` instance leaves
`'setAppBadge' in navigator` true (the test asserts it), and the delegated promise is what
`settled: 'fulfilled'` proves.

## Deviations

- The plan writes the precondition as `expect.poll(() => page.evaluate(() =>
  document.hasFocus())).toBe(false)`. The assertion is in the test exactly as specified, but
  the `page.evaluate` sits behind `hasWindowFocus(page)` in the helper, because rule 3.3
  keeps raw page evaluation out of specs. Same assertion, same poll, no inline literal.
- `appBadgeCalls` is module-private and the spec reads through `lastAppBadgeCall`. The app
  badges on mount as well as on change, so the meaningful assertion is the call each step
  produced, not the whole history — and an exported-but-unused helper would trip
  `lint:unused`.

## Concerns and limitations

- **Stated caveat (badge):** there is no `getAppBadge` in any browser, so the badge is
  observed through a wrap-and-delegate spy. The call is real, the platform's real
  implementation runs and resolves; the observation is a spy. That leaf spy is unavoidable.
- **Stated caveat (lever):** the away state is staged over a CDP surface Playwright does
  not expose as API (`Emulation.setFocusEmulationEnabled` + `Browser.setWindowBounds`). It
  is Chromium-only — hence `@chromium-only` — and it does not work `--headed`. CI and every
  `e2e:*` script are headless, so it works where the tests run; a developer running
  `--headed` will see this test fail on its own precondition assertion, which is why that
  assertion is there.
- **Local-run environment (raised):** `pnpm e2e:prepare` and any concurrent `pnpm test:api`
  fight over `.env.development` / `.env.scripts` / `apps/api/.dev.vars` (and the four
  `.github/workflows/*.yml` env blocks), and the loser's running wrangler hot-reloads
  mid-suite. This is a checkout-wide coordination hazard, not a property of this test — in
  CI the e2e job owns its environment.
- The unread count is app-wide and per-session (`notification-activity.ts:20-25`), so the
  test asserts `(1)`; it does not exercise multi-event counting, which is unit-covered.

## Confidence

High. Every criterion is verified by an assertion in a run that was green at
`--retries=0`, the away lever was proven load-bearing by a red run that failed on exactly
the assertion it enables, and the two failed intermediate runs are attributed to a
concurrent workstream by direct evidence (mtimes, mode content, the `test:api` process, and
a post-hoc probe of the route that had 404'd).
