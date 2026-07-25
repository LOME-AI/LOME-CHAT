# Task 08 — impl report 1

## Objective

`notificationChannel` facade over web + native adapters; remove the ask-on-mount
permission request on both platforms; one-time dismissible enable prompt; web
subscription lifecycle (subscribe on grant, re-register on authenticated app start,
unsubscribe on logout / global-off).

## Files changed

### New — `apps/web/src/lib/notification-channel/`

| File                     | Why                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `types.ts`               | `PushPermissionState` (+ `unsupported`) and the `NotificationChannel` contract both adapters meet |
| `web-adapter.ts`         | Notification API + PushManager + SW registration; subscribe, POST, DELETE, unsubscribe           |
| `native-adapter.ts`      | Capacitor `PushNotifications`: check/request permission, `register()`, `unregister()`             |
| `channel.ts`             | Platform selection via `isNative()`; per-call delegation                                         |
| `prompt-dismissal.ts`    | Device-local "later, forever" flag (`hb:notif-prompt-dismissed`)                                  |
| `index.ts`               | Barrel (exports only)                                                                            |

### New — hooks and component

| File                                                  | Why                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/hooks/notifications/use-notification-preferences.ts` | Query over `GET /notifications/preferences`; the global-switch suppressor's source |
| `src/hooks/notifications/use-push-registration.ts`    | Fire-and-forget re-registration once per authenticated app start                  |
| `src/hooks/notifications/use-enable-prompt.ts`        | The prompt's eligibility state machine and the two answers                        |
| `src/components/notifications/enable-prompt.tsx`      | The inline `role="status"` callout                                               |

Each has a colocated `*.test.ts(x)`.

### Modified

| File                                            | Why                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/capacitor/hooks/use-push-notifications.ts` | Ask-on-mount deleted: the hook now only attaches the token/tap listeners                        |
| `src/components/shared/app-shell.tsx`           | Mounts `usePushRegistration()` and renders the prompt as a non-growing row at the top of `<main>` |
| `src/lib/auth.ts`                               | `signOutAndClearCache` unregisters this device (best-effort) before the session is revoked      |
| the three matching test files                   | New behavior pinned; the two ask-on-mount tests replaced by their inverse                       |

`src/capacitor/provider.tsx` is **unchanged** — the plan allowed a gate change there, but
none was needed: the token callback and the hoisted conversation-id validator both stay
exactly as they were.

## Tests added

Totals: 63 tests across 8 new test files, plus 6 tests added to 3 existing test files
(app-shell 3, auth 2, push-notifications 1), 1 existing test strengthened, and the 2
ask-on-mount tests deleted because the behavior they pinned is the behavior being removed.

### Facade — web adapter (`web-adapter.test.ts`, 17)

- `unsupported` for a browser missing PushManager / service worker / Notification (three tests)
- mirrors `Notification.permission` when supported
- grant → `subscribe({userVisibleOnly, applicationServerKey: <VAPID bytes>})` → POST
  `/notifications/web-subscriptions` with `{endpoint, keys}`
- denial → no subscribe, no POST; unsupported → no permission request at all
- reuses an existing subscription instead of creating a second
- missing `VITE_VAPID_PUBLIC_KEY` → throws (fail fast, no hardcoded key)
- no service worker → registration skipped, no POST
- `ensureRegistered` re-POSTs when already granted; does nothing (and never prompts) otherwise
- `unregister` deletes the server row then unsubscribes; still unsubscribes when the DELETE
  fails; no-ops with no subscription, no SW registration, or no push support

### Facade — native adapter (`native-adapter.test.ts`, 10)

- `granted`/`denied`/`prompt`/`prompt-with-rationale` → `granted`/`denied`/`default`/`default`
- `getPermissionState` never prompts
- grant → `register()`; denial → no `register()`
- `ensureRegistered` registers only when already granted, and never prompts
- `unregister` drops the platform registration

### Facade — selection (`channel.test.ts`, 2) — every method routed to the right adapter per `isNative()`.

### Dismissal (`prompt-dismissal.test.ts`, 4) — fresh device, sticky after marking, and both
storage-unavailable paths.

### Prompt state machine (`use-enable-prompt.test.ts`, 14)

Renders once and only when eligible; each suppressor separately (dismissed, `granted`,
`denied`, `unsupported`, preferences still loading, account switch off); never prompts on
mount; `enable()` → `requestPermissionAndRegister` → prompt closes; registration failure
after a grant re-reads the platform; total failure leaves the offer standing; `dismiss()`
marks the device and hides.

### Registration lifecycle (`use-push-registration.test.ts`, 6)

Registers once when authenticated and preferences are known; once only across refetches;
never while unauthenticated, before preferences load, or when the switch is off; a
registration failure never surfaces.

### Preferences query (`use-notification-preferences.test.ts`, 3) — reads, stays disabled while
unauthenticated, stable key.

### Component (`enable-prompt.test.tsx`, 7) — renders nothing when suppressed; `role="status"`
with focus left on `document.body`; copy names what notifications carry and points at
Settings; both actions reachable by Tab in order; clicks call `enable`/`dismiss`; Enable
disabled while the platform answers.

### Ask-on-mount removal

- `use-push-notifications.test.ts` — **"never asks for permission on mount"**: mounting on
  native attaches listeners and calls neither `requestPermissions()` nor `register()`; the
  web case asserts the hook attaches nothing at all.
- `app-shell.test.tsx` — **"never asks the browser for notification permission on mount"**:
  rendering the authenticated shell (which mounts the prompt and the registration hook)
  never calls `Notification.requestPermission`.
- `use-enable-prompt.test.ts` — "never asks for permission on its own".

### Logout (`auth.test.ts`, 2) — sign-out unregisters this device first; sign-out completes even
when unregistering fails.

## Self-gate

| Command                                                        | Result                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------- |
| `pnpm test:web` (full scoped suite + per-file coverage gate)   | **pass** — 381 files, 6247 tests, exit 0                  |
| `npx turbo typecheck --filter=@hushbox/web --force`            | **pass** — 0 errors                                       |
| `npx turbo lint --filter=@hushbox/web --force`                 | **pass** — exit 0, run after the last edit                |
| `npx vitest run src/lib/notification-channel src/hooks/notifications src/components/notifications` | pass — 8 files, 63 tests |

Coverage on this task's files (per-file gate is 95 lines/branches/functions/statements):
`web-adapter.ts`, `native-adapter.ts`, `channel.ts`, `prompt-dismissal.ts`,
`use-enable-prompt.ts`, `use-push-registration.ts`, `use-notification-preferences.ts`,
`enable-prompt.tsx`, and the edited `app-shell.tsx` all report **100 / 100 / 100 / 100**.
`types.ts` reports 0/0/0/0 as every type-only file in this package does (it emits no
statements) and the gate passes, as it does for the other type-only files already in the
tree. `auth.ts` is 100 lines / 98.79 branches — the uncovered branch is line 46, which
predates this change.

Two transient externals seen and resolved during the gating, recorded so a re-run reading
the same logs is not confused: an earlier `pnpm test:web` failed the gate on
`src/lint-probe-control.ts` at 0% — a file that does not exist in this tree (a concurrent
agent's transient lint probe); it is absent from the clean run. An earlier run also hit the
known Vitest `coverage/.tmp` ENOENT crash, self-inflicted by running a second vitest in the
same package concurrently; the gating runs above were run alone. An intermediate typecheck
also showed 3 errors in `apps/api/src/slices/conversations/routes.ts` while the concurrent
event-sources task was mid-edit; they are gone in the final run, and this task touched no
file under `apps/api`.

## Acceptance criteria

1. **Ask-on-mount is gone (test: mount triggers no permission request on either platform)** —
   MET. The `requestPermissions()` block is deleted from `use-push-notifications.ts`; the
   native proof is "never asks for permission on mount", the web proof is the app-shell test
   that stubs `Notification.requestPermission` and asserts it is never called while the shell
   (prompt + registration hook) mounts.
2. **Facade unit tests per adapter: permission states, register/unregister flows,
   re-registration on authenticated start (fire-and-forget), logout unsubscribes best-effort** —
   MET. 17 web + 10 native + 2 selection tests; `usePushRegistration` covers the
   fire-and-forget authenticated start; `auth.test.ts` covers the best-effort logout.
3. **Prompt component: renders once, Enable → grant flow → subscribe → registration POST;
   Later → never again (localStorage); all suppressors tested; `role="status"`,
   keyboard-reachable, focus not stolen** — MET, with one seam noted: the Enable → POST chain
   is pinned in two linked halves rather than one test — `enable()` → `requestPermissionAndRegister`
   (hook test) and `requestPermissionAndRegister` → `subscribe` → POST (adapter test). No test
   drives a real browser through both at once; the Playwright spec is where that lands.
4. **Copy mentions Settings as the ongoing control point (DESIGN.md voice)** — MET. Copy:
   "Turn on notifications for replies, finished runs, and invitations. They never carry
   message content — only a link back to the conversation. Change this any time in Settings."
   Checked against `docs/PRODUCT.md` (calm, direct, no hype, no manufactured urgency, no
   confirmshaming — "Later" is a plain button) and `docs/DESIGN.md` (tokens only, no inline
   styles, `@hushbox/ui` `Button`).

## Deviations, with reasons

1. **I6 gains a fourth method, `ensureRegistered()`.** The interface names three
   (`getPermissionState`, `requestPermissionAndRegister`, `unregister`), but the criterion
   "re-registration on authenticated start" needs a re-register that never prompts, which
   none of the three provides. Task 10's settings card should keep using
   `requestPermissionAndRegister()` / `unregister()`.
2. **Two call sites outside the plan's file list.** `components/shared/app-shell.tsx` (mounts
   the prompt + the registration hook — the prompt would otherwise be dead code) and
   `lib/auth.ts` (the only sign-out seam; both the sidebar and the dev persona picker route
   through it). Both edits are wiring only.
3. **The announcements banner was not reused.** `createBanner` in `@hushbox/ui` is a
   framework-agnostic vanilla-DOM marquee controller bound to the `BannerResponse` payload,
   with hash-keyed dismissal — it cannot host a React callout with two actions. It was **not**
   forked: the prompt is small React over `@hushbox/ui` `Button` and the same design tokens
   (`border-border bg-card rounded-lg border`), i.e. the visual language without the code.
4. **The global-switch suppressor reads the preferences API**, per the brief's instruction,
   because Task 10 has not shipped a settings store. `use-notification-preferences.ts` is the
   query half only; Task 10 should extend that file with its mutation rather than add a second
   preferences hook.
5. **`ensureRegistered()` is skipped when `globalEnabled` is false.** Not in the plan text.
   Without it, turning the account switch off (Task 10 → `unregister()`) would be silently
   undone by the next app start. Sends are server-suppressed either way, so this is
   belt-and-braces, but re-registering a device the user just unregistered is wrong on its face.
6. **Native `unregister()` drops only the platform registration**, with no DELETE. The FCM
   token is not known to the client at sign-out (it arrives on a listener, once, at register
   time), and `PushNotifications.unregister()` makes the next send return UNREGISTERED, which
   the existing dead-token prune handles — one mechanism, not a second cleanup path (G4).
7. **Three edge-case tests were written after the code paths they cover** (unregister with no
   SW registration; permission read failing; a read resolving after unmount). They were added
   to close per-file branch coverage; every behavior in the acceptance criteria was driven
   test-first, red observed each time.

## Concerns and limitations

- **Web `unregister()` puts a URL in a path segment.** hono's client does not encode path
  params (verified in `hono@4.12.25`, `dist/client/utils.js` → `replaceUrlParam` is a plain
  string replace), so the adapter sends `encodeURIComponent(subscription.endpoint)` to
  `DELETE /notifications/device-tokens/:token`. Whether that survives the Worker router and
  arrives decoded is server-side behavior this task owns no test for. It is best-effort by
  design (failure is caught, the local unsubscribe still runs, and the server prunes on the
  next 404/410), so a mismatch degrades rather than breaks — but nothing proves the happy path
  end to end yet.
- **Effect ordering on native.** The listeners attach in `CapacitorProvider`'s effect (a
  parent) while `ensureRegistered()` runs from `AppShell`'s (a child, so it runs first). It is
  safe because the native path awaits `checkPermissions()` before `register()`, so the
  listener attach has already happened when the token event can fire; the constraint is
  recorded in the hook's doc comment.
- **The prompt is client-observable only in the app shell**, so it never appears on
  unauthenticated routes. In the demo build `/notifications/preferences` 404s through the
  demo fetch shim (`/notifications` is an intercepted prefix, unknown routes → 404), so the
  preferences query has no data and the prompt stays suppressed — captures are unaffected.
- **No `TEST_IDS` entries were added** (`packages/shared` is out of this task's bounds, and
  literal `data-testid` strings are lint-banned). The prompt is addressable by
  `role="status"` and the accessible button names `Enable` / `Later`; the Playwright task
  should either use those or add the registry entries itself.
- **`subscriptionSchema` in the web adapter re-validates the browser's own
  `PushSubscription.toJSON()`** before posting. It is not a copy of the server's schema in the
  banned sense: it validates an external (browser) object whose DOM type declares `endpoint`
  and `keys` optional, and the server re-validates authoritatively.
- Task 09 will need `notificationChannel` extended with the notification-clearing functions;
  nothing here blocks that.

## Confidence

High for the facade, the removal of ask-on-mount, the prompt, and the lifecycle: every
criterion has a direct test, and the scoped checks are green after the last edit. The two
places I would look first in review are the URL-in-path DELETE (untestable from this task's
side) and the Enable → POST chain being pinned as two linked halves rather than one
end-to-end test.
