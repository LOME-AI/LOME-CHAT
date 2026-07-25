# Task 09 — Foreground layer + dismissal clearing — impl report 1

## Objective

The client-only activity badge (zustand store → tab title + `setAppBadge` + opt-in sound),
service-worker `push-event` intake, and delivered-notification clearing (on conversation
view; on foreground against read-elsewhere state). Plus the extended scope: `lastReadSeq`
on the two shared conversation mirror schemas and the demo mock backend that feeds them.

## Files changed

### New — `apps/web/src/lib/notification-activity/`

| File                | Why                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------- |
| `app-attention.ts`  | `isAwayFromApp()` — the one definition of "looking away" (hidden **or** unfocused)     |
| `app-badge.ts`      | `applyAppBadge(count)` — feature-detected Badging API; zero always routes to `clear`   |
| `sound.ts`          | Synthesized arrival chime + `primeNotificationSound()`, the autoplay unlock            |

### New — store, hooks, components

| File                                                        | Why                                                                        |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| `src/stores/notification-activity.ts`                        | `unreadCount` / `markAllSeen()` / `recordActivity()` / `setSoundEnabled()`  |
| `src/hooks/notifications/use-activity-sinks.ts`              | Title, app badge, chime — the three presentation sinks over one count       |
| `src/hooks/notifications/use-activity-intake.ts`             | SW `push-event` messages in; focus/visibility return clears the count       |
| `src/hooks/notifications/use-conversation-activity.ts`       | The open conversation's socket frames as a second, source-agnostic feed     |
| `src/hooks/notifications/use-notification-clearing.ts`       | Clear-on-view and clear-what-was-read-elsewhere                             |
| `src/components/notifications/activity-announcer.tsx`        | The `aria-live="polite"` parity signal for the badge                        |
| `src/components/notifications/notification-activity-layer.tsx` | One mount point composing the above                                       |

Each has a colocated `*.test.ts(x)`.

### Modified

| File                                                    | Why                                                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/lib/notification-channel/types.ts`                 | `clearDelivered(conversationIds)` added to the facade contract               |
| `src/lib/notification-channel/web-adapter.ts`           | `registration.getNotifications()` → `close()` by tag                          |
| `src/lib/notification-channel/native-adapter.ts`        | `getDeliveredNotifications()` → `removeDeliveredNotifications({notifications})` |
| `src/lib/notification-channel/channel.ts`               | Delegates the new method                                                     |
| `src/components/shared/app-shell.tsx`                   | Mounts `<NotificationActivityLayer />` once for the authenticated app        |
| `src/components/chat/page/authenticated-chat-page.tsx`  | Clears the open conversation's notifications while it is on screen           |
| `src/hooks/realtime/use-group-chat.ts`                  | Feeds the store from the conversation socket already held there              |
| `packages/shared/src/schemas/api/conversations.ts`      | `lastReadSeq` on `conversationListItemSchema` + `membershipViewSchema`        |
| `src/demo/mock-backend/store.ts`                        | Emits `lastReadSeq` on the list item and the membership wire shape           |
| `src/hooks/chat/use-authenticated-chat.ts`              | Forced: the seeded owner membership must carry the new field                 |
| `src/components/sidebar/sidebar.test.tsx`               | Forced: the shared list-item fixture must carry the new field                |
| the matching test files                                 | New behavior pinned; the mock-backend membership expectation extended        |

## Tests added

Totals: 55 tests across 9 new test files, plus 9 tests added to 5 existing test files
(web adapter 6, native adapter 5, channel 2 strengthened, app-shell 1, authenticated chat
page 1, group chat 1) and 5 tests added to the shared schema suite.

### Store (`stores/notification-activity.test.ts`, 10)

Starts at zero; counts an event that arrives while away; accumulates; **ignores an event
that arrives while the user is watching**; **ignores an event this user authored**;
`markAllSeen` clears (and is a no-op when already clear); sound defaults off; turning
sound on resumes a suspended audio context (the gesture unlock) and turning it off touches
no audio.

### Attention, badge, sound (`lib/notification-activity/*.test.ts`, 13)

`isAwayFromApp` for hidden / unfocused / watching. Badge: shows the count; **clears
instead of setting zero**; **does nothing on a platform without the Badging API**; never
surfaces a refused write. Sound: silent without Web Audio; plays a tone; resumes only a
suspended context; reuses one context; never surfaces a refused resume.

### Sinks (`hooks/notifications/use-activity-sinks.test.ts`, 12)

Title: untouched at zero, `(3) HushBox` prefix, restored on clear, never compounds its own
prefix, restored on unmount. Badge: count shown, cleared on `markAllSeen`, no throw where
absent. Sound: silent while off, one chime per arrival while on, silent when the count is
cleared, silent for a count that predates the mount.

### Intake (`hooks/notifications/use-activity-intake.test.ts`, 8)

Counts a worker-forwarded push; ignores a `pushsubscriptionchange` message, a payload that
fails the shared schema, and a non-object message; unsubscribes on unmount; mounts cleanly
with no service worker; clears on window focus and on becoming visible; keeps the count
while still away.

### Conversation frames (`hooks/notifications/use-conversation-activity.test.ts`, 5)

Counts another member's message; **never counts this user's own message echoed back**;
counts an assistant message with no sender; no socket → no subscription; unsubscribes when
the conversation closes.

### Clearing (`hooks/notifications/use-notification-clearing.test.tsx`, 10)

View: clears the open conversation, re-clears on navigation, does nothing with no
conversation, never surfaces a failure. Foreground: clears conversations whose cursor has
caught up, leaves one with unread messages alone, waits for the list, refetches read state
on becoming visible, does not refetch while backgrounded, never surfaces a failure.

### Facade clearing (adapters, 11)

Web: closes notifications tagged with the conversation id, leaves other conversations'
alone, clears a batch in one list read, does not read the list for an empty batch, no-ops
without a registration and on an unsupported browser. Native: removes by tag, falls back
to the id in the data payload (iOS carries no tag), ignores entries with no conversation,
leaves the shade alone when nothing matches, does not read the shade for an empty batch.

### Announcer + layer (`components/notifications/*`, 6)

`role="status"` + `aria-live="polite"`, focus never moved; silent at zero; singular and
plural copy. Layer: a forwarded push becomes a title **and** an announcement; coming back
clears both.

### Wiring (existing suites, 3)

`app-shell.test.tsx` — "presents observed notification activity" (the title reacts, so the
layer is mounted). `authenticated-chat-page.test.tsx` — "dismisses the delivered
notifications of the conversation on screen" (`clearDelivered(['conv-456'])`).
`use-group-chat.test.ts` — "counts a message from another member as activity while the user
is away" (the real hook, driven through the shared socket).

### Shared schema (`packages/shared/src/schemas/api/conversations.test.ts`, 5)

List item carries the cursor, defaults it to zero, rejects a negative cursor; membership
carries it and defaults it.

## TDD record

Every module was driven from a failing test. The store's away/self-authored/markAllSeen
rules, the badge's zero-and-absent arms, the sound's prime/play split, both adapters'
`clearDelivered`, the intake's validation arms, the clearing hooks, the announcer, and each
of the three wiring points were red first — module-resolution red for new files, assertion
red for behavior added to existing ones (e.g. app-shell's title assertion failed
`Expected "(2) HushBox" / Received "HushBox"`; the chat page's `clearDelivered` had "Number
of calls: 0"; group chat's counter stayed at 0). Two red cycles were environmental rather
than behavioral and are recorded as such: `navigator.serviceWorker` had to outlive the
automatic RTL cleanup, and mocking `@/hooks/chat/chat` via `importOriginal` pulled the
frontend env schema into a test that has no env.

## Self-gate

| Command                                                                        | Result |
| ------------------------------------------------------------------------------ | ------ |
| `pnpm test:web` (full scoped suite + per-file coverage gate), run after the last edit | **pass** — 392 files, 6361 tests, exit 0, zero coverage-threshold errors |
| `pnpm test:shared` (full scoped suite)                                          | **fail — 4 pre-existing failures in `src/env.config.test.ts`, attributed below**; the 106 other files pass, 2388/2392 tests |
| `npx turbo typecheck --filter=@hushbox/shared --force`                          | **pass** |
| `tsgo --noEmit` (apps/web), after the last edit                                 | **pass** — 0 errors |
| `npx eslint <owned files>` from `apps/web`, after the last edit                 | **pass** — exit 0, no output |
| `npx eslint src/schemas/api/conversations.{ts,test.ts}` from `packages/shared`  | **pass** — exit 0 |
| `npx prettier --check <owned files>`                                            | **pass** after a `--write` pass over 7 files |
| `vitest run --coverage.include='src/hooks/notifications/use-activity-sinks.ts'` | **pass** — 100 / 100 / 100 / 100 (20 stmts, 6 branches, 8 funcs, 17 lines) after the restructure below |

An earlier full run passed all 392 files but failed the per-file coverage gate on this
task's own `use-activity-sinks.ts`: `use-activity-sinks.ts` sat at
87.5% branches because the unmount-restore effect carried a `baseTitle.current !== null`
guard whose null arm is unreachable (the title effect always runs first). The fix removes
the branch rather than test around it: the base title is captured in a mount-only effect
declared *before* the count effect, and its cleanup closes over a plain string. Behavior is
identical and the same 12 title/badge/sound tests still pass.

### Attributed failures (not this task)

- **`packages/shared/src/env.config.test.ts` — 4 failures.** The concurrent notifications
  API workstream added `NOTIFICATION_TAG_SECRET: z.string().min(1)` (required, no
  `.optional()`) to `backendEnvSchema` in `env.config.ts`; the test file's fixtures predate
  it, so every `backendEnvSchema.safeParse(validEnv)` in that file now returns
  `success: false`. Evidence: `git status` shows `env.config.ts` modified and
  `env.config.test.ts` untouched; this task's only `packages/shared` edit is
  `schemas/api/conversations.{ts,test.ts}`, whose own suite passes 178/178.
- **`apps/web/src/components/settings/notifications-card.*`** (Task 10, untracked and being
  written while this task ran) briefly produced 8 typecheck errors mid-run; they are gone
  from the final `tsgo` pass, and this task never touched those files.

## Acceptance criteria (checked literally)

1. **"Store unit tests: increment rules (only while hidden/unfocused; own-actions
   excluded), reset on focus, `markAllSeen`."** — **met**. All four rules are pinned in
   `stores/notification-activity.test.ts` (away/watching, self-authored, markAllSeen) and
   `hooks/notifications/use-activity-intake.test.ts` (focus and visibility both reset;
   staying away does not).
2. **"Title effect: `(n) ` prefix appears/clears; no other writer introduced."** — **met**.
   `use-activity-sinks.test.ts` pins appear/clear/no-compounding/restore-on-unmount.
   Only-writer evidence: `grep -rn "document\.title\s*=" apps/web/src packages/ui/src`
   returns exactly the two lines in `use-activity-sinks.ts` (plus test-file setup), and the
   router carries no `head`/`meta` title management (`__root.tsx` has none).
3. **"`setAppBadge` feature-detected, cleared on markAllSeen (mock navigator tests)."** —
   **met**. `app-badge.test.ts` covers present/absent/refused; `use-activity-sinks.test.ts`
   covers cleared-on-markAllSeen through the store.
4. **"Sound: plays only when enabled + event arrives; toggle is the unlock gesture; never
   sole signal (aria-live region announces count changes politely)."** — **met** with one
   scope note: the store's `setSoundEnabled(true)` performs the unlock synchronously (so it
   runs inside whichever click drives it) and is pinned by a store test; **no settings
   toggle UI exists yet** — the control belongs to the settings card, which is another
   task's file. Raised.
5. **"Clearing: viewing a conversation clears its delivered notifications (both adapters,
   mocked); foreground sync clears read-elsewhere tags (test with mocked read-state)."** —
   **met**. Both adapters have their own `clearDelivered` suites keyed on `conversationId`;
   the view path is pinned in `authenticated-chat-page.test.tsx`, the foreground path in
   `use-notification-clearing.test.tsx`. **No client-side alias derivation exists** — grep
   for `hmac`/`alias` across the owned files returns nothing, and the only per-conversation
   value in the SW payload is `conversationId`.
6. **Extended scope: `lastReadSeq` on `membershipViewSchema` and
   `conversationListItemSchema`; mock backend emits or defaults it.** — **met**. Both gain
   `z.number().int().nonnegative().default(0)` (the `muted`/`pinned` precedent in the same
   file); the mock backend emits `lastReadSeq: 0` on both wire shapes;
   `listConversationsResponseSchema.parse(list)` in `store.test.ts` still passes.

## Deviations, with reasons

1. **The facade method takes a list, not a single id**: `clearDelivered(conversationIds)`.
   The foreground sync clears whatever the user read elsewhere — potentially many
   conversations — and a per-id call would read the delivered-notification list once per
   conversation. One method, one list read; the view path passes a single-element array.
2. **Native clearing filters, then removes.** The brief describes
   `removeDeliveredNotifications({tag})`, but the Capacitor plugin's signature is
   `removeDeliveredNotifications({ notifications: PushNotificationSchema[] })` — there is no
   tag-keyed remove. The adapter reads `getDeliveredNotifications()` and filters on the tag,
   falling back to `data.conversationId` because **iOS notifications carry no tag**. The key
   is still the conversation id in both arms.
3. **The chime is synthesized, not an audio asset.** A 120 ms Web Audio tone needs no
   binary in the repo, no fetch, and no decode, and works offline. `AudioContext` is
   feature-detected, so a platform without Web Audio is silent rather than broken.
4. **Files edited outside the plan's list, each forced.** `use-group-chat.ts` (the only
   place that already holds the conversation socket and the caller id — see 5),
   `hooks/chat/use-authenticated-chat.ts` and `components/sidebar/sidebar.test.tsx` (both
   construct the shared types the extended scope changed, so they stop typechecking without
   the new field).
5. **The in-app feed is the open conversation only.** There is no user-level socket and no
   cross-conversation client event source (`lib/conversation-socket-registry.ts` is
   refcounted per conversation), so — per the brief's instruction — the feeds are the SW
   `push-event` message plus `message:new` frames on the conversation already open. No new
   realtime surface was invented.
6. **`lastReadSeq` uses `.default(0)` rather than a bare required field.** A required field
   would have broken ten existing shared-schema tests that parse payloads without it, and
   zero ("nothing read") is the conservative default — it can only ever *suppress* clearing,
   never clear something unread.
7. **Two `role="status"` regions now exist in the app shell** (the enable prompt from the
   previous task, and the announcer). Both are correct; the Playwright task must select
   precisely. Raised.

## Concerns and limitations

- **OUT-OF-SCOPE NEED — nothing writes the read cursor.** `PATCH /conversations/:id/read`
  exists and is proven server-side, but no client calls it, so `lastReadSeq` never advances
  and the foreground "read elsewhere" clear can only fire for conversations that are
  trivially caught up. Writing the cursor is not among this task's acceptance criteria and
  needs a mutation hook plus its own tests; until someone owns it, cross-device dismissal is
  inert end to end.
- **No UI toggles the sound setting.** The store persists `soundEnabled` and unlocks audio
  when it flips on, but the settings card is another task's file. Until it exposes the
  control, sound is permanently off in the product.
- **The SW's `pushsubscriptionchange` postMessage still has no listener.** The worker
  re-subscribes and posts `{type:'pushsubscriptionchange', subscription}` to open clients;
  this task's message listener validates and ignores it (correctly — it is not activity).
  Re-registration on next app start plus server-side pruning are the designed backstops, but
  the postMessage half of that design is unconsumed.
- **Foreground refetch cost.** Every return to the foreground invalidates the conversation
  list. That is deliberate (the query client sets `refetchOnWindowFocus: false`, so this is
  the only refresh mechanism, not a second one), but it is one request per tab switch.
- **"Fully read" is `lastReadSeq >= nextSequence - 1`.** It relies on the list's
  `nextSequence` being current; a stale list simply defers clearing to the next refetch.
- **Sound and badge are untestable end to end here** — Web Audio autoplay policy and the
  Badging API only exist in a real browser; the tests pin the calls, not the platform's
  response.

## Confidence

**High** for the store, the sinks, the intake, both adapters' clearing, and the schema
extension: every acceptance criterion has a direct test, the web typecheck and the owned-file
lint are clean after the last edit, and the two attributed reds are provably other
workstreams'. **Medium** on the feature being useful end to end in production, for one
reason that is a plan gap rather than a defect: with no client writing the read cursor, the
read-elsewhere clearing path has nothing to react to.
