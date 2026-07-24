# Current Notification System — Full Map

Research for the 2026-07-23 notifications workstream. Everything below is Verified by
reading the cited file:line unless marked Inferred/Gap. This is a documentary map only —
no recommendations.

---

## 1. The `notifications` slice (apps/api/src/slices/notifications)

**Barrel**: `apps/api/src/slices/notifications/index.ts` — exports the route manifest
factory, all email templates, the device-token store adapter, email adapters
(mock/Resend/factory), push adapters (mock/FCM/factory), and every port type
(`DeviceTokenStore`, `EmailSender`/`BatchEmailSender`, `PushSender`, `PresenceReader`,
`MembershipReader`). Verified: `apps/api/src/slices/notifications/index.ts:1-58`.

**Owns exactly one table**: `device_tokens` (schema below). It owns no email/push log
table — sent emails/pushes are not persisted anywhere except the local-dev in-memory
mailbox (§9) and best-effort service-evidence rows for CI proof (§2).

### Routes (`routes.ts`)

Two routes only, both `routeClass('session')`, both `idempotencyExempt('naturally-idempotent')`:
- `POST /notifications/device-tokens` — upserts a token for the calling user (`ON CONFLICT (token) DO UPDATE`, so a re-registered token moves to its new owner — a device handoff, not a per-user list-append). Verified: `apps/api/src/slices/notifications/routes.ts:42-62`.
- `DELETE /notifications/device-tokens/:token` — user-scoped conditional delete. Verified: `routes.ts:63-79`.

There is **no** route to list a user's own registered devices, no route to unregister
"all my devices," and no admin-facing device-token read (Gap — confirmed absent by grep
across `apps/api/src/slices/admin`).

### Domain (`domain/`)

- `device-tokens.ts` — `registerDeviceToken` (thin wrapper over `store.upsert`) and
  `unregisterDeviceToken` (`idempotent.byTransition` contract: delete wins / already-gone
  is a `false` no-op). Verified: `domain/device-tokens.ts:1-44`.
- `push-recipients.ts` — `selectPushRecipients`: pure filter — excludes the sender,
  excludes members with `muted:true`, excludes members present in the caller's fire-time
  presence snapshot. Verified: `domain/push-recipients.ts:15-23`.
- `notify-message.ts` — `sendPushForNewMessage`: reads membership + presence, filters via
  `selectPushRecipients`, looks up device tokens for the remaining recipients, sends, then
  prunes any token FCM reported dead. Every failure is logged (`push.delivery.degraded`)
  and returned as a `Result` — never thrown. Verified: `domain/notify-message.ts:38-95`.
- `session-claims.ts` / `wire.ts` — route-seam helpers (principal narrowing, DomainError→HTTP
  mapping). Not notification-specific logic.
- `templates/` — 15 files: `builder.ts` (the `defineEmailTemplate` DSL: Zod-validated
  params → escaped-placeholder HTML+text, wrapped in a shared dark-theme base template)
  plus one file per email (see §6). Verified file list:
  `apps/api/src/slices/notifications/domain/templates/*.ts` (14 template files + `base.ts`
  + `builder.ts`).

### Ports (`ports/`)

Four port files, each documenting a deliberate seam:
- `push-sender.ts` — `PushSender.send()`, `PushMessage`/`PushDelivery`/`PushRecipient`.
  Verified: `ports/push-sender.ts:9-38`.
- `device-token-store.ts` — `DeviceTokenStore` (upsert/deleteByToken/listTokensForUsers).
  Verified: `ports/device-token-store.ts:19-40`.
- `presence-reader.ts` — `PresenceReader.presence(conversationId)`. Comment states this
  slice **never** queries the ConversationRoom DO directly; composition root binds it.
  Verified: `ports/presence-reader.ts:1-15`.
- `membership-reader.ts` — `MembershipReader.listActiveUserMembers()`, returning
  `{userId, muted}`. Same never-cross-slice-query doctrine. Verified:
  `ports/membership-reader.ts:1-22`.
- `email-sender.ts` — `EmailSender`/`BatchEmailSender`, `EMAIL_BATCH_MAX`.

### What triggers a notification today

**Push** — exactly one trigger, "a new message got persisted," fired from two
composition-root call sites that both funnel through `createMessagePushNotify`
(`apps/api/src/adapters/push-notify.ts:33-57`):
1. The runless (non-AI) user-message send route, `apps/api/src/slices/chat/routes.ts:1555-1580`
   — fired via `c.executionCtx.waitUntil()` after the message and its broadcast are
   already committed; a presence-read or push failure can never touch the 200 response.
2. The AI-turn completion path inside the ConversationRoom DO, wired at
   `apps/api/src/adapters/conversation-room.ts:23-30` via the same
   `createMessagePushNotify` factory (confirmed by grep; the DO-side call site itself is
   in `packages/realtime`/room bindings, not reread line-by-line here — Inferred from the
   composition wiring, not directly re-verified in the DO's turn-completion code path).

No other event fires a push: no push for membership changes (added/removed/privilege
changed), forks, rotations, or shares.

**Email** — every current template is auth/security/admin/newsletter, never a
"someone messaged you" or "you were added" activity email (§6 has the full trigger map).

---

## 2. Push delivery: transport, config, stub vs. real

**One transport**: FCM HTTP v1 API (`https://fcm.googleapis.com/v1/projects/{id}/messages:send`),
reached via a hand-signed RS256 service-account JWT → OAuth token exchange
(`GOOGLE_TOKEN_URL`), no `firebase-admin` SDK (too heavy for Workers — stated in the
2026-02-22 mobile-app plan, `docs/plans/2026-02-22-capacitor-mobile-app.md:230`).
FCM proxies APNs for iOS — there is **no direct APNs integration**; iOS push rides FCM's
proxy exclusively. Verified adapter: `apps/api/src/slices/notifications/adapters/push-fcm.ts:1-268`.

**No Web Push (VAPID)** anywhere in the repo — confirmed absent by grep for
`web-push`/VAPID across `apps/api` and `apps/web`. Push is native-only (Capacitor); the
browser build gets no push notifications at all (§3).

**Selection** (`push-sender-factory.ts`): `createPushSenderFromEnv` throws if `NODE_ENV`
is unset; local dev and CI always get the in-process mock (`createMockPushSender`,
never sends, records nothing to disk); everywhere else it requires
`FCM_PROJECT_ID` + `FCM_SERVICE_ACCOUNT_JSON` or throws — no degraded mode. Verified:
`apps/api/src/slices/notifications/adapters/push-sender-factory.ts:18-45`.

**Env registry** (`packages/shared/src/env.config.ts:323-333`): `FCM_PROJECT_ID` and
`FCM_SERVICE_ACCOUNT_JSON` are `Destination.Backend` secrets, **production-only** — no
dev/CI value is registered ("push service uses console client" — i.e. the mock).
`GOOGLE_SERVICES_JSON_BASE64` (line 335) is a separate `Destination.Scripts` var (feeds
the native Android build's `google-services.json`, not the backend push sender) and *does*
carry a dev-mode literal (a real-shaped but placeholder Firebase project blob) — this is
client-build config, unrelated to server-side push credentials.

**Stub vs. real**: the FCM adapter is real, production-shaped code (JWT signing, OAuth
exchange, per-token dead-letter detection via `UNREGISTERED`/`NOT_FOUND` error codes,
service-evidence recording). But **FCM has no CI sandbox** — its own integration test
says so explicitly: "FCM has no CI sandbox, so the real send path is exercised against a
mocked HTTP seam." Verified:
`apps/api/src/slices/notifications/adapters/push-fcm.integration.test.ts:7-13`. Contrast
with Resend and OpenRouter, which both have real-credential CI paths
(`docs/DEVELOPMENT.md` CI section: "Helcim sandbox in the e2e job," "OpenRouter … in the
vitest test job … restricted key") — **push-FCM is never exercised against real Google
infrastructure anywhere in this codebase's CI**, only in production.

**Local dev mock**: `push-mock.ts` — in-memory array, `getSentMessages()`/`clearSentMessages()`.
Verified: `apps/api/src/slices/notifications/adapters/push-mock.ts:1-32`. Unlike the
email mock (§9), **nothing exposes this to a dev route** — grep for `getSentMessages`
across `apps/api/src` finds only the adapter itself and its own tests
(`push-mock.test.ts`, `push-sender-factory.test.ts`, `notify-message.integration.test.ts`).
There is no `/dev/push` viewer analogous to `/dev/emails`.

---

## 3. Browser-side / Capacitor native push

**No Web Notification API, no Service Worker, anywhere in `apps/web`.** Confirmed absent
by grep for `new Notification(`, `Notification.requestPermission`, `serviceWorker`,
`navigator.serviceWorker` across `apps/web/src` and `apps/web/public` — zero hits. The
browser build (non-Capacitor) has **no system-notification capability at all**, even
though `EmailSender`/push infrastructure exists server-side; a browser-tab user only ever
sees new messages live over the open WebSocket.

**Capacitor native** (`apps/web/src/capacitor/`):
- `hooks/use-push-notifications.ts` — no-ops entirely on web (`isNative()` guard). On
  native: requests permission via `PushNotifications.requestPermissions()`
  **immediately on mount, with no pre-permission education screen**, registers on grant,
  listens for `registration` (token) and `pushNotificationActionPerformed` (tap) events.
  Verified: `apps/web/src/capacitor/hooks/use-push-notifications.ts:19-58`.
- `provider.tsx` (`CapacitorProvider`) — wires the token callback to
  `POST /notifications/device-tokens` (fire-and-forget) and the tap callback to
  `navigate({ to: /chat/:conversationId })`, **after validating the conversationId against
  a strict UUID regex** (push payload data is untrusted input; the comment explicitly
  frames this as blocking traversal/token-injection). Verified: `provider.tsx:18-63`.
- Platform mapping: `ios` stays `ios`; any other native platform (including
  `android-direct`) is sent to the API as `android`. Verified: `provider.tsx:43-45`.

**No settings-page push control**: grep for `usePushNotifications` usage finds only
`provider.tsx` — there is no toggle in `apps/web/src/routes/_app/settings.tsx` to
view/manage registered devices, re-request permission, or disable push independent of the
OS-level permission. The only user-facing "notification" control anywhere in the UI is
the per-conversation mute toggle (§5).

**In-app toasts** exist (`sonner`-style `toast.error(...)` etc.) but are used exclusively
for action-failure UX (e.g. `apps/web/src/routes/dev.personas.tsx:67`,
`member-sidebar-body.tsx` `useAsyncAction({ fallback: 'toast' })`) — never for "new
message" or any notification-like event. Confirmed by grep: no toast call site references
message/chat/notification content.

---

## 4. Device token lifecycle

**Schema** (`packages/db/src/schema/device-tokens.ts:7-22`):
```
device_tokens: id (uuidv7 PK), user_id (FK → users, cascade delete),
  token (text, UNIQUE, NOT NULL), platform (enum, NOT NULL),
  created_at, updated_at (both defaultNow)
index: device_tokens_user_id_idx on user_id
```
`devicePlatformEnum` values: Inferred to be `'ios' | 'android'` from the client's binary
mapping in `provider.tsx:45` and the Zod schema `z.enum(devicePlatformEnum.enumValues)` in
`domain/device-tokens.ts:11` — the enum's own declaration file wasn't opened this pass
(Gap: exact enum member list not independently re-verified, only inferred from call
sites).

**Per-device, not per-user**: the unique constraint is on `token` alone, and upsert moves
a re-registered token to its new `userId` — so one physical device/install = one row,
reassigned on relogin as a different user. A user with N devices has N rows.

**Registration**: `POST /notifications/device-tokens`, `ON CONFLICT (token) DO UPDATE`
(idempotent.byUpsert). **Expiry/cleanup**: there is **no TTL, no `lastSeenAt` column, no
scheduled cleanup job** — confirmed absent by grep across `apps/api/src/jobs` and
`apps/api/src/platform` for `deviceToken`/`device_token`. The only pruning mechanism is
reactive: a token FCM reports as `UNREGISTERED`/`NOT_FOUND` gets deleted right after that
send fails (`notify-message.ts:84-95`, `push-fcm.ts:112, 151-157`). A token that simply
goes stale without ever being pushed to (e.g., the user never gets a push because they're
always present, or push volume is low) accumulates forever — no cron, no auditor. This
mirrors the architecture's stated "one mechanism per task" doctrine, but here the one
mechanism (reactive dead-token pruning) only fires on an actual send attempt.

---

## 5. User preferences / mute / quiet hours

**The only notification-adjacent preference is per-conversation mute**, stored as
`conversation_members.muted` (boolean, default false) —
`packages/db/src/schema/conversation-members.ts:34` (a `pinned` boolean sits alongside it,
unrelated to notifications). API: `PATCH /:conversationId/membership/mute` with
`{muted: boolean}`, `idempotent.byTransition`. Verified:
`apps/api/src/slices/conversations/routes.ts:669-687`. UI: three-dot menu on a sidebar
chat item toggles a Bell/BellOff icon via `useMuteConversation()`. Verified:
`apps/web/src/components/sidebar/chat-item.tsx:4-5, 20, 81, 106`.

**`account` slice `preferences`** (`apps/api/src/slices/account/domain/preferences.ts`) is
exclusively **accessibility** preferences (contrast, font scaling, motion — an
LWW-synced `AccessibilityPreferences` blob). It has **nothing to do with notifications** —
worth flagging explicitly since the name invites confusion. Verified:
`domain/preferences.ts:1-60` (full read; no notification field anywhere in the schema).

**No account-level notification preferences exist**: no global push on/off, no per-channel
(push vs. email) opt-out, no quiet hours, no digest-frequency control, no
granularity beyond "mute this one conversation." Confirmed by exhaustive grep across
`apps/api/src/slices/account` and `apps/web/src/routes/_app/settings.tsx` for
notification-preference language — none found beyond the mute toggle already covered.

**`generateNotifications()`** (`packages/shared/src/budget.ts:188`) is a
**client-side-only, unrelated function** despite the name: it maps a billing/budget
decision + capacity context to a `BudgetError[]` in-app notice vocabulary (low balance,
budget exhausted, etc.) for the chat composer UI. It never touches push, email, or the
`notifications` slice. `CODE-RULES.md` even calls this out: "Budget/billing notifications
use `generateNotifications()` (separate system, already user-friendly)" — confirming this
is deliberately a distinct, non-slice mechanism, not a gap.

---

## 6. Email notifications (Resend)

**Adapter** (`adapters/email-resend.ts`): plain `fetch()` against
`https://api.resend.com/emails` (single) and `/emails/batch` — no Resend SDK, matching
legacy. 10s timeout, **no retry** (a blind retry on a keyless single send could double-send;
batch sends do carry a caller Idempotency-Key but the retry decision stays with the
caller). Records a `resend` service-evidence row on success for CI's
`verify:evidence`. Verified: `adapters/email-resend.ts:1-125` (partial read to line ~120).

**Selection** (`email-sender-factory.ts`): local dev + CI → in-process mock wrapped with
mailbox capture (`withMailboxCapture`); everywhere else → real Resend, requiring
`RESEND_API_KEY` (production secret, `env.config.ts:284-288`; explicitly "NOT in CI —
email service uses console client when CI=true"). Same fail-fast-on-unset-`NODE_ENV`
pattern as push. Verified: `adapters/email-sender-factory.ts:64-84`.

**All 14 templates today, and their trigger classification**:

| Template | Trigger owner | Class |
|---|---|---|
| `verificationEmail` | identity (registration/email-verify flow), via `VerificationEmailPort` | Auth |
| `welcomeEmail` | identity, via `WelcomeEmailPort` | Auth |
| `passwordChangedEmail` | identity, via `PasswordChangedEmailPort` | Security |
| `passwordResetEmail` | identity, via `PasswordResetEmailPort` | Security |
| `twoFactorEnabledEmail` | identity, via `TwoFactorEnabledEmailPort` | Security |
| `twoFactorDisabledEmail` | identity, via `TwoFactorDisabledEmailPort` | Security |
| `accountLockedEmail` | identity, via `AccountLockedEmailPort` (login lockout) | Security |
| `chargebackLockEmail` | billing, via `ChargebackLockEmailPort` (Helcim chargeback/reversal clawback) | Billing/Security |
| `accountDeletedEmail` | identity, via `AccountDeletedEmailPort` | Auth |
| `adminOpNotificationEmail` | admin plane, `AdminOpEngineDeps.onExecuted` hook — fires once per committed admin mutation, "the admin plane's remaining tripwire against a compromised-but-valid session" | Admin/Security |
| `adminDailyDigestEmail` | `apps/api/src/jobs/admin-digest-entry.ts` (a cron-triggered job) | Admin digest |
| `newsletterConfirmationEmail` | newsletter slice (double opt-in) | Newsletter |
| `newsletterIssueEmail` | newsletter slice's `issue-email.ts` (batch dispatch job) | Newsletter |

Verified port declarations: `apps/api/src/slices/identity/ports/email.ts:18-96` (full
JSDoc for each identity port, confirming "best-effort by doctrine: the domain deliberately
ignores a failed Result"). Verified admin hook: `apps/api/src/slices/admin/domain/engine.ts:105-131`
(`AdminOpExecutedNotice`, `onExecuted?` — "fires once per COMMITTED execute … a throw is
captured and never fails the already-committed op").

**Zero "activity" emails exist** — no email for "you were added to a conversation,"
"someone shared a link with you," "you have unread messages," or any periodic user
digest. Every template is either auth/security, one-shot admin-mutation notice, admin
ops digest, or newsletter. This is a hard, structural gap relative to a typical chat
product's notification surface.

---

## 7. Realtime overlap (what the open-socket case already gets)

The ConversationRoom DO's hibernatable WebSocket delivers, per
`packages/realtime/src/events.ts` (grep of every `z.literal(...)` tag):
`message:new`, `message:stream`, `message:complete`, `message:deleted`,
`member:added`, `member:removed`, `member:privilege-changed`, `rotation:complete`,
`typing:start`, `typing:stop`, `presence:update`, `fork:created`, `fork:deleted`,
`fork:renamed`, `messages:deleted`. Verified line numbers:
`packages/realtime/src/events.ts:5,17,26,36,43,53,62,70,77,84,91,105,114,121,129`.

This is the entire "in-app, app-open" notification surface. There is **no unread-count
tracking, no document-title/favicon badge, no notification sound**, anywhere — confirmed
absent by grep across `apps/web/src` for `unread` (zero real hits; the only matches were
unrelated words like "unreadable") and for `document.title`/badge patterns (no hits tied
to messaging). A user with the app open but tab backgrounded gets no ambient signal beyond
whatever the OS/browser does natively for an inactive tab — i.e., none, since no
Notification API integration exists (§3). `presence:update` is exactly what suppresses
push for members who are "present" (per `selectPushRecipients`), so the presence signal
and the push-suppression logic are already coupled — but nothing surfaces presence loss
(tab backgrounded) as a "you might be missing this" in-app cue.

---

## 8. E2EE constraints on push payload content

Messages are end-to-end encrypted (epoch-keyed ECIES envelopes per
`docs/ARCHITECTURE.md` crypto sections) — push notifications sit **outside** that
envelope entirely, and the current design is deliberately content-free by construction,
not just by convention:

- `apps/api/src/adapters/push-notify.ts:24-31` states outright: "Message content NEVER
  reaches the payload: the title/body are fixed generic copy (a push notification sits
  outside the E2E envelope)," with the literal constants
  `NEW_MESSAGE_PUSH_TITLE = 'New message'` and
  `NEW_MESSAGE_PUSH_BODY = 'You have a new message in a conversation.'`.
- The `data` payload carries only `conversationId` (`notify-message.ts:64`) — no sender
  name, no message preview, no model name.
- Client-side, the tap handler treats `data.conversationId` as **untrusted input**,
  validating it against a strict UUID regex before navigating
  (`provider.tsx:18-21, 55-63`) — a hardening measure against a compromised or spoofed
  push payload.

**This is a deliberate deviation from the original design**: the 2026-02-22 mobile-app
plan (`docs/plans/2026-02-22-capacitor-mobile-app.md:260`, a `docs/plans/` file — history,
not current) explicitly specified "Notification payload includes `conversationId` +
message preview." The shipped implementation dropped the preview and hardened the
conversationId handling — a superseding decision, not documented as a formal design note
anywhere in the loaded/on-demand doc set (Gap: no `docs/` entry records *why* the plan's
"message preview" was dropped; it can only be reconstructed from the code comment's E2EE
rationale). No other privacy-of-notifications design doc exists in `docs/` beyond this
inline comment — confirmed by grep for "push notification"/"content-free" across
`docs/*.md` and `docs/history/*.md` (no hits outside the plan file above and this
codebase's own source comments).

Email templates carry no message content either (all are auth/security/admin/newsletter
per §6), so the E2E envelope is never touched by any current email trigger.

---

## 9. Tests and dev tooling

**Unit + integration tests exist for every notifications-slice file** (29 files under
`apps/api/src/slices/notifications`, listed in full below), plus composition-root tests
(`apps/api/src/adapters/push-notify.test.ts`, `send-email.test.ts`, and one test per
identity email adapter). No coverage gap was found within the slice by file inventory
(each `.ts` has a sibling `.test.ts` or `.integration.test.ts`).

Full slice file list (Verified via `find`):
```
adapters/device-token-store-db.ts (+ .integration.test.ts)
adapters/email-mock.ts (+ .test.ts)
adapters/email-resend.ts (+ .integration.test.ts)
adapters/email-sender-factory.ts (+ .test.ts)
adapters/push-fcm.ts (+ .test.ts, .integration.test.ts)
adapters/push-mock.ts (+ .test.ts)
adapters/push-sender-factory.ts (+ .test.ts)
domain/device-tokens.ts (+ .test.ts)
domain/index.ts
domain/notify-message.ts (+ .integration.test.ts)
domain/push-recipients.ts (+ .test.ts)
domain/session-claims.ts (+ .test.ts, inferred sibling)
domain/wire.ts
domain/templates/{account-deleted,account-locked,admin-daily-digest,
  admin-op-notification,builder,chargeback-lock,newsletter-confirmation,
  newsletter-issue,password-changed,password-reset,two-factor-disabled,
  two-factor-enabled,verification,welcome,base}.ts — each with a .test.ts
ports/{device-token-store,email-sender,membership-reader,presence-reader,
  push-sender}.ts (type-only files, no test needed)
routes.ts (+ .integration.test.ts)
index.ts
```

**E2E: zero coverage.** Grep across `e2e/` for `push`/`notif`/`device-token` found no
spec files — the one path match was an unrelated failed-run report directory name
containing the substring "push" from a different test's description ("long unbroken
strings do not push previous messages off screen"). No Playwright test exercises device
token registration, push delivery, or mute-suppresses-push end-to-end.

**Dev tooling**: `/dev/emails` (backend `GET /dev/emails` route + `apps/web` route
`dev.emails.tsx`) previews every email template with sample data
(`apps/api/src/platform/dev/routes.ts:141-142, 660`) and separately lists
**captured** (actually-sent-through-the-mock) emails via `listCapturedEmails()`/
`findCapturedEmail()` (`platform/dev/routes.ts:716-730`, backed by
`email-sender-factory.ts:18-51`). **No equivalent exists for push** — the mock push
sender's `getSentMessages()` is never wired to any dev route (confirmed by grep,
§2) — there is no way to see, in local dev, what push notifications *would* have
fired for a given action, only email.

---

## 10. Half-built / stubbed / deferred — summary

- **`PresenceReader` and `MembershipReader` are architecturally "ports bound at
  composition"**, explicitly documented in their own source as seams the notifications
  slice deliberately never implements — this is by design (single-writer-per-table /
  no-cross-slice-query doctrine), not unfinished work, and both are in fact bound today
  (§1 composition-root wiring confirmed).
- **FCM push has no real-infrastructure CI exercise** — production-shaped code, verified
  only against a mocked HTTP seam in CI (§2). This is the same category of gap Resend
  doesn't have (Resend has no CI credential either per `env.config.ts:287`'s "NOT in CI"
  comment, so email is in the same boat as push here — neither push nor email is
  exercised against real infra in CI; only OpenRouter and Helcim are, per
  `docs/DEVELOPMENT.md`'s CI section).
- **No device-token expiry/cleanup mechanism** beyond reactive dead-token pruning on a
  failed send (§4) — a device that's uninstalled but never pushed to leaves a permanent
  row.
- **No dev-route visibility into mock push sends** (§2, §9) — an asymmetry with the
  email dev-mailbox.
- **No browser (non-native) push or Notification API at all** (§3) — push is
  Capacitor-only; the web SPA has zero system-notification capability.
- **No account-level notification preferences, no quiet hours, no per-channel opt-out**
  (§5) — mute is the sole, per-conversation, binary control.
- **No "activity" email templates** (§6) — nothing for membership/share/mention-type
  events; email is entirely auth/security/admin/newsletter.
- **No unread-count/badge/title/sound layer** for the in-app-but-not-watching case (§7).
- **Zero E2E coverage** of the entire notification surface (§9).
- **The original plan's "message preview in push payload" was dropped** in favor of
  content-free copy, for E2EE reasons stated only in a code comment, not a `docs/`
  design record (§8) — worth formalizing if the workstream touches push payload shape
  again.
