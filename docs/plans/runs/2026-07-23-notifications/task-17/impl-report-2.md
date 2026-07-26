# Task 17 — impl report 2 (fix pass)

## Objective

Two changes on top of impl-1's sidebar move:

1. **Rail affordance** (founder ruling, supersedes "not rendered in rail"): in the
   collapsed rail, render a compact aria-labelled bell that expands the sidebar to reveal
   the card, obeying the card's visibility rules through the same hook.
2. **Fix the two suites the move invalidated**: the Playwright notifications spec (expand
   the sidebar before asserting the offer) and the two Maestro flows (open the mobile
   drawer before asserting the offer text), without weakening any assertion and with
   flow 07's launch-time `assertNotVisible: 'Allow'` still preceding every drawer tap.

## Files changed

- `apps/web/src/components/notifications/enable-prompt-rail.tsx` — **new**: the compact
  rail affordance. A separate file rather than a second export in `enable-prompt.tsx`,
  per CODE-RULES "one component per file".
- `apps/web/src/components/sidebar/sidebar.tsx` — the mount became a choice between the
  two presentations instead of a `!collapsed` gate; the comment updated to match.
- `apps/web/src/components/sidebar/sidebar.test.tsx` — the `useEnablePrompt` mock became
  per-test controllable (so "not owed the offer" can be stated); the two rail tests from
  impl-1 replaced by the five behaviors below.
- `e2e/notifications/notifications.spec.ts` — three tests expand the sidebar before
  asserting on the offer (two positive, one absence).
- `e2e/pages/sidebar.page.ts` — `ensureSidebarExpanded()` made public (it already existed
  and was already used internally by `openMoreMenu`); doc comment added. No behavior
  change.
- `mobile-tests/flows/07-push-notification-prompt.yaml` — two hamburger taps added.
- `mobile-tests/flows/15-notification-enable-grant.yaml` — one hamburger tap added.

Untouched, as required: `apps/web/src/hooks/notifications/use-enable-prompt.ts`,
`apps/web/src/lib/notification-channel/prompt-dismissal.ts`, and the card itself
(`apps/web/src/components/notifications/enable-prompt.tsx` — its copy and button names are
unchanged, which both suites select on).

Proof they are byte-unchanged — `git diff HEAD` over all three is empty, and their mtimes
predate this pass (the run's other files carry 2026-07-25 12:42–12:46):

```
$ git diff HEAD --stat -- apps/web/src/hooks/notifications/use-enable-prompt.ts \
    apps/web/src/lib/notification-channel/prompt-dismissal.ts \
    apps/web/src/components/notifications/enable-prompt.tsx
(no output)

2026-07-24 17:11:32  apps/web/src/hooks/notifications/use-enable-prompt.ts
2026-07-24 17:11:51  apps/web/src/lib/notification-channel/prompt-dismissal.ts
2026-07-25 12:12:58  apps/web/src/components/notifications/enable-prompt.tsx   (impl-1's edit)
2026-07-25 12:42:38  apps/web/src/components/notifications/enable-prompt-rail.tsx
2026-07-25 12:42:46  apps/web/src/components/sidebar/sidebar.tsx
```

(`HEAD` moved mid-pass — see Concerns 1 — so `git diff HEAD` is evidence as of the
founder's 39a07db0 commit, which post-dates every source edit in this pass; the mtimes
carry the rest.)

## Evidence — the rail affordance, full source

`apps/web/src/components/notifications/enable-prompt-rail.tsx`:

```tsx
import { Bell } from 'lucide-react';
import { Button } from '@hushbox/ui';
import { useUIStore } from '@/stores/ui';
import { useEnablePrompt } from '@/hooks/notifications/use-enable-prompt';
import type * as React from 'react';

/**
 * The collapsed-rail stand-in for the one-time notification offer.
 *
 * The rail is 48px wide, so the card's copy cannot live there — but the
 * sidebar starts collapsed, so dropping the offer entirely would hide it from
 * every first-time desktop user. This keeps a labelled bell in the rail that
 * expands the sidebar, where the card itself is waiting.
 *
 * It answers to the same `useEnablePrompt` state as the card, so both appear
 * and retire together; expanding is navigation, never an answer to the offer.
 */
export function NotificationEnablePromptRail(): React.JSX.Element | null {
  const { isVisible } = useEnablePrompt();
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);

  if (!isVisible) return null;

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={toggleSidebar}
      aria-label="Turn on notifications"
      className="relative mt-2 shrink-0 self-center"
    >
      <Bell className="h-4 w-4" aria-hidden="true" />
      <span
        aria-hidden="true"
        className="bg-primary absolute top-1 right-1 h-1.5 w-1.5 rounded-full"
      />
    </Button>
  );
}
```

Against each requirement:

- **Same visibility rules, no duplicated logic (G3).** It consumes `useEnablePrompt` and
  nothing else — the single `isVisible` the card reads (dismissed / permission not
  `default` / no push path / global setting off all resolve inside the hook). No condition
  is restated here.
- **Existing expand mechanism.** `useUIStore((state) => state.toggleSidebar)` — the same
  store action the sidebar header's own expand control uses (`sidebar.tsx:145` passes
  `toggleSidebar` as the desktop `onClose`). No new state, field, prop, or handler:

  ```tsx
  // apps/web/src/stores/ui.ts:17
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  // apps/web/src/components/sidebar/sidebar.tsx (desktop arm of onClose, pre-existing)
  : toggleSidebar
  ```

  The affordance only exists while collapsed, so toggle is unambiguously "expand".
- **Real accessible name, keyboard reachable.** `aria-label="Turn on notifications"` on a
  `@hushbox/ui` `Button` (a real `<button>`, so tab-reachable and Enter/Space-activated);
  the icon and the dot are both `aria-hidden`, so the label is the whole accessible name.
  The name is asserted by four tests via `getByRole('button', { name: 'Turn on
  notifications' })`.
- **Tokens only (G8).** `variant="ghost"`, `size="icon-sm"`, `bg-primary` for the dot. No
  inline `style`, no literal color or font value.
- **Expanding does not consume the offer.** The click handler is the store toggle alone —
  neither `enable` nor `dismiss` is destructured, so neither can be called. Pinned by the
  test below.
- **No card text in the rail.** The button carries an icon and a dot; the copy stays in
  the card.

The mount (`sidebar.tsx`, final):

```tsx
      {renderSidebarBody()}
      {/* Last in the body, so the offer sits between the conversation list and
          the account footer. The 48px rail cannot carry the card's copy, so it
          carries a bell that expands the sidebar instead; the mobile drawer is
          full width and always gets the card. */}
      {collapsed ? <NotificationEnablePromptRail /> : <NotificationEnablePrompt />}
```

`collapsed = !isMobile && !sidebarOpen` (pre-existing, `sidebar.tsx:49`), so the mobile
drawer keeps the card unchanged.

## Evidence — the rail affordance's tests

All in `sidebar.test.tsx` → `describe('notification offer')`, against the real components
(only `useEnablePrompt` is mocked, so the affordance, the store, and the card are the real
implementations):

| Test | Behavior | Brief requirement |
| --- | --- | --- |
| `carries the full card, not the compact button, while the sidebar is expanded` | expanded + eligible → `Enable` present, no bell | "expanded + eligible → card renders, affordance does not" |
| `shrinks to a compact button in the rail, which is too narrow for the card` | rail + eligible → bell present, no `Enable` | "rail + eligible → affordance renders, card does not" |
| `reveals the card by expanding the sidebar when the compact button is pressed` | click → `useUIStore.getState().sidebarOpen === true` **and** `Enable` in the tree | "click → sidebar expands and the card is reachable" |
| `leaves the rail empty when the device is not owed the offer` | `isVisible: false` + rail → neither bell nor `Enable` | "rail + not eligible → nothing renders" |
| `leaves the offer unanswered when the compact button expands the sidebar` | after the click, `dismiss` and `enable` were never called | "expanding must not dismiss or consume the offer" |

Carried over unchanged and still green: `sits below the conversation list`, `sits above the
account footer`, `renders inside the mobile drawer`. Replaced: impl-1's `stays out of the
collapsed rail…` and `comes back when the rail is expanded` — both stated the superseded
"rail renders nothing" rule, and their content is now covered by rows 2 and 3.

**TDD.** The five tests were written and run before the component existed. Three failed for
the expected reason and two passed vacuously (they assert the *absence* of a bell that did
not yet exist), which is why the load-bearing ones are the three positives:

```
 × shrinks to a compact button in the rail, which is too narrow for the card
 × reveals the card by expanding the sidebar when the compact button is pressed
 × leaves the offer unanswered when the compact button expands the sidebar
TestingLibraryElementError: Unable to find an accessible element with the role "button" and name "Turn on notifications"

 Test Files  1 failed (1)
      Tests  3 failed | 35 passed (38)
```

After the component + mount: `Test Files 1 passed (1) / Tests 38 passed (38)`.

## Evidence — the Playwright spec

Mechanism: `SidebarPage.ensureSidebarExpanded()` — an **existing** page-object method
(mobile drawer if the viewport is mobile, then clicks the sidebar's own `Expand sidebar`
button if collapsed) that was already used internally by `openMoreMenu`. It was made
public and documented; nothing about its behavior changed. Selectors stay semantic
(`getByRole('button', { name: 'Expand sidebar' })` inside the sidebar) — no literal
`data-testid`, no retries, no sleeps, no `test.slow()`, and no assertion weakened or
deleted.

Three insertions:

```ts
// 1 — "offers notifications once, and remembers Later on this device"
    await waitForAppStable(authenticatedPage);

    // The offer lives in the sidebar body, and the sidebar remembers being
    // collapsed, so a fresh profile lands on the rail. Expanding it is the
    // step a person takes to reach anything the sidebar holds.
    const sidebar = new SidebarPage(authenticatedPage);
    await sidebar.ensureSidebarExpanded();

    const offer = enableOffer(authenticatedPage);
    await expect(offer).toBeVisible();
```

```ts
// 1b — same test, after the reload that proves "Later" is permanent
    await reloadWithPreferences(authenticatedPage);
    await waitForAppStable(authenticatedPage);
    // Expanded again rather than assumed: the assertion below only means
    // something while the place the offer would render is on screen.
    await sidebar.ensureSidebarExpanded();
    await expect(offer).toBeHidden();
```

```ts
// 2 — "takes the browser permission from the offer …"
    await waitForAppStable(authenticatedPage);
    await new SidebarPage(authenticatedPage).ensureSidebarExpanded();

    const offer = enableOffer(authenticatedPage);
```

```ts
// 3 — "… turning them all off retires the offer"
    // The sidebar is opened first so the absence below is the account switch
    // talking, not a collapsed rail hiding the offer either way.
    await new SidebarPage(authenticatedPage).ensureSidebarExpanded();
    await expect(enableOffer(authenticatedPage)).toBeHidden();
```

Insertions 1b and 3 are beyond the two tests the brief named: both assert the offer is
**hidden**, and after the sidebar move a collapsed rail would satisfy them for the wrong
reason. Expanding first keeps them proving what they claim. Nothing was removed to make
room. (`ensureSidebarExpanded` is idempotent — it clicks only if the collapsed control is
visible — so the extra call is a no-op when the state persisted across the reload.)

Full passing run (4/4 notifications tests; the other 43 are the per-persona auth setup
project the suite depends on):

```
$ npx tsx scripts/with-env.ts playwright test \
    --config=playwright.tmp-reuse-sandbox.config.ts \
    e2e/notifications/ --project=chromium --retries=0
…
  ✓  46 [chromium] › e2e/notifications/notifications.spec.ts:52:3 › Notifications › offers notifications once, and remembers "Later" on this device @chromium-only (5.2s)
  ✓  45 [chromium] › e2e/notifications/notifications.spec.ts:86:3 › Notifications › takes the browser permission from the offer and registers the push service worker @chromium-only (5.6s)
  ✓  44 [chromium] › e2e/notifications/notifications.spec.ts:117:3 › Notifications › shows one generic, content-free notification for a push that arrives while the app is not open @chromium-only (5.7s)
  ✓  47 [chromium] › e2e/notifications/notifications.spec.ts:160:3 › Notifications › saves every notification preference to the account, and turning them all off retires the offer @chromium-only (5.8s)

  47 passed (2.0m)

E2E report (source of truth for debugging): e2e/report/2026-07-25T17-07-05/REPORT.md (0 failed, 0 flaky, 47 passed)
EXIT=0
```

**The temporary config, exactly as used.** The first attempt aborted:

```
Error: http://localhost:7400/render.html is already used, make sure that nothing is
running on the port/url or set reuseExistingServer:true in config.webServer.
```

Port 7400 is held by another workstream's orphaned sandbox server (`tsx src/serve.ts`,
started Fri Jul 24 18:26, still answering `200` on `/render.html`); it was not touched.
The brief's fallback was used — a root config that imports the shipped one and flips only
that entry:

```ts
// playwright.tmp-reuse-sandbox.config.ts  (created, used once, deleted)
import base from './playwright.config';

const servers = Array.isArray(base.webServer) ? base.webServer : [];

export default {
  ...base,
  webServer: servers.map((server) =>
    server.name === 'Sandbox' ? { ...server, reuseExistingServer: true } : server
  ),
};
```

Deleted immediately after the run; `ls playwright*` now shows only `playwright.config.ts`.
One complication, raised in Concerns 1: it was swept into a founder commit while it
existed, so its removal is currently an uncommitted worktree deletion rather than a
never-existed file.

`pnpm e2e:prepare` ran first (stack + catalog + seed, exit 0).

## Evidence — the two Maestro flows

`07-push-notification-prompt.yaml`, first insertion — note the two launch-time
`assertNotVisible: 'Allow'` blocks (post-launch and post-shell-mount) both **precede** it:

```yaml
# Mounting the authenticated shell is the other moment something could ask on
# mount, so the absence is asserted again once the shell has settled.
- waitForAnimationToEnd:
    timeout: 5000
- assertNotVisible: 'Allow'

# The offer lives in the sidebar, which on a phone is a drawer whose contents
# are unmounted while it is closed — so the offer is not in the hierarchy until
# the drawer opens. `hamburger-button` carries a literal HTML `id`, which
# Maestro's `id:` selector matches (`id:` matches an `id` attribute, never
# `data-testid`). This comes after the launch-time absence assertions above, so
# they still prove nothing asks for permission on its own.
- tapOn:
    id: 'hamburger-button'

# The offer itself: an inline callout in the sidebar, never a system dialog. Its
# copy is matched loosely because it wraps across lines in the view hierarchy.
- extendedWaitUntil:
    visible: '.*Turn on notifications.*'
    timeout: 15000
- assertVisible: 'Enable'
- assertVisible: 'Later'
```

`07`, second insertion — after the relaunch + re-login, the flow's `assertNotVisible:
'Allow'` again runs first, then the drawer is reopened so the dismissal assertions are not
satisfied merely by a closed drawer:

```yaml
- waitForAnimationToEnd:
    timeout: 5000
- assertNotVisible: 'Allow'

# The drawer is opened again before the absence assertions below: with it shut
# the offer would be missing whatever the device answered, which would prove
# nothing. "Search chats" is the drawer's own field — waiting for it is how the
# assertions stay about the offer rather than about a drawer that never opened.
- tapOn:
    id: 'hamburger-button'
- extendedWaitUntil:
    visible: 'Search chats'
    timeout: 15000
- assertNotVisible: '.*Turn on notifications.*'
- assertNotVisible: 'Enable'
```

The only reordering in that block: `assertNotVisible: 'Allow'` moved from last to first of
the three absence assertions, so it still runs before any drawer interaction. All three
assertions are retained verbatim.

`15-notification-enable-grant.yaml`:

```yaml
# The offer lives in the sidebar, which on a phone is a drawer whose contents
# are unmounted while it is closed — so the offer is not in the hierarchy until
# the drawer opens. `hamburger-button` carries a literal HTML `id`, which
# Maestro's `id:` selector matches (`id:` matches an `id` attribute, never
# `data-testid`).
- tapOn:
    id: 'hamburger-button'

# The offer is an inline callout; its copy is matched loosely because it wraps
# across lines in the view hierarchy.
- extendedWaitUntil:
    visible: '.*Turn on notifications.*'
    timeout: 15000

# No system dialog until the tap — without this the assertion after the tap
# could be satisfied by a dialog that was already on screen.
- assertNotVisible: 'Allow'
- tapOn: 'Enable'
```

Flow 15's own `assertNotVisible: 'Allow'` guard is untouched and still sits immediately
before `tapOn: 'Enable'`. Everything after (the OS dialog, the grant, the retirement
assertions) is unchanged; the drawer stays open through them, because nothing in that
stretch navigates.

`hamburger-button` is the opener the repo already uses for this (`14-document-renders.yaml`
taps the same id for the same reason), and `HamburgerButton` carries a literal
`id="hamburger-button"` (`apps/web/src/components/sidebar/hamburger-button.tsx:18`), which
is what Maestro's `id:` selector matches.

**Validation, given Maestro cannot run here.** Both files parse, and the step order is what
the requirements demand:

```
$ node -e "yaml.loadAll(...)"
mobile-tests/flows/07-push-notification-prompt.yaml | documents: 2 | steps: 46
  order: launchApp -> extendedWaitUntil -> waitForAnimationToEnd -> assertNotVisible:Allow
       -> tapOn -> … -> waitForAnimationToEnd -> assertNotVisible:Allow
       -> tapOn#hamburger-button -> extendedWaitUntil -> assertVisible -> assertVisible
       -> tapOn -> assertNotVisible:Enable -> assertNotVisible:.*Turn on notifications.*
       -> launchApp -> … -> waitForAnimationToEnd -> assertNotVisible:Allow
       -> tapOn#hamburger-button -> extendedWaitUntil
       -> assertNotVisible:.*Turn on notifications.* -> assertNotVisible:Enable
mobile-tests/flows/15-notification-enable-grant.yaml | documents: 2 | steps: 23
  order: launchApp -> … -> tapOn#hamburger-button -> extendedWaitUntil
       -> assertNotVisible:Allow -> tapOn -> extendedWaitUntil -> tapOn
       -> extendedWaitUntil -> assertNotVisible:Enable -> assertNotVisible:Later
```

Every selector the taps and waits use exists in the built app (`apps/web/dist`, the bundle
built by this pass's e2e run — the same web build Capacitor ships):

```
hamburger-button       assets/page-header-BYsA6dki.js
Search chats           assets/app-shell-3tcGeLRm.js
Turn on notifications  assets/app-shell-3tcGeLRm.js   (card heading AND rail aria-label)
Later                  assets/app-shell-3tcGeLRm.js
```

and the bundle shows both presentations compiled in:

```js
jsxDEV("h2", { className: "text-sm font-medium", children: "Turn on notifications" })
jsxDEV(Button, { variant: "ghost", size: "icon-sm", onClick: toggleSidebar,
                 "aria-label": "Turn on notifications", … })
```

Stated plainly: **the Maestro flows remain CI/device-verified only.** They were not
executed here — the emulator path is blocked by a pre-existing repo-wide `cap sync`
failure — so the evidence above is parse + selector-existence, not a run.

## Self-gate

All run after the LAST edit.

- `npx turbo lint --filter=@hushbox/web --force` — **pass** (exit 0).

```
• Packages in scope: @hushbox/web
   • Running lint in 1 packages
   • Remote caching disabled

@hushbox/web:lint: cache bypass, force executing eebff70d5701222b
@hushbox/web:lint:
@hushbox/web:lint: > @hushbox/web@0.0.0 lint /workspace/popper-mobile/.superset/projects/HushBox/apps/web
@hushbox/web:lint: > eslint .

 Tasks:    1 successful, 1 total
Cached:    0 cached, 1 total
  Time:    4m31.062s

EXIT=0
```

- `npx turbo typecheck --filter=@hushbox/web --force` — **pass** (exit 0).

```
• Packages in scope: @hushbox/web
   • Running typecheck in 1 packages
   • Remote caching disabled

@hushbox/web:typecheck: cache bypass, force executing 448141a631c1271c
@hushbox/web:typecheck:
@hushbox/web:typecheck: > @hushbox/web@0.0.0 typecheck /workspace/popper-mobile/.superset/projects/HushBox/apps/web
@hushbox/web:typecheck: > tsgo --noEmit && tsgo --noEmit -p tsconfig.native-tests.json

 Tasks:    1 successful, 1 total
Cached:    0 cached, 1 total
  Time:    6.971s

EXIT=0
```

- `npx turbo lint typecheck --filter=@hushbox/e2e --force` — **pass** (exit 0).

```
• Packages in scope: @hushbox/e2e
   • Running lint, typecheck in 1 packages
   • Remote caching disabled

@hushbox/e2e:typecheck: cache bypass, force executing d3c97cb6269c87e2
@hushbox/e2e:lint: cache bypass, force executing 93d053cb0680eab5
@hushbox/e2e:typecheck: > tsgo --noEmit
@hushbox/e2e:lint: > eslint .

 Tasks:    2 successful, 2 total
Cached:    0 cached, 2 total
  Time:    1m1.912s

EXIT=0
```

- `pnpm test:web` — **pass** (exit 0), coverage gate included.

```
 Test Files  393 passed (393)
      Tests  6389 passed (6389)
   Duration  461.71s
EXIT=0
```

Per-file coverage for the files this pass owns:

```
  ...ompt-rail.tsx  |     100 |      100 |     100 |     100 |    (enable-prompt-rail.tsx)
  ...le-prompt.tsx  |     100 |      100 |     100 |     100 |
  sidebar.tsx       |     100 |      100 |     100 |     100 |
  All files         |   99.65 |     98.8 |   99.76 |   99.86 |
```

No coverage failure on any file, so no attribution was needed.

- Playwright: `e2e/notifications/ --project=chromium --retries=0` — **pass**, 4/4 (47/47
  with the setup project). Output above.

## Acceptance criteria

1. **Rail renders a compact affordance, not nothing** — **met**. Aria-labelled bell with a
   dot; source and tests above.
2. **Clicking it expands the sidebar via the existing store toggle** — **met**;
   `toggleSidebar` quoted, asserted by `sidebarOpen === true` plus the card becoming
   reachable in the same test.
3. **Real accessible name, keyboard reachable, tokens only (G8)** — **met**; the four
   role+name queries are the proof of the name, `Button` is a real `<button>`, no inline
   color/font style anywhere in the file.
4. **Obeys the card's visibility rules through the same hook, no duplicated logic (G3)** —
   **met**; single `useEnablePrompt` consumer, `isVisible: false` test.
5. **Expanding does not dismiss or consume the offer** — **met**; `dismiss`/`enable`
   never called.
6. **Playwright spec expands the sidebar first; no assertion weakened, no retries/sleeps**
   — **met**; three insertions, existing page-object method, 4/4 green.
7. **Both Maestro flows open the drawer before asserting the offer, with flow 07's
   launch-time `assertNotVisible: 'Allow'` still first** — **met**; diffs and parsed step
   order above.
8. **`useEnablePrompt` / `prompt-dismissal.ts` untouched; "Enable"/"Later"/"Turn on
   notifications" unchanged** — **met**; empty `git diff HEAD`, mtimes, and the card
   component itself unedited this pass.

## Deviations

- The affordance lives in a **new file** (`enable-prompt-rail.tsx`) rather than inside
  `enable-prompt.tsx`, which the plan's Files list names. CODE-RULES requires one
  component per file, and the card and the rail are two presentations with different
  props-free contracts. The plan's other listed files are used as written.
- `e2e/pages/sidebar.page.ts` was edited (visibility of an existing method + doc comment).
  It is not in the plan's Files list, but the brief put the Playwright fix in scope and
  this is the reuse-over-reinvention path — the alternative was a second expand helper.
- Two extra Playwright insertions (1b and 3) beyond the two tests named in the brief, both
  strengthening absence assertions that the sidebar move had made satisfiable for the
  wrong reason. Explained above.

## Concerns and limitations

1. **A concurrent founder commit (39a07db0, "a whole lot", 13:06) swept up the temporary
   Playwright config while it existed.** The file
   (`playwright.tmp-reuse-sandbox.config.ts`) was created at ~13:04 for the sandbox-port
   workaround and deleted at ~13:09; the commit landed in between, so it is now **in
   HEAD**, and my deletion shows as an unstaged worktree deletion (`D
   playwright.tmp-reuse-sandbox.config.ts`). No git write is permitted to this agent, so
   the removal needs to ride the next commit. Nothing else about that commit is mine to
   assess; the same commit also contains this task's source edits.
2. **The Maestro flows are unverified by execution here** — parse + selector-existence
   only, per the brief. Their first real proof is CI/device.
3. **`Search chats` is the drawer-open anchor in flow 07's second block.** It is the
   sidebar's search field label and is rendered whenever the drawer is open, but it is a
   selector the flow did not previously depend on; if the sidebar's search field is ever
   relabelled, that flow needs the same edit. The alternative was a vacuous absence
   assertion.
4. **Product note, now resolved but worth stating:** the rail affordance closes the
   first-time-desktop-user gap raised in impl-1 concern 3. The offer is still not visible
   *as copy* until the sidebar is expanded — a person who never expands the sidebar sees
   only a bell — but it is now discoverable and unconsumed.

## Confidence

**High.** Every requirement is pinned by a test that was watched red first (for the three
positive rail behaviors), all four gates are green with full output, and the Playwright
suite — the one that actually broke — was executed and passes 4/4. The single unverified
surface is Maestro, which cannot run in this environment.
