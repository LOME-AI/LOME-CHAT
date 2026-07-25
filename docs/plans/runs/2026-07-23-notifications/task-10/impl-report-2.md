# Task 10 — Settings card — impl report 2 (fix)

## Objective

Close the one validated Minor from the Task 10 audit: the card displayed the *device*
timezone while the server evaluates quiet hours in the *stored* `quietHours.timezone`, so
a traveller or second-device user read a zone that was not in force. Also correct the
over-broad code comment that claimed the zone is "re-stamped from the device on every
write".

## Chosen approach and justification

**(a) — display the stored `quietHours.timezone`.**

(b) (re-stamp on every save) makes the two agree by moving the enforced window instead of
by telling the truth: a user who set 22:00–07:00 at home in `America/New_York` and then,
while in `Europe/London`, flips *Finished runs* off would silently have their quiet window
jump five hours — an unrelated toggle changing when notifications are suppressed. That is
a worse outcome than the display being stale, and it also makes the effective window
depend on which device last touched settings. (a) keeps the enforced window stable, states
the zone the server actually uses, and — because the bound Selects still stamp the device
zone (the plan's "auto-populate from `Intl` on save") — leaves the user an explicit way to
move it, which the copy now names.

## Files changed

- `apps/web/src/components/settings/notifications-card.tsx` — display the stored zone,
  add a device-mismatch line, rename the prop/local to `deviceTimezone`, correct the
  comment.
- `apps/web/src/components/settings/notifications-card.test.tsx` — three new tests plus
  the copy update on the existing zone test.

## Before / after of the displayed-zone logic

Before (`QuietHoursFields`, prop `timezone` = `Intl.DateTimeFormat().resolvedOptions().timeZone`):

```tsx
<p className="text-muted-foreground text-sm">
  {`Hours follow this device's timezone (${timezone}).`}
</p>
```

After (prop renamed `deviceTimezone`; the sentence now reads the stored value):

```tsx
<p className="text-muted-foreground text-sm">{`Hours are read in ${quietHours.timezone}.`}</p>
{quietHours.timezone !== deviceTimezone && (
  <p className="text-muted-foreground text-sm">
    {`This device is in ${deviceTimezone}. Change a time to move quiet hours here.`}
  </p>
)}
```

The mismatch line is only rendered when the two differ, so the common case reads exactly
one plain sentence. When quiet hours are off no zone is shown at all (the fields are not
rendered) — unchanged. The device zone is still what gets stamped when quiet hours are
turned on and when a bound changes, so the display and the stored value agree immediately
after any quiet-hours write (the mutation writes optimistically, then the server echo
wins).

## Before / after of the comment

Before:

```
The bounds are only ever written as a pair, and the timezone is re-stamped
from the device on every write, so a person who moved zones gets their quiet
hours read in the zone they are actually in.
```

("every write" was wrong — a category or global toggle re-sends the stored `quietHours`
object unchanged.)

After:

```
The zone on display is the saved one, because that is the zone the server
evaluates the window in. It is only re-stamped from the device when a bound
is written, so someone who travelled keeps their old zone — and their old
quiet window — until they change a time here. Showing the device zone instead
would claim a window the server is not enforcing.
```

## Tests added

In `notifications-card.test.tsx` › `quiet hours`, over a new module constant
`AWAY_TIMEZONE` (`America/New_York`, or `Europe/London` if the runner is already in
New York — so the "device ≠ stored" premise holds under any `TZ`):

- **`names the saved timezone when this device is somewhere else`** — the travelled /
  second-device case: preferences carry `quietHours.timezone = AWAY_TIMEZONE` while the
  device resolves to `DEVICE_TIMEZONE`; asserts the card says `Hours are read in
  <AWAY_TIMEZONE>.` and does *not* say `Hours are read in <DEVICE_TIMEZONE>.` This is the
  test that pins the audit finding: displayed zone == effective (server-evaluated) zone.
- **`offers to move the hours here when this device is somewhere else`** — the mismatch
  line names the device zone and the affordance.
- **`leaves out the device note when the saved timezone is this one`** — no mismatch line
  in the ordinary case (closes the `!==` branch both ways).
- **`shows the timezone the hours are read in`** (existing) — updated to the new copy;
  still the same behavior (stored == device here).

TDD: the three copy assertions were watched fail first for the right reason (the old
sentence was in the DOM, the new one was not). Mutation check after green — flipping the
display back to `deviceTimezone` failed exactly one test, `names the saved timezone when
this device is somewhere else`, and nothing else; reverted immediately from a byte-for-byte
backup (verified by re-reading the file).

## Self-gate

- `pnpm test:watch apps/web/src/components/settings/notifications-card.test.tsx` — pass,
  23/23.
- `npx turbo typecheck --filter=@hushbox/web --force` — pass (`Tasks: 1 successful`).
- `npx turbo lint --filter=@hushbox/web --force`, run **after the last edit** — pass:

  ```
  @hushbox/web:lint: > eslint .

   Tasks:    1 successful, 1 total
  Cached:    0 cached, 1 total
  Time:    5m20.829s
  ```

  An earlier run of this same command caught one prettier error of mine
  (`notifications-card.test.tsx:378` — a wrapped `expect(...)` that prettier wanted on one
  line); it was fixed and the command re-run to the green output above. No error from any
  other workstream's file appeared in either run — in particular the standing-amendment
  `use-prompt-budget.ts` complexity error did not reproduce.
- `npx turbo test --filter=@hushbox/web --force` (full suite + per-file coverage gate) —
  **exit 0**: `Test Files 393 passed (393)`, `Tests 6386 passed (6386)`,
  `Tasks: 1 successful`. Coverage row for the changed file:
  `...ions-card.tsx | 100 | 100 | 100 | 100 |`.

  Two intermediate full-suite runs died in coverage merging, not on a test:
  `Error: Something removed the coverage directory ".../apps/web/coverage/.tmp" …` →
  `ENOENT … coverage-374.json`, with **zero** failing tests in the log (403 `✓` file
  lines, no `×`). That is the known concurrent-`coverage/.tmp` collision — another agent
  was running `turbo test --filter=@hushbox/web` against the same reports directory. The
  final run above was executed with no other vitest process on the box
  (`ps -eo pid,etime,cmd | grep vitest` empty) and was clean.

## Acceptance criteria (the audit Minor)

- **The UI can never claim a zone the server is not using** — met. The sentence is derived
  from `quietHours.timezone`, the same value the server's decision function reads; there
  is no code path that renders the device zone as the enforced one. Pinned by `names the
  saved timezone when this device is somewhere else`.
- **The over-broad comment is corrected** — met (before/after above); it now states the
  actual trigger (a bound write) and the consequence (a travelled user keeps the old
  window until they change a time).
- **Copy stays in voice** — met: two short declarative sentences, no jargon, no
  exclamation, consistent with the card's existing lines; the mismatch line ends with the
  concrete action rather than an apology.
- **G8 accessibility unchanged** — met: no control, label, id, `aria-*`, `fieldset`, or
  `legend` was touched; the added element is a `<p>` in the same
  `text-muted-foreground text-sm` tokens (no inline styles), rendered in normal document
  order right after the existing zone line.
- **G3 respected** — met: no client-side "should this user be notified" logic was added;
  the card only displays the stored value. No second prefs hook; no new file.
- **Mute, facade wiring, category/global toggles untouched** — met: `git status` for this
  task lists only the two files above, and the only diff outside `QuietHoursFields` is the
  `timezone` → `deviceTimezone` rename at its two call sites plus the unchanged
  device-stamp on quiet-hours-on.

## Deviations

- The bound Selects still stamp the **device** zone on write (unchanged from report 1;
  it is the plan's "auto-populate from `Intl` on save"). So changing a time while
  travelling does move the enforced zone. That is deliberate, is the only way to move it,
  and is now stated in the UI rather than assumed — the mismatch line tells the user
  exactly that. It is not silent: the displayed zone changes with the save.

## Concerns and limitations

- A user whose device zone differs but who never opens quiet hours sees nothing — the
  mismatch line only exists while quiet hours are on, which is the only time the zone
  matters.
- No `TEST_IDS` entry (still out of ownership); the new copy is selected by text, and
  Task 13 selects this card by role/accessible name, none of which changed.

## Confidence

High. The finding is closed by a test that was seen failing first and that a targeted
mutation proved bites, the changed file is at 100% coverage, and all three scoped gates
(package-wide lint, typecheck, full suite) are green after the last edit.
