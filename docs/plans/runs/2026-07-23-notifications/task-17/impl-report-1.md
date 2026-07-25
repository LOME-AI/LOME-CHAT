# Task 17 — impl report 1

## Objective

Move the one-time notification offer out of `<main>` and into the left sidebar body —
after the conversation list, before the account footer — restyled as a vertical card for a
~260px column, with the rail (collapsed desktop sidebar) dropping it entirely. The
`useEnablePrompt` state machine and `prompt-dismissal.ts` stay untouched; the defect is
purely presentational.

## Files changed

- `apps/web/src/components/notifications/enable-prompt.tsx` — rewritten as a vertical card
  (heading + body + two answers) with the mandated copy; sidebar-appropriate tokens.
- `apps/web/src/components/notifications/enable-prompt.test.tsx` — copy assertion updated to
  the new body text; two behaviors added (heading, column layout).
- `apps/web/src/components/shared/app-shell.tsx` — mount + its comment + the import removed
  from `<main>`.
- `apps/web/src/components/shared/app-shell.test.tsx` — the "mounts the prompt" assertion is
  now a placement assertion (in the sidebar, not in `<main>`).
- `apps/web/src/components/sidebar/sidebar.tsx` — mount added as the last child of the
  sidebar body, gated on `!collapsed`.
- `apps/web/src/components/sidebar/sidebar.test.tsx` — `use-enable-prompt` mocked; five
  placement/rail/drawer behaviors added.

Untouched, as required: `apps/web/src/hooks/notifications/use-enable-prompt.ts` and
`apps/web/src/lib/notification-channel/prompt-dismissal.ts`. Neither is tracked by git yet
(both are uncommitted files from earlier tasks in this run), so the proof is mtime: both
still carry `2026-07-24 17:11`, while every file this task edited carries
`2026-07-25 12:12`.

```
2026-07-25 12:12:58 apps/web/src/components/notifications/enable-prompt.tsx
2026-07-25 12:12:42 apps/web/src/components/shared/app-shell.tsx
2026-07-25 12:12:50 apps/web/src/components/sidebar/sidebar.tsx
2026-07-24 17:11:32 apps/web/src/hooks/notifications/use-enable-prompt.ts
2026-07-24 17:11:51 apps/web/src/lib/notification-channel/prompt-dismissal.ts
```

## Evidence — the removed app-shell mount

Before (`app-shell.tsx`):

```tsx
      <main id="main" tabIndex={-1} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* A non-growing row above the route content; renders nothing unless
            this device is still owed the one-time notification offer. */}
        <NotificationEnablePrompt />
        {children}
      </main>
```

After:

```tsx
      <main id="main" tabIndex={-1} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </main>
```

The import `import { NotificationEnablePrompt } from '@/components/notifications/enable-prompt';`
is gone from the file's import block (verified in the final source; `app-shell.tsx` now
imports only `Sidebar`, `NotificationActivityLayer`, the two hooks and `TEST_IDS`).

## Evidence — the sidebar mount, with surrounding structure

`sidebar.tsx`, final:

```tsx
      footer={<SidebarFooter />}
      testId={TEST_IDS.sidebar}
    >
      {renderSidebarBody()}
      {/* Last in the body, so the offer sits between the conversation list and
          the account footer. The rail is 48px wide and drops it entirely; the
          mobile drawer is full width and keeps it. */}
      {!collapsed && <NotificationEnablePrompt />}
    </SidebarPanel>
```

Why this lands between the list and the footer: `SidebarPanel` (packages/ui) composes
`{header}{body}{footer}` where `body = <div className="flex min-h-0 flex-1 flex-col p-2">{children}</div>`.
So both children of `SidebarPanel` are inside the body div, in order — the conversation
list (`renderSidebarBody()` → `SidebarContent`'s `nav`, which is `flex-1`) first, the offer
after it, and `footer={<SidebarFooter />}` renders after the whole body div. The offer is
`shrink-0` so the `flex-1` list yields the space rather than the card being squeezed.

Placement is pinned by tests rather than by reading: `sits below the conversation list` and
`sits above the account footer` assert `compareDocumentPosition` against
`TEST_IDS.sidebarNav` and `TEST_IDS.sidebarFooter`.

## Evidence — the new component (full source)

```tsx
import { Button } from '@hushbox/ui';
import { useEnablePrompt } from '@/hooks/notifications/use-enable-prompt';
import type * as React from 'react';

/**
 * The one-time offer to turn on notifications for this device.
 *
 * An inline region rather than a modal: it announces politely, never takes
 * focus, and both answers are ordinary buttons. It is offered once per device —
 * "Later" is permanent there — so the copy points at Settings, which stays the
 * place to change the answer.
 *
 * It renders in the sidebar column, so the card stacks: heading, then the
 * promise about content, then the two answers side by side. Nothing here
 * depends on a width wider than the sidebar's.
 */
export function NotificationEnablePrompt(): React.JSX.Element | null {
  const { isVisible, isEnabling, enable, dismiss } = useEnablePrompt();

  if (!isVisible) return null;

  return (
    <div
      role="status"
      className="border-sidebar-border bg-card mt-2 flex shrink-0 flex-col gap-2 rounded-lg border p-3"
    >
      <h2 className="text-sm font-medium">Turn on notifications</h2>
      <p className="text-muted-foreground text-xs leading-relaxed">
        Know when a reply lands or a run finishes, even when HushBox is closed. Never includes
        message content. Change this any time in Settings.
      </p>
      <div className="flex gap-2">
        <Button size="sm" className="flex-1" onClick={enable} disabled={isEnabling}>
          Enable
        </Button>
        <Button size="sm" variant="ghost" className="flex-1" onClick={dismiss}>
          Later
        </Button>
      </div>
    </div>
  );
}
```

Styling notes: tokens only (`border-sidebar-border`, `bg-card`, `text-muted-foreground`) —
no inline color/font styles, no literal hex. `bg-card` (paper cream / warm charcoal) over
`bg-sidebar` gives the card a hairline-bordered raised surface per DESIGN.md §Cards, flat
at rest. Copy carries no em/en dashes (DESIGN.md §Don't).

## Evidence — the mandated strings are unchanged

- Heading, verbatim in source: `<h2 className="text-sm font-medium">Turn on notifications</h2>`
  — the Maestro regex `.*Turn on notifications.*` (flows 07 and 15) still matches this text.
- Buttons, verbatim in source: `>Enable<` and `>Later<` as the sole text children of the two
  `Button`s, so their accessible names remain exactly `Enable` and `Later` — the Playwright
  locator `enableOffer()` (`e2e/notifications/push-harness.ts:108-112`) filters `role="status"`
  by exactly those two names.
- `role="status"` retained on the card's root element; the region still carries no accessible
  name of its own, which is the premise of that locator.

## Evidence — rail handling and its test

Mechanism used is the existing one: `sidebar.tsx:48` already computes
`const collapsed = !isMobile && !sidebarOpen;` from the `useUIStore` UI store, and passes it
to `SidebarPanel` (`collapsed={collapsed}`, which drives `w-12` vs `w-72`) — the same flag
`SidebarFooterBase` takes. The mount reuses it: `{!collapsed && <NotificationEnablePrompt />}`.
No new state, store field, or prop was introduced.

Because `collapsed` is false whenever `isMobile` is true, the mobile drawer keeps the offer;
only the desktop 48px rail drops it.

Tests (`sidebar.test.tsx`):

- `stays out of the collapsed rail, which is too narrow to carry it` — `sidebarOpen: false`
  on desktop → no `Enable` button in the tree.
- `comes back when the rail is expanded` — same start, then `sidebarOpen: true` → the button
  is present. (Both branches of the `!collapsed &&` guard are therefore covered.)
- `renders inside the mobile drawer` — `useIsMobile` mocked true, `mobileSidebarOpen: true`,
  `sidebarOpen: false` → the button is present, proving the rail rule does not leak into the
  drawer.

## Tests added

| Test | Behavior | Criterion |
| --- | --- | --- |
| `titles the offer so a narrow column still says what it is` | the card carries a `Turn on notifications` heading | copy / phrase retained |
| `stacks the offer as a column instead of splitting it across a wide row` | root region is `flex-col` and never `flex-row` | vertical card layout |
| `sits below the conversation list` | DOM order: offer follows `sidebarNav` | placement after the list |
| `sits above the account footer` | DOM order: offer precedes `sidebarFooter` | placement before the footer |
| `stays out of the collapsed rail, which is too narrow to carry it` | rail renders no offer | rail criterion |
| `comes back when the rail is expanded` | expanding restores it | rail criterion |
| `renders inside the mobile drawer` | drawer renders it | mobile drawer criterion |
| `offers notifications from the sidebar, never from the main region` (app-shell) | in `complementary`, absent from `main` | no longer in `<main>` |

Updated: `says what notifications carry and where to change them` now asserts
`/never includes message content/i` (the new body copy) plus `Settings`.

Carried over green, unchanged: `renders nothing when the device is not owed the offer`,
`announces politely without taking focus` (`role="status"`, no autofocus),
`offers both actions as keyboard-reachable buttons` (tab order Enable → Later),
`asks the platform when the user enables`, `dismisses the offer when the user picks later`,
`disables the enable action while the platform is answering` — i.e. the a11y and suppressor
coverage.

TDD: all eight assertions above were written first and run red before any source edit.
Observed failures were the expected ones — `Unable to find … role "heading" and name "Turn on
notifications"`, `expected 'border-border bg-card mx-4 mt-3 flex …' not to contain 'flex-row'`,
`expected 'never carry message content' …`, and `Unable to find … role "button" and name
"Enable"` inside `complementary` — 8 failed / 52 passed across the three files. The rail test
(`stays out of the collapsed rail`) passed vacuously in the red run (the sidebar did not yet
render the offer at all); its paired `comes back when the rail is expanded` failed red, so the
guard is genuinely exercised in both directions after the change.

## Self-gate

Run after the LAST edit, package-wide, as required:

- `npx turbo lint --filter=@hushbox/web --force` — **pass** (exit 0).

```
• Packages in scope: @hushbox/web
   • Running lint in 1 packages
   • Remote caching disabled

@hushbox/web:lint: cache bypass, force executing 9849ebe57fc32cac
@hushbox/web:lint:
@hushbox/web:lint: > @hushbox/web@0.0.0 lint /workspace/…/apps/web
@hushbox/web:lint: > eslint .

 Tasks:    1 successful, 1 total
Cached:    0 cached, 1 total
  Time:    2m57.216s
```

(The standing-amendment "known-external red" on `use-prompt-budget.ts` did not fire in this
run; the gate is clean end to end.)

- `npx turbo typecheck --filter=@hushbox/web --force` — **pass** (exit 0).

```
• Packages in scope: @hushbox/web
   • Running typecheck in 1 packages
   • Remote caching disabled

@hushbox/web:typecheck: cache bypass, force executing e3d1953e93925a05
@hushbox/web:typecheck:
@hushbox/web:typecheck: > @hushbox/web@0.0.0 typecheck /workspace/…/apps/web
@hushbox/web:typecheck: > tsgo --noEmit && tsgo --noEmit -p tsconfig.native-tests.json

 Tasks:    1 successful, 1 total
Cached:    0 cached, 1 total
  Time:    8.856s
```

- `pnpm test:web` — **pass** (exit 0), coverage gate included.

```
 Test Files  393 passed (393)
      Tests  6386 passed (6386)
   Duration  296.22s
 Tasks:    1 successful, 1 total
```

Per-file coverage for the files this task owns (from the same run's table):

```
  app-shell.tsx      |     100 |      100 |     100 |     100 |
  sidebar.tsx        |     100 |      100 |     100 |     100 |
  .../notifications  |     100 |      100 |     100 |     100 |   (dir row covering enable-prompt.tsx)
  All files          |   99.64 |     98.8 |   99.73 |   99.85 |
```

No coverage failure appeared on any file, touched or untouched, so no attribution was
needed. (The four gate numbers above come from a fourth, recorded run of `pnpm test:web`
made after the last edit; it exited 0 with the same 393/6386.)

## Acceptance criteria

1. **Renders in the sidebar body after the list, before the footer; no longer in `<main>`;
   app-shell mount + comment removed** — **met**. Sidebar mount quoted above with the
   `SidebarPanel` body/footer composition that makes the position true; pinned by the two
   `compareDocumentPosition` tests and by the app-shell test asserting the button is inside
   `complementary` and absent from `main`. The `<main>` block and the import are gone.
2. **Vertical card, copy exactly as specified** — **met**. Heading `Turn on notifications`;
   body `Know when a reply lands or a run finishes, even when HushBox is closed. Never
   includes message content. Change this any time in Settings.`; buttons `Enable` (primary,
   default variant) and `Later` (`variant="ghost"`). Layout is `flex-col` with the two
   answers on one row, each `flex-1` — no `sm:flex-row` split remains.
3. **Button names stay Enable/Later, "Turn on notifications" retained** — **met**; quoted
   above against both suites' selectors.
4. **Rail: not rendered; reappears when expanded; mobile drawer renders normally** — **met**
   via the pre-existing `collapsed` flag, with three tests.
5. **`role="status"`, never steals focus, real buttons, keyboard reachable** — **met**;
   `role="status"` on the root, no focus call anywhere in the component, both answers are
   `@hushbox/ui` `Button`s (real `<button>`), and the carried-over tab-order and
   no-focus tests stay green.
6. **`useEnablePrompt` and `prompt-dismissal.ts` untouched** — **met**; mtime evidence above.
7. **Placement tests updated; a11y and suppressor tests carry over green** — **met**; see
   the tests table.

## Deviations

- The heading is an `<h2>` rather than a styled `<p>`. The plan says "heading"; semantic HTML
  is the CODE-RULES preference and it gives the card a real accessible heading. Text is
  exactly the mandated string, so both external suites are unaffected.
- The body copy is styled `text-xs` (the heading `text-sm`) rather than the old uniform
  `text-sm`, because the card now lives in a 260px column. No copy change.

## Concerns and limitations

1. **The Playwright notifications spec will break — and not because of naming.** The desktop
   sidebar defaults to the collapsed rail: `apps/web/src/stores/ui.ts:15` sets
   `sidebarOpen: false` and persists it, and no e2e storage state carries
   `hushbox-ui-storage` (checked every JSON under `e2e/.auth/`). A fresh Playwright context
   therefore renders the 48px rail, where criterion 4 requires the offer to be absent. The
   two tests that call `await expect(offer).toBeVisible()`
   (`e2e/notifications/notifications.spec.ts:51` and `:75`) will fail until the spec expands
   the sidebar first. `e2e/` is outside this task's file ownership, so nothing was changed
   there.
2. **Both Maestro flows will break for the same structural reason.**
   `mobile-tests/flows/07-push-notification-prompt.yaml:66-72` and
   `mobile-tests/flows/15-notification-enable-grant.yaml:52-58` assert
   `.*Turn on notifications.*` visible on the authenticated chat page without ever opening
   the drawer. On a phone the sidebar is a Radix Sheet whose content is unmounted while
   closed (`mobileSidebarOpen: false` by default), so the text is not in the view hierarchy.
   Each flow needs a hamburger tap before the assertion. Those files are outside this task's
   ownership and the suite cannot be run in this environment.
3. **Product consequence of the rail rule, for the founder:** because the desktop sidebar
   starts collapsed for a brand-new profile, a first-time desktop user now never sees the
   one-time offer until they expand the sidebar. The offer is not consumed by this (the hook
   only retires it on answer or dismissal), so it appears the first time they expand — but
   the "one-time offer at first authenticated load" reach is materially reduced compared to
   the `<main>` mount. This follows directly from criterion 4; raising it rather than
   deviating.

## Confidence

**High** on the implementation: all three gates green with full output, criteria pinned
literally by tests, and the two protected modules provably untouched.
**Medium** on the run as a whole, because of concerns 1 and 2 — two out-of-ownership suites
have assertions that this (correct, specified) move invalidates, and one of them cannot be
re-run here.
