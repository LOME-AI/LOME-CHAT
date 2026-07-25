# Task 10 — Settings card — impl report 1

## Objective

A "Notifications" Card on `/settings`: global switch, three category toggles (messages /
run completions / membership), quiet-hours controls (start/end Selects + auto-detected
IANA timezone), wired to the prefs API through the typed client. Global-off drives
`notificationChannel.unregister()`; global-on walks the facade's permission/registration
flow. Per-conversation mute untouched.

## Files changed

- `apps/web/src/components/settings/notifications-card.tsx` (new) — the card: global
  switch, category fieldset, quiet-hours fieldset with two hour Selects and the detected
  timezone.
- `apps/web/src/components/settings/notifications-card.test.tsx` (new) — 20 tests.
- `apps/web/src/hooks/notifications/use-notification-preferences.ts` — **extended** with
  `useUpdateNotificationPreferences` (+ the `NotificationPreferencesUpdate` type) beside
  the existing query. No second prefs hook file was created.
- `apps/web/src/hooks/notifications/use-notification-preferences.test.ts` — 5 new tests
  for the mutation; the api-client mock gained `$put`.
- `apps/web/src/routes/_app/settings.tsx` — import + one `<NotificationsCard />` mount
  line after `<MailingListCard />`.
- `apps/web/src/routes/_app/settings.test.tsx` — one placement test (mirrors the existing
  mailing-list placement test).

## Proof the existing prefs hook file was extended, not duplicated

`apps/web/src/hooks/notifications/use-notification-preferences.ts` now holds both, in one
file, over one key factory:

```ts
export const notificationPreferencesKeys = {
  preferences: ['notification-preferences'] as const,
};

export function useNotificationPreferences(): UseQueryResult<NotificationPreferences> { … }

export function useUpdateNotificationPreferences(): UseMutationResult<
  NotificationPreferences,
  Error,
  NotificationPreferencesUpdate,
  UpdateContext
> { … }
```

`ls apps/web/src/hooks/notifications/` → `use-enable-prompt.*`,
`use-notification-preferences.*`, `use-push-registration.*` (plus files owned by the
concurrent foreground-layer task). No new prefs hook file exists; the card imports both
hooks from this one module.

## Tests added

`use-notification-preferences.test.ts` (mutation):

- `sends the whole preferences body to the preferences route` — the PUT carries every
  field (full replace, matching the server's strict object).
- `shows the requested preferences before the server has answered` — optimistic write.
- `adopts the server answer over the requested value` — `onSuccess` overwrites with the
  echo.
- `restores the previous preferences when the update fails` — rollback.
- `leaves the cache untouched when the mutation fails before the optimistic write` — the
  no-context path (mirrors the newsletter-hook precedent; also what closes the branch
  gate below).

`notifications-card.test.tsx`:

- `reflects the saved preferences on every switch` — renders current prefs (criterion 1).
- `shows a skeleton while the preferences load` / `shows an error message when the
  preferences fail to load` — loading/error states per the `MailingListCard` precedent.
- `turns message notifications off`, `turns finished-run notifications off`, `turns
  invitation notifications off` — each category round-trips through the typed client.
- `stops delivery to this device when the account switch goes off` — PUT
  `globalEnabled:false` **and** `notificationChannel.unregister()` fired once.
- `asks this device for permission when the account switch goes on` —
  `requestPermissionAndRegister()` fired, `unregister()` not.
- `leaves this device registered when only a category changes` — neither facade call
  fires for a non-global change.
- `keeps the account switch usable from the keyboard` — focus + Space toggles (G8).
- `survives a failed device call after the preference is saved` — a rejecting facade call
  does not disturb the saved state.
- quiet hours: `hides the hour controls while quiet hours are off`; `saves both bounds and
  the device timezone when quiet hours go on`; `clears both bounds when quiet hours go
  off`; `shows the saved bounds on the hour controls`; `keeps the other bound and the
  timezone when the start hour changes`; `… when the end hour changes`; `groups the hour
  controls under a quiet-hours legend` (`role="group"` named by the `<legend>`, containing
  both Selects); `says quiet-hours notifications are dropped rather than delayed` (exact
  copy); `shows the timezone the hours are read in`.

`settings.test.tsx`: `renders the notifications card after the mailing list card`.

TDD: each block was watched fail first (module-not-found for the card, "is not a
function" for the mutation hook, missing-text for the mount). Two mutation checks were run
to prove the assertions bite: swapping `unregister()` for
`requestPermissionAndRegister()` and demoting the `<legend>` to a `<p>` failed exactly 3
tests; both were reverted immediately.

## Self-gate

- `pnpm test:watch` on each owned test file — pass (20 card, 8 prefs-hook, 49 settings
  route).
- `npx turbo typecheck --filter=@hushbox/web --force` — pass, after the last edit.
- `npx eslint <6 owned files>` run from `apps/web` — **exit 0**, after the last edit.
- `npx turbo test --filter=@hushbox/web --force` (full suite, per-file coverage gate) —
  **pass**, final run after the last edit: 392 test files, 6361 tests, zero coverage-gate
  ERROR lines, turbo task successful. No stderr block in that run comes from any of this
  task's three test files.

Two earlier full-suite runs are worth recording because they were not clean, and neither
red was this task's code:

- Run 1 flagged `src/hooks/notifications/use-notification-preferences.ts` at 50% branches
  — genuinely this task's, from the mutation's `onError` no-context path. Closed by the
  `leaves the cache untouched when the mutation fails before the optimistic write` test
  (the newsletter-hook precedent), and green in the final run.
- Run 1 also flagged `use-notification-clearing.ts`, `use-activity-sinks.ts`,
  `use-activity-intake.ts` at 0% — files the concurrent foreground-layer workstream
  created while this task ran, outside this task's ownership and not imported by anything
  it touches. They are green in the final run (that workstream landed their tests).
- Run 2 died in coverage merging, not on a test:
  `Error: ENOENT ... apps/web/coverage/.tmp/coverage-143.json`, zero failing tests before
  it. Another agent's `turbo test --filter=@hushbox/web` was running at the same time
  against the same `coverage/.tmp`; the coverage ENOENT crash is a known flake in this
  repo. The final run was executed with the machine otherwise idle and was clean.

## Acceptance criteria

1. **Card renders current prefs (query), mutations optimistic-or-invalidate per repo
   convention; loading/error states per existing cards** — met. `reflects the saved
   preferences on every switch`; the mutation is optimistic-write + server-echo-wins +
   rollback, copied structurally from `useUpdateNewsletterSettings`; skeleton
   (`TEST_IDS.skeletonBlock`) and the error line follow `MailingListCard`.
2. **Quiet hours: enable toggle reveals `fieldset` with start/end Selects (hour
   granularity) + detected timezone; both-or-neither enforced client-side for UX AND
   server-side** — met. The toggle is inside the `<fieldset><legend>Quiet hours</legend>`;
   the Selects only render when `quietHours !== null`; hour granularity is 24 options at
   `hour * 60` minutes. Client-side both-or-neither is structural: the client can only
   send the whole `{startMinutes, endMinutes, timezone}` object or `null` — there is no
   code path that writes one bound. Server-side stays authoritative and untouched
   (`quietHoursSchema` in the notifications slice + the DB CHECK); the client does not
   re-implement that validation, it just cannot produce a half-filled value.
3. **All controls labelled; keyboard operable; WCAG contrast via tokens (no inline
   styles)** — met. Every switch and Select carries `id` + a `<Label htmlFor>`, plus
   `aria-labelledby` to the label's id and (for switches) `aria-describedby` to the
   description paragraph; both groups are `fieldset`/`legend`; the keyboard test drives
   the account switch with Space; all styling is Tailwind tokens
   (`text-muted-foreground`, `text-destructive`, `text-brand-red`, `bg-muted`), no inline
   `style`.
4. **Global switch off → unregister call fired; on → prompt/permission flow via facade** —
   met, both pinned by tests, and both fired only after the preference save succeeded.

## Deviations

- **Which value decides the device call.** The facade call keys off the value just written
  (`next.globalEnabled`) rather than the server echo. `PUT /notifications/preferences`
  echoes a pure projection of the accepted body (`saveNotificationPreferences` →
  `toPreferencesView(fromBody(body))`), so the two are identical; using `next` keeps the
  behavior obvious at the call site. If the route ever coerces the value (the way
  `/newsletter/me` does), this must switch to the echo.
- **Hour labels are 24-hour (`00:00` … `23:00`), not locale-formatted.** No locale-aware
  hour formatter exists in the repo, and `Intl` hour formatting would make the control's
  labels vary by runtime locale; 24-hour labels are unambiguous and match the
  minutes-of-day wire format. Flagging it as a copy/design call the founder may want
  different.
- **Category toggles stay enabled while the global switch is off.** They remain
  meaningful (they are account state the server evaluates after the global gate), and the
  global switch's own description states that off stops everything. No test pins this
  either way.
- **`@hushbox/ui` is partially mocked in the card test** — the Radix `Select` family is
  swapped for a native `<select>` that carries the trigger's `id`/`aria-labelledby`
  through, because Radix Select needs pointer-capture APIs the test DOM lacks. This is the
  established precedent (`usage-filters.test.tsx`); everything else in `@hushbox/ui`
  (Card, Switch, Label) is the real component.

## Concerns and limitations

- The concurrent foreground-layer task is adding files to `apps/web/src/hooks/notifications/`
  and `apps/web/src/lib/notification-activity/` while this task ran; the full web suite is
  therefore a shared gate whose reds are not all attributable to one task, and two
  simultaneous coverage runs corrupt each other's `coverage/.tmp`. Sequencing the two
  tasks' full-suite runs would avoid it.
- Mute is untouched: no file under `apps/web/src/components/sidebar/` and no mute hook was
  modified (`git status` on this task's paths lists only the six files above). The only
  `mute` matches in the card are the Tailwind tokens `bg-muted` / `text-muted-foreground`.
  The card has no mute control and no duration tiers.
- No `TEST_IDS` entry was added for this card (`packages/shared` is out of this task's
  ownership); the E2E task selects it by `role`/accessible name — every control has a
  stable, unique accessible name for exactly that reason.
- The timezone is re-stamped from the device on every quiet-hours write, so a person who
  moves zones has their window corrected on the next change. It is never re-stamped
  without a user action, so a saved window keeps its zone until then.

## Confidence

High. Every acceptance criterion is pinned by a test that was seen failing first, and all
scoped checks are green after the last edit: web typecheck, `eslint` exit 0 on all six
owned files, and the full web suite at 6361 passing tests with no coverage-gate error.
