# Plan — Push & browser notification system (2026-07-23-notifications)

Tier 2. Orchestrated via subagent-driven-dev. Design record: `research/` in this run dir
(`current-system.md`, `loved-features.md`, `platform-capabilities.md`,
`webpush-library.md`, `server-pipeline-design.md`, `client-design.md`). Where a research
doc conflicts with this plan, THIS PLAN WINS — founder rulings landed after the analysts
wrote (notably: mute stays a boolean, no duration tiers; unread badge is client-only).

## Founder rulings (binding)

- FCM is the single mobile gateway (no direct APNs). iOS shell fix via
  `@capacitor-community/fcm` (dependency approved 2026-07-24, round 3 — it coexists with
  `@capacitor/push-notifications`; `@capacitor-firebase/messaging` was REJECTED because it
  forbids coexistence and would force an Android rewrite + the `firebase` JS SDK).
- Web Push sender is written in-house (no new dependency; clean-room RFC 8291/8188/8292;
  `web-push-neo` is MPL-2.0 — reference only, never vendor/copy its code).
- ALL notification payloads are generic and content-free: event type + conversationId
  deep link only. Never sender names, conversation titles, message content, or any
  user-generated text. No on-device decryption enrichment, no NSE.
- Controls: account-level per-category toggles (messages / run completions / membership),
  quiet hours, global switch — all explicit and server-evaluated. Per-conversation mute
  stays the existing BOOLEAN (no duration tiers — rejected). No per-device management UI.
- Permission UX: remove ask-on-mount; one-time dismissible "enable notifications?"
  surface that also points to Settings. No smart/value-moment priming (rejected).
- Dismiss-on-read-elsewhere: kept (collapse/tag + durable read cursor + lazy client clear).
- Unread badge: client-only activity badge ("activity since you looked away") — hybrid
  and server-authoritative variants rejected for this run.
- Schema approved: new `notification_preferences` table; `device_tokens` web extension +
  `lastSeenAt`; `conversation_members.lastReadSeq`. REJECTED: any mute schema change.
- PWA manifest approved (app becomes installable; that side effect is accepted).
- Doctrine doc `docs/NOTIFICATIONS.md` + DEVELOPMENT.md index entry: written AFTER design
  (now), BEFORE implementation — Task 00.
- Quiet hours: suppressed events are dropped (no deferred delivery, no badge-only mode).
- No message queues/jobs for delivery: notifications are best-effort, fired at the
  composition root. The only scheduled work is the stale-token retention delete.

## Global Constraints

- G1 **Generic payload law**: no push payload, notification title/body, tag, or Topic
  header may carry user-generated text or a raw conversationId in any
  push-service-visible header. Notification text is a fixed per-category string. The
  Web Push `Topic`/tag value is a derived alias (truncated HMAC of conversationId with a
  server secret), never the raw id. (FCM data payloads may carry the raw conversationId
  as today — FCM sees it regardless; document, don't widen.)
- G2 **Best-effort law**: notification delivery never blocks, never joins, and never
  fails a domain transaction; call sites use `waitUntil`/fire-and-forget at the
  composition root. No jobs rows for delivery.
- G3 **Server-evaluated controls**: prefs, quiet hours, mute, and presence suppression
  are evaluated in ONE pure decision function in the notifications slice domain. The
  client never re-implements "should this user be notified" (display-point routing —
  focused-tab suppression in the SW — is allowed: it decides where to show, not whether
  to send).
- G4 **One lifecycle**: web subscriptions live in `device_tokens` (platform `web`);
  registration is `byUpsert`; dead-token detection is reactive on send (FCM
  UNREGISTERED / Web Push 404+410 → existing `deadTokens` prune); the retention cron
  deletes only stale-by-`lastSeenAt` rows. No second cleanup mechanism.
- G5 **Registry law**: all new env vars (`VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY` /
  `VITE_VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`) are env.config registry entries with values
  for every mode (committed throwaway keypair for development/ciVitest/ciE2E; production
  via Workers secrets). Fail-fast at factory construction. No `??` fallbacks.
- G6 **Type-safety**: SW written in TypeScript against WebWorker lib types; push payloads
  validated with a shared Zod schema from `@hushbox/shared` on both send (api) and
  receive (SW); the conversation-id validator is the single shared implementation
  (hoisted, One Implementation Shared) — no second copy anywhere.
- G7 **TDD + coverage**: every task test-first per AGENT-RULES; 95% per-file line/branch/
  function coverage on files the task owns; scoped checks green after the LAST edit
  (including `eslint <owned files>` exit-0 run from the package dir).
- G8 **Accessibility**: all new UI uses `@hushbox/ui` primitives, labelled controls,
  `fieldset/legend` for grouped settings, `role="status"`/`aria-live="polite"` for the
  prompt and unread announcements; sound is opt-in, default off, never the sole signal.
- G9 **Mocks only at true external seams**: FCM HTTP seam and Web Push HTTP seam are
  mockable; internal slices are never mocked. Dev/CI push goes through the mock sender
  with the capture layer (`/dev/push`).
- G10 **No git writes** by any agent. Docs other than `docs/NOTIFICATIONS.md`,
  `docs/DEVELOPMENT.md` (Task 00) and generated files are read-only.
- G11 **No plan/task-ID labels in shipped code** (durable-naming, CODE-RULES): never
  embed task numbers, plan-section refs, "spike", "T04"/"G6"-style tags, or run-dir
  references in production code, comments, or test names. Reference behavior, not this
  run's bookkeeping. Auditors check for this.

## Interfaces (contracts between tasks)

- I1 `packages/shared` exports (Task 01):
  - `notificationCategorySchema = z.enum(['message', 'runCompletion', 'membership'])` and
    `NotificationCategory`.
  - `pushEventPayloadSchema` — the generic wire payload:
    `{ category: NotificationCategory, conversationId: uuid }` (extensible object,
    strict).
  - `conversationIdSchema` (the hoisted UUID validator; replaces the inline regex in
    `apps/web/src/capacitor/provider.tsx:21`).
- I2 `packages/db` (Task 02):
  - `notificationPreferences` table: `userId` PK/FK, `globalEnabled bool NOT NULL
    DEFAULT true`, `messages bool NOT NULL DEFAULT true`, `runCompletion bool NOT NULL
    DEFAULT true`, `membership bool NOT NULL DEFAULT true`,
    `quietHoursStartMinutes int NULL`, `quietHoursEndMinutes int NULL` (both-or-neither
    CHECK), `timezone text NULL` (required-with-quiet-hours CHECK), timestamps.
    Missing row = all defaults (lazy — no backfill).
  - `deviceTokens`: `devicePlatformEnum` gains `'web'`; new nullable `p256dh text`,
    `auth text`, CHECK (`platform='web'` ⟺ both keys present); `lastSeenAt timestamptz
    NOT NULL DEFAULT now()`; `token` column holds the Web Push endpoint for web rows
    (unique already).
  - `conversationMembers`: `lastReadSeq bigint NOT NULL DEFAULT 0`.
- I3 notifications slice barrel (Task 04): `notifyEvent(deps, { category,
  conversationId, actorUserId, recipientUserIds?, presentUserIds })` — best-effort,
  channel-blind; plus prefs read/write domain fns and routes
  (`GET/PUT /notifications/preferences`), and web-subscription registration
  (`POST /notifications/device-tokens` discriminated-union body or sibling route —
  implementer's call, Zod-typed `{endpoint, keys:{p256dh, auth}}`, `byUpsert`).
- I4 `PushSender` port (Task 03/04): recipient discriminated union
  `{platform:'ios'|'android', token} | {platform:'web', endpoint, p256dh, auth}`; result
  carries per-recipient outcomes + `deadTokens`. Composite adapter partitions by
  platform → FCM adapter | webpush adapter. **Collapse identity — two layers, resolved
  during Task 07 (do not re-litigate):** (a) PUSH-SERVICE-VISIBLE collapse hints the
  SERVER sends — the Web Push `Topic` HEADER and the FCM `collapse_key` — MUST be the
  derived alias `base64url(HMAC-SHA-256(NOTIFICATION_TAG_SECRET, conversationId))≤32`
  (G1; these are readable by Google/Mozilla/Apple). (b) The DEVICE-LOCAL notification
  `tag` the client sets on the DISPLAYED notification (SW `showNotification`, native
  shade) = the raw `conversationId` from the decrypted/data payload — device-local, never
  a push-service header, so G1-safe; this is what Task 09 uses to clear delivered
  notifications. The I1 payload carries `conversationId` (encrypted for web; already
  FCM-visible for native), NOT an alias — there is no alias field in the payload.
- I5 Read cursor (Task 05): `PATCH /conversations/:id/read { lastReadSeq }` route
  (idempotency-exempt natural class like mute), write =
  `GREATEST(lastReadSeq, $new)`; exposed in the conversations list/member payloads the
  client already fetches.
- I6 Client facade (Task 08): `notificationChannel` module —
  `getPermissionState()`, `requestPermissionAndRegister()`, `unregister()`; web adapter
  (Notification API + PushManager + SW) and native adapter (Capacitor plugin) selected by
  `isNative()`.
- I7 SW ↔ page protocol (Tasks 07/09): SW posts `{type:'push-event', payload:
  PushEventPayload}` to focused clients; page listens via a single registration point in
  the unread store setup.

## Task graph

```
00 doctrine doc ──(gates all implementation tasks)
01 shared contracts ──→ 03, 04, 07, 08
02 db migrations ──→ 04, 05
03 webpush sender + env registry ──→ 04, 07(public key), 06
04 pipeline core (decision fn + composite sender + prefs API + web registration) ──→ 05, 06, 10
05 event sources + read cursor
06 dev inbox + retention job
07 SW + manifest + build wiring ──→ 08
   (NOTE: 08 also depends on 04 — its subscription-registration POST consumes I3's
    web-subscription route; 08 dispatches only when BOTH 04 and 07 are clean.)
08 client facade + prompt + subscription lifecycle ──→ 09
09 foreground layer + dismissal clearing   (needs 05's read exposure for clear-on-foreground)
10 settings card
11 iOS Firebase integration   (independent; owns apps/web/package.json + ios/)
12 Maestro notification flows  (after 08; owns mobile-tests/**)
13 Playwright notifications spec (after 08, 09, 10; owns e2e/notifications/**)
```

No two concurrent tasks share files. 11 must not run concurrently with 07/08 only if
`apps/web/package.json` needs edits in those tasks — it does not (no new web deps); 11
owns it exclusively.

---

## Task 00 — Notification doctrine doc

STATUS: executed by the orchestrator at explicit founder instruction (2026-07-24,
"Write the doc and add it to development now"), ahead of plan approval. Gets an auditor
pass in Phase 4 like any other task output.

**Objective:** Write `docs/NOTIFICATIONS.md` (new, founder-approved) and add its
DEVELOPMENT.md doc-index line, capturing the design of record before implementation.

**Design context:** The content-free payload decision currently lives only in a code
comment; the founder ruled it becomes doctrine. This doc is the "loaded/on-demand" home
for: the generic payload law (G1) incl. the Topic-alias rule and the FCM-sees-
conversationId asymmetry; best-effort delivery stance (G2, no jobs, drop-on-quiet-hours);
the controls model (server-evaluated, G3); the subscription lifecycle (G4); transports
per platform (FCM mobile / in-house Web Push; iOS browser = installed PWA only); the
dismissal model (collapse + read cursor + lazy clear; cross-device dismissal is eventual);
and the permission UX rule (one-time prompt, never on mount).

**Acceptance criteria:**
- `docs/NOTIFICATIONS.md` exists, covers every bullet above, cites no run-dir paths,
  follows doc rules (no version numbers, no task IDs, durable facts only).
- `docs/DEVELOPMENT.md` doc index gains one line with a read trigger ("any notification,
  push, or service-worker work").
- Prose passes the anti-slop bar of existing docs (terse, declarative).
- No other file touched.

**Files:** `docs/NOTIFICATIONS.md` (new), `docs/DEVELOPMENT.md` (index line only).
**Scoped checks:** `pnpm lint` (prettier via ESLint covers md formatting if configured);
otherwise none — doc-only.
**Sensitive:** no.

## Task 01 — Shared contracts

**Objective:** Add notification category + push payload schemas and hoist the
conversation-id validator into `@hushbox/shared`; consume the hoisted validator at its
current call site.

**Design context:** G6/I1. The UUID validator currently lives inline at
`apps/web/src/capacitor/provider.tsx:21`; the SW (Task 07) must use the same
implementation — hoist BEFORE a second copy can exist. Categories are a closed set
(founder-ruled three).

**Acceptance criteria:**
- I1 exports exist with tests (valid/invalid payloads, unknown-key rejection via strict
  schema, category exhaustiveness).
- `provider.tsx` imports the shared validator; behavior unchanged (existing tests pass).
- No other consumer added yet.

**Files:** `packages/shared/src/notifications/**` (new), `packages/shared/src/index.ts`
(export line), `apps/web/src/capacitor/provider.tsx` (import swap only).
**Scoped checks:** `pnpm test:shared`, `pnpm test:web`,
`turbo typecheck lint --filter=@hushbox/shared --filter=@hushbox/web`,
`jscpd --threshold 2` on owned files.
**Sensitive:** no.

## Task 02 — DB migrations

**Objective:** Ship the three approved schema changes (I2) with a generated migration.

**Design context:** Founder approved exactly these; mute schema is untouchable. Missing
prefs row = defaults (lazy, no backfill). `lastReadSeq` defaults 0 (= nothing read;
`messages.sequence` is ≥1 per data-model). CHECKs enforce web-row key presence and
quiet-hours field coherence at the database (fail-fast).

**Acceptance criteria:**
- Drizzle schema edits + `pnpm db:generate` migration committed together (CI drift gate).
- `relations()` wired; every new FK indexed (userId PK covers prefs).
- Schema tests cover: CHECK violations rejected (web row without keys; one-sided quiet
  hours; tz-less quiet hours), enum extension, monotonic-friendly default.
- `pnpm db:migrate` clean on a reset local db AND — mandatory — the new migration
  applies clean **incrementally** (prior migration committed, then the new one applied
  ALONE in its own transaction). A fresh reset runs every migration co-transactionally
  and MASKS Postgres enum-add-then-use hazards (`ALTER TYPE ADD VALUE` cannot be used in
  the same transaction that added it); the incremental apply is the production deploy
  path and is the one that must be proven. Verify with the real migrate binary, not only
  the test harness's fresh-DB `beforeAll`.

**Files:** `packages/db/src/schema/notification-preferences.ts` (new),
`packages/db/src/schema/device-tokens.ts`,
`packages/db/src/schema/conversation-members.ts`, `packages/db/src/schema/index.ts`,
`packages/db/drizzle/**` (generated).
**Scoped checks:** `pnpm test:db`, `turbo typecheck lint --filter=@hushbox/db`.
**Sensitive:** no.

## Task 03 — In-house Web Push sender + env registry

**Objective:** A Workers-native Web Push sender module (RFC 8291 aes128gcm payload
encryption, RFC 8188 encoding, RFC 8292 VAPID via `jose`) in the notifications slice
adapters, plus the VAPID env.config registry entries with a committed dev keypair.

**Design context:** research/webpush-library.md — every third-party option is broken or
disqualified; clean-room in-house (~250 LOC) with RFC 8291 Appendix-A deterministic test
vectors (injectable ephemeral key + salt). MPL-licensed `web-push-neo` may be read for
cross-checking, never copied. `jose` is already a dependency. G5 for keys. Send fn
returns typed outcomes incl. permanent-failure classification (404/410 → dead;
429/5xx → transient failure, no retry machinery — best-effort).

**Acceptance criteria:**
- `sendWebPush({endpoint, p256dh, auth}, payloadBytes, {ttl, topic, urgency})` module:
  aes128gcm encryption pinned by the RFC 8291 Appendix-A test vector (exact ciphertext
  match), VAPID ES256 JWT pinned by structural verification (aud/exp/sub claims, ES256
  P-256 signature verifies against the public key).
- Topic header: caller-supplied, ≤32 chars, [A-Za-z0-9_-] validated (fail-fast).
- Env registry: `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VITE_VAPID_PUBLIC_KEY`,
  `VAPID_SUBJECT` for all four modes; dev/CI values are a committed throwaway keypair
  (never used against real push services); `pnpm verify:env` green; gitleaks must not
  fire (dev private key needs an allowlist entry pinned to its exact path — follow the
  seed-crypto precedent).
- No new npm dependency. 95% coverage on owned files.

**Files:** `apps/api/src/slices/notifications/adapters/webpush/**` (new),
`packages/shared/src/env.config.ts` (entries), `.env.development` /
env-generation source if applicable, `.gitleaks.toml` (allowlist entry).
**Scoped checks:** `pnpm test:api`, `pnpm test:shared`,
`turbo typecheck lint --filter=@hushbox/api --filter=@hushbox/shared`,
`pnpm verify:env`.
**Sensitive:** YES (crypto) → 2 independent auditors.

## Task 04 — Pipeline core

**Objective:** Generalize the push path into `notifyEvent` (I3): pure decision function
(prefs + quiet hours + boolean mute + presence + global switch), composite `PushSender`
(I4) over FCM + webpush adapters with collapse identity stamping (G1 alias), prefs
read/write routes, and typed web-subscription registration.

**Design context:** research/server-pipeline-design.md §1/§2/§4 as amended by rulings
(mute stays boolean — read it exactly as `sendPushForNewMessage` does today; no
mutedUntil anywhere). Existing `sendPushForNewMessage` becomes the `message` category of
`notifyEvent`; existing behavior (presence suppression, mute, dead-token pruning) is
preserved and extended, not duplicated. Quiet hours: IANA tz via `Intl.DateTimeFormat`
in workerd — VERIFY FIRST (spike test in this task; if workerd lacks arbitrary-zone
support, STOP and report BLOCKED — the fallback choice is the human's). The derived
alias = base64url(HMAC-SHA-256(secret, conversationId)) truncated to 32 chars; secret =
a new env.config entry (`NOTIFICATION_TAG_SECRET`, all modes). Prefs routes require
`Idempotency-Key`-exempt classification identical to existing prefs-like routes
(`byUpsert`).

**Acceptance criteria:**
- Pure decision fn with exhaustive unit tests: category toggles, global switch, quiet
  hours (incl. cross-midnight windows, tz boundaries, missing-row defaults), mute,
  presence, actor exclusion; injected `now`.
- `notifyEvent` barrel export; `sendPushForNewMessage` callers migrated; message-path
  integration tests still green (behavior identical for the message category with
  default prefs).
- Composite sender partitions recipients; FCM rows get `collapse_key`+`tag`, web rows
  get `Topic` — all the derived alias, never raw id (test asserts no raw conversationId
  in any web header).
- Web Push 404/410 land in `deadTokens` and prune (integration test through the mock
  seam); `lastSeenAt` touched on successful registration and send.
- `GET/PUT /notifications/preferences` with Zod validation + integration tests; web
  subscription registration upserts by endpoint with typed keys (I3).
- workerd Intl spike test pinning arbitrary IANA zone evaluation.

**Files:** `apps/api/src/slices/notifications/**` (domain, routes, adapters/composite,
index barrel), `apps/api/src/adapters/push-notify.ts`,
`packages/shared/src/env.config.ts` (`NOTIFICATION_TAG_SECRET` only — coordinate: Task 03
finishes its env edits first; 04 depends on 03).
**Scoped checks:** `pnpm test:api`, `turbo typecheck lint --filter=@hushbox/api`,
`jscpd --threshold 2` on owned files.
**Sensitive:** YES (authz-adjacent recipient selection, user data) → 3-lens panel.

## Task 05 — Event sources + read cursor

**Objective:** Fire `notifyEvent` for run-completion (presence-aware, from the DO
terminal sink) and membership events (added-to-conversation, fork/share activity, from
conversations routes, `waitUntil`); add the read-cursor write route (I5) and expose
read state to the client.

**Design context:** research/server-pipeline-design.md §1/§3. Presence rides the
caller's fire-time snapshot (the DO sink already passes `presentUserIds`). Run-completion
must not fire for the runless-send path (already covered as `message`). The read cursor
is conversations-slice-owned; write is monotonic GREATEST (naturally idempotent, no
check-then-act); route classification mirrors the mute route. Membership reader
duplication (`push-notify.ts:59-66`): attempt the hoist to a `@hushbox/realtime`-free
module; if the workerd import constraint still binds, keep the documented duplication
and say so in the report (do NOT add a third copy).

**Acceptance criteria:**
- Run-completion push: integration test — run terminal settle notifies non-present,
  non-muted, prefs-on members exactly once; present users excluded; failed runs do not
  notify (only successful completion — the client's own deadline UX covers failures).
- Membership events: integration tests for added-to-conversation and share/fork
  activity, category `membership`.
- `PATCH /conversations/:id/read` monotonic (GREATEST) with idempotency test (replay +
  out-of-order writes); member read state exposed where the conversations list/member
  payload is already served.
- All best-effort call sites use `waitUntil`; no notification failure can fail a domain
  transaction (test: sender throwing does not surface).

**Files:** `packages/realtime/src/**` (DO terminal sink call site),
`apps/api/src/slices/conversations/**` (routes + read-cursor domain),
`apps/api/src/adapters/push-notify.ts` IF the hoist lands (coordinate: 04 owns this file
earlier; 05 runs after 04 — no concurrency conflict).
**Scoped checks:** `pnpm test:api`, `pnpm test:realtime`,
`turbo typecheck lint --filter=@hushbox/api --filter=@hushbox/realtime`.
**Sensitive:** YES (membership/authz) → 3-lens panel.

## Task 06 — Dev inbox + retention job

**Objective:** `/dev/push` capture viewer mirroring the email mailbox pattern, and the
stale-token retention delete on the cron schedule.

**Design context:** G4/G9. Capture wraps the mock composite sender exactly as
`withMailboxCapture` wraps email. Retention: delete `device_tokens` rows with
`lastSeenAt` older than a threshold (constant with rationale; retention deletes are
cron-legal). Not a delivery mechanism, no jobs rows.

**Acceptance criteria:**
- `/dev/push` lists captured sends (recipient platform, category, alias tag, payload)
  dev-only-classed; integration tests incl. the existing dev-routes conventions.
- Retention entry wired into `scheduled.ts` with tests (stale deleted, fresh kept,
  `lastSeenAt` refresh on send proven in 04 keeps active rows alive).
- Mock webpush sender records the same shape real one returns.

**Files:** `apps/api/src/platform/dev/**`, `apps/api/src/scheduled.ts`,
`apps/api/src/slices/notifications/adapters/**` (mock + capture only).
**Scoped checks:** `pnpm test:api`, `turbo typecheck lint --filter=@hushbox/api`.
**Sensitive:** no.

## Task 07 — Service worker + manifest + build wiring

**Objective:** Push-only TypeScript SW at a stable `/sw.js`, hand-written
`manifest.webmanifest`, headers entry, and the second build entry.

**Design context:** research/client-design.md §1 (option A). NO fetch handler, NO
precache, ever. Payload validated with the shared schema (G6); `notificationclick` uses
the hoisted validator; focused-client check posts I7 message instead of showing. Build:
stable unhashed output shipped in the same `dist/` Pages+`cap sync` consume;
`Cache-Control: no-cache` for `/sw.js` via the headers SOURCE (headersPlugin), never
dist edits. Registration helper gated `!isNative()`.

**Acceptance criteria:**
- SW handlers unit-tested as pure functions over injected deps: push→showNotification
  (generic per-category strings), push→postMessage when a focused client exists,
  notificationclick→focus-or-open `/chat/:id` (invalid ids dropped), tag/collapse set
  from payload alias, `pushsubscriptionchange` re-subscribe + re-register (cookie-auth
  assumption verified or the postMessage fallback implemented).
- Manifest: name/icons/display standalone/start_url; linked from index.html; icons from
  existing assets.
- Build produces `dist/sw.js` (stable name) + manifest; headers rule present; `pnpm
  build` (web) green.
- No fetch handler present (test asserts the SW registers no fetch listener).

**Files:** `apps/web/src/sw/**` (new), `apps/web/vite.config.ts`,
`apps/web/public/manifest.webmanifest` (new), `apps/web/index.html`, headers source,
`apps/web/src/lib/register-sw.ts` (new).
**Scoped checks:** `pnpm test:web`, `turbo typecheck lint --filter=@hushbox/web`,
`pnpm build --filter=@hushbox/web` (or the repo's build task for web).
**Sensitive:** no (payloads are generic; no auth logic) → 1 auditor.

## Task 08 — Client facade, one-time prompt, subscription lifecycle

**Objective:** The `notificationChannel` facade (I6) over web/native adapters; remove
ask-on-mount; the one-time inline enable prompt; web subscription lifecycle
(subscribe-on-grant, re-register on app start, unsubscribe on logout/global-off).

**Design context:** research/client-design.md §2/§3. Prompt: inline dismissible callout
(announcements-banner visual language), localStorage persistence
(`hb:notif-prompt-dismissed`), suppressors: permission not `default`, no push path
(`'PushManager' in window`, non-installed iOS Safari), global setting off, native
permission already handled. Native adapter moves `requestPermissions()` behind the same
gate (removing `use-push-notifications.ts` mount-time ask). VAPID public key via
`VITE_VAPID_PUBLIC_KEY` env module. All API calls through the typed client.

**Acceptance criteria:**
- Ask-on-mount is gone (test: mount triggers no permission request on either platform).
- Facade unit tests per adapter: permission states, register/unregister flows,
  re-registration on authenticated start (fire-and-forget), logout unsubscribes
  best-effort.
- Prompt component: renders once, Enable → grant flow → subscribe → registration POST;
  Later → never again (localStorage); all suppressors tested; `role="status"`,
  keyboard-reachable, focus not stolen (G8).
- Copy mentions Settings as the ongoing control point (DESIGN.md voice).

**Files:** `apps/web/src/lib/notification-channel/**` (new),
`apps/web/src/capacitor/hooks/use-push-notifications.ts`,
`apps/web/src/capacitor/provider.tsx` (gate change only),
`apps/web/src/components/notifications/enable-prompt.tsx` (new), hook files for
registration mutations.
**Scoped checks:** `pnpm test:web`, `turbo typecheck lint --filter=@hushbox/web`.
**Sensitive:** no → 1 auditor (but auditor checks the permission-flow correctness).

## Task 09 — Foreground layer + dismissal clearing

**Objective:** Client-only activity badge (zustand store → tab title + `setAppBadge` +
opt-in sound), SW postMessage intake, and delivered-notification clearing (on
conversation view, on app foreground vs read-elsewhere state).

**Design context:** research/client-design.md §4 as ruled: CLIENT-ONLY activity
semantics — count = events observed by this tab while unfocused (open-socket frames +
SW `push-event` messages); reset on focus/`markAllSeen`; reopens at zero by design.
Store interface stays source-agnostic (`unreadCount`, `markAllSeen()`). Clearing: on
rendering a conversation, clear its tag (`removeDeliveredNotifications({tag})` native /
`getNotifications({tag})→close()` web); on foreground, fetch read state (exposed by
Task 05) and clear by `conversationId` for conversations read elsewhere. **The
device-local notification tag IS the `conversationId` (resolved in Task 07 / I4) — NOT a
server alias.** The client already has conversationId (payload + read-state), so no
server alias is needed or exposed client-side; the derived alias exists ONLY in the
server's push-service-visible headers (Topic/collapse_key) and is never re-implemented
client-side (G3/G6). Tab title effect is the ONLY title writer.

**Acceptance criteria:**
- Store unit tests: increment rules (only while hidden/unfocused; own-actions excluded),
  reset on focus, `markAllSeen`.
- Title effect: `(n) ` prefix appears/clears; no other writer introduced.
- `setAppBadge` feature-detected, cleared on markAllSeen (mock navigator tests).
- Sound: plays only when enabled + event arrives; toggle is the unlock gesture; never
  sole signal (aria-live region announces count changes politely).
- Clearing: viewing a conversation clears its delivered notifications (both adapters,
  mocked); foreground sync clears read-elsewhere tags (test with mocked read-state).
**Files:** `apps/web/src/stores/notifications.ts` (new), title/badge/sound effect
modules (new), `apps/web/src/lib/notification-channel/**` (clear fns — add them TO the
facade per §Standing-amendments), conversation-view + focus wiring points, PLUS (scope
extended after Task 05, which produced the server side but could not type it):
`packages/shared/src/schemas/api/conversations.ts` — add `lastReadSeq` to
`membershipViewSchema` and `conversationListItemSchema` (the server already returns it;
the client has no type for it, which blocks this task) — and
`apps/web/src/demo/mock-backend/**`, which must emit the field or default it
(`store.test.ts` parses `listConversationsResponseSchema`, so a bare required field
fails it).
**Extra scoped checks for the extended scope:** `pnpm test:shared`,
`turbo typecheck lint --filter=@hushbox/shared`.
**Scoped checks:** `pnpm test:web`, `turbo typecheck lint --filter=@hushbox/web`.
**Sensitive:** no → 1 auditor.

## Task 10 — Settings card

**Objective:** "Notifications" Card on `/settings`: global switch, three category
toggles, quiet-hours controls (two `Select`s + timezone auto-fill), wired to the prefs
API via typed-client TanStack hooks.

**Design context:** research/client-design.md §5. Follow `MailingListCard` structure.
Timezone: auto-populate from `Intl.DateTimeFormat().resolvedOptions().timeZone` on save;
display it; no free-text tz entry. Copy states plainly that quiet-hours pushes are
dropped, not deferred. Mute stays where it is (sidebar Bell) — THIS TASK DOES NOT TOUCH
MUTE. Global-off must also drive `notificationChannel.unregister()` (Task 08's facade).

**Acceptance criteria:**
- Card renders current prefs (query), mutations optimistic-or-invalidate per repo
  convention; loading/error states per existing cards.
- Quiet hours: enable toggle reveals `fieldset` with start/end Selects (hour granularity)
  + detected timezone; both-or-neither enforced client-side for UX AND server-side
  (server wins — complementary, not duplicated).
- All controls labelled; keyboard operable; WCAG contrast via tokens (no inline styles).
- Global switch off → unregister call fired; on → prompt/permission flow via facade.
**Files:** `apps/web/src/components/settings/notifications-card.tsx` (new),
`apps/web/src/routes/settings.tsx` (mount line), notification prefs hook file (new).
**Scoped checks:** `pnpm test:web`, `turbo typecheck lint --filter=@hushbox/web`.
**Sensitive:** no → 1 auditor.

## Task 11 — iOS Firebase integration

**Objective:** Fix iOS push end-to-end: add `@capacitor-community/fcm` ALONGSIDE the
existing `@capacitor/push-notifications` (they coexist), wire the Firebase iOS SDK so the
iOS APNs token is exchanged for an FCM token, and add a small iOS-only branch in the
client hook that sends the FCM token. Android stays UNTOUCHED.

**Design context (founder-ruled 2026-07-24, see research/ios-fcm-plugin-decision.md):**
Verified broken today (raw APNs token → FCM rejects). The founder chose `@capacitor-
community/fcm` (v8.1.0, coexists with the push plugin, no `firebase` JS peer) over the
originally-mentioned `@capacitor-firebase/messaging` (which forbids coexistence and would
force an Android rewrite + full `firebase` JS SDK) — do NOT use the latter. Integration
per that plugin's docs: `PushNotifications.register()` remains the required first step
(it performs APNs registration); on iOS only, after registration, call `FCM.getToken()`
and send THAT token; on Android keep sending the `registration` event token exactly as
today (Android is FCM-native and VERIFIED working — google-services.json + gradle plugin
present; do not touch it). iOS-native prerequisites (`GoogleService-Info.plist`, Firebase
iOS SDK via SPM, APNs .p8 auth key uploaded to the Firebase project) are founder-owned
secrets/console work — use a committed placeholder plist that the build accepts for
dev/CI and DOCUMENT the exact founder production steps in the report. The permission-
timing change (removing ask-on-mount) is Task 08's job, NOT this task's — touch only the
token-acquisition path here.

**Acceptance criteria:**
- `pnpm` dep added (exact version pinned per repo convention); iOS project builds
  (`cap sync` + Xcode build if runnable in this environment; otherwise typecheck +
  sync green and the gap stated in the report — real-device verification is
  founder-owned and listed as such).
- Token registration path on iOS yields an FCM token (unit-test the JS branch; native
  bridge covered by plugin).
- Android path regression-tested (registration listener unchanged).
- A short founder-facing note in the impl report: exact production steps (Firebase
  console, plist secret, APNs key upload).
**Files:** `apps/web/package.json`, `apps/web/ios/**`, `apps/web/capacitor.config.ts`
(if plugin config needed), `apps/web/src/capacitor/**` (token acquisition branch).
**Scoped checks:** `pnpm test:web`, `turbo typecheck lint --filter=@hushbox/web`.
**Sensitive:** no → 1 auditor (plus the founder-owned device verification noted).

## Task 14 — Arch registry: table ownership

**Objective:** register `notificationPreferences` as owned by the `notifications` slice in
the arch-rule table-owner registry so `pnpm arch:check` is green.

**Design context (plan gap, found by Task 04's conventions audit):** the
`single-writer-per-table` arch rule
(`packages/config/arch/rules/single-writer-per-table.rule.ts`) requires EVERY table in
`packages/db/src/schema/index.ts` to declare an owning slice in its `TABLE_OWNER` map. The
new table went red the moment Task 02 landed it, and NO task in this plan owned
`packages/config/arch/**` — a decomposition gap, not an implementer error. `arch:check`
gates CI (lint stage), so this must ship with the run. Ownership is unambiguous: the
notifications slice is the sole writer (already verified — the slice writes only
`notification_preferences` and `device_tokens`).

**Acceptance criteria:**
- `notificationPreferences` mapped to the notifications slice in the registry, following
  the file's existing entry style exactly.
- `pnpm arch:check` exits 0 (this is the whole point — run it).
- No other rule, table entry, or unrelated line touched; no weakening of the rule itself
  (do NOT add an exemption/skip — register the owner).
- If any OTHER table is also unregistered, report it rather than fixing it (it would
  belong to another workstream).

**Files:** `packages/config/arch/rules/single-writer-per-table.rule.ts` (registry entry)
and its colocated `single-writer-per-table.rule.test.ts` (the test hardcodes a
`TABLE_NAMES` mirror of the registry keys — a new registry key without the matching
`TABLE_NAMES` entry makes every default-barrel test fail with a stale-key violation).
**Scoped checks:** `pnpm arch:check`; **`pnpm test:config`** (mandatory — the scoped-check
table requires it for `packages/config/**`; omitting it is what let the test regression
through); `turbo typecheck lint --filter=@hushbox/config`.
**Sensitive:** no → 1 auditor.

## Task 15 — Env-schema test fixtures (run regression)

**Objective:** update `packages/shared/src/env.config.test.ts`'s `backendEnvSchema`
fixtures so they satisfy the schema this run changed; `pnpm test:shared` green.

**Design context (regression caused by THIS run, confirmed by the orchestrator):** Task 04
added `NOTIFICATION_TAG_SECRET` as a REQUIRED backend var (`z.string().min(1)`,
non-optional — deliberately, since the collapse alias is stamped even on the dev mock).
The four `backendEnvSchema` fixture tests build env objects that omit it, so
`.safeParse().success` is now false: "validates correct development environment",
"validates correct production environment", "accepts R2 media storage vars when
provided", "allows CI/prod secrets to be optional". The required-ness is CORRECT — fix
the fixtures, never relax the schema.

**Acceptance criteria:**
- All four tests pass by adding the missing var(s) to the fixtures; `pnpm test:shared`
  fully green.
- The schema is NOT weakened (no `.optional()`, no default added to
  `NOTIFICATION_TAG_SECRET`); verify the VAPID trio's optionality is unchanged too.
- If any OTHER var this run added is also missing from a fixture, fix that too and say so.
- No other test or file touched.

**Files:** `packages/shared/src/env.config.test.ts`.
**Scoped checks:** `pnpm test:shared`, `turbo typecheck lint --filter=@hushbox/shared`.
**Sensitive:** no → 1 auditor.

## Task 16 — Read-cursor client write + sound toggle

**Objective:** (a) advance the read cursor from the client so dismiss-on-read-elsewhere
actually works; (b) expose the sound setting in the Notifications settings card.

**Design context (plan gaps found by Task 09):** (a) Task 05 shipped
`PATCH /conversations/:id/read` (monotonic `GREATEST`) and Task 09 shipped foreground
clearing that reads `lastReadSeq` — but NO task owned the client write, so the cursor
never advances and the founder-kept dismiss-on-read-elsewhere behavior is inert
end-to-end. Call the route when the user views/reads a conversation (the natural seam is
where the conversation view marks messages seen); the write is naturally idempotent, so
retry/duplicate calls are safe, but do not spam it per-frame — send on view and on
meaningful advance. (b) Task 09's store persists `soundEnabled` and unlocks audio inside
`setSoundEnabled(true)` (that interaction is the autoplay-unlocking gesture), but nothing
toggles it, so sound is permanently off. Add the toggle to Task 10's
`notifications-card.tsx` (Task 10 must be CLEAN before this task starts) — opt-in,
default off, labelled, keyboard operable, never the sole signal.

**Acceptance criteria:**
- Viewing a conversation advances `lastReadSeq` via the typed client; tested (including
  that it does not fire redundantly on every frame/render).
- Foreground read-elsewhere clearing now has live data — demonstrate the cursor advances
  in a test rather than asserting the route in isolation.
- Sound toggle renders in the Notifications card, round-trips, and enabling it unlocks
  audio via the store's existing path (do not duplicate that logic — G3).
- Accessibility per G8; G11 no plan/task-ID labels; owned-file coverage ≥95%.

**Files:** the conversation-view/read seam in `apps/web/src/**`,
`apps/web/src/components/settings/notifications-card.tsx` (after Task 10 is clean), and
the relevant hook files.
**Scoped checks:** `pnpm test:web`, `turbo typecheck lint --filter=@hushbox/web`.
**Sensitive:** no → 1 auditor.

## Task 12 — Maestro notification flows

**Objective:** Rewrite `mobile-tests/flows/07-push-notification-prompt.yaml` for the new
one-time prompt (it currently pins the ask-on-mount behavior Task 08 removes — it WILL
fail otherwise), and add an Enable→OS-permission-dialog→grant flow.

**Design context:** The Android Maestro harness (`scripts/mobile-test.ts`, dockerized
emulators, CI-integrated) is the only automated native surface. Flow 07 launches with
`notifications: unset` and asserts the system dialog appears at launch — after Task 08
the correct assertion is the inverse: NO system dialog at launch, the in-app callout
visible, and tapping Enable raises the system dialog. Optional stretch (spike, not a
commitment): simulate an incoming FCM message on the debug build via
`adb shell am broadcast` (c2dm RECEIVE action) and assert the notification renders in
the shade — if the spike fails or proves flaky, report the finding and stop; real FCM
delivery is out of CI by design (non-hermetic). iOS delivery has no automated path
(Android-only harness) — founder-owned manual checklist via Task 11's report.

**Acceptance criteria:**
- Flow 07 rewritten: launch with `notifications: unset` → no OS dialog at launch → in-app
  callout visible → Later dismisses and it stays gone across an app relaunch.
- New flow: Enable tap → OS permission dialog appears → grant → callout resolves;
  registered in the shard config if flows are sharded.
- Flows pass locally via the harness smoke path if the environment permits
  (`scripts/mobile-test.ts --smoke`); if the local environment cannot run emulators,
  the report states exactly what was verified (YAML validity, selector existence
  against the built app) and what remains CI-verified.
- Spike outcome (broadcast-simulated delivery) reported either way; only landed if
  reliable at retries=0.

**Files:** `mobile-tests/flows/**`, `mobile-tests/config.ts` (shards, if needed).
**Scoped checks:** `pnpm typecheck` on any TS touched; flow YAML validated by the
harness; no package-scoped test suite applies.
**Sensitive:** no → 1 auditor.

## Task 13 — Playwright notifications spec

**Objective:** New `e2e/notifications/` spec covering the prompt, the settings card, and
real SW push delivery via CDP injection.

**Design context:** Chromium CDP `ServiceWorker.deliverPushMessage` injects a push into
a registered SW as if the push service delivered it — this exercises our real SW
(showNotification, tag, click→deep-link) hermetically. SPIKE FIRST: prove the CDP call
works in this harness (Playwright CDP session against the app's SW registration); if it
does not, the delivery portion is descoped to the SW integration tests (Task 07) and the
report says so — do not fake it with page-side shims. The server→push-service→browser
hop stays out of CI by design (non-hermetic; covered by RFC vectors + sender integration
tests). Permission via `context.grantPermissions(['notifications'])`. Read
`e2e/CLAUDE.md` before writing anything; extend existing suites where they already cover
settings; retries=0 discipline per repo doctrine.

**Acceptance criteria:**
- Prompt: appears once for an eligible fresh session; Enable → permission granted →
  subscription registered (assert via API/dev surface); Later → never re-shows across
  reload; suppressed when permission already granted.
- Settings: card round-trips prefs (toggles, quiet hours incl. validation); global-off
  suppresses the prompt.
- Delivery (if spike passes): CDP-injected push → notification exists with generic
  per-category text and `tag` = the raw `conversationId` (CORRECTED: the DEVICE-LOCAL tag
  is the conversationId per the amended I4 — Task 09's clearing depends on it and it is
  never a push-service-visible header; the derived alias exists only in the server's
  Topic/collapse_key). Also assert no VISIBLE text contains the conversation id.
- Suite green at retries=0; runtime within the shared suite budget.

**Files:** `e2e/notifications/**` (new), `e2e/fixtures.ts` only if a fixture is
genuinely needed.
**Scoped checks:** `pnpm e2e:<suite>` for the new suite; `turbo typecheck lint` for e2e
config scope.
**Sensitive:** no → 1 auditor.

---

## Related E2E (declared)

- Task 13 (above) is the new web spec: prompt + settings + CDP-injected SW delivery.
- Task 12 (above) is the native counterpart: Maestro flow 07 rewrite + enable/grant flow
  (+ delivery spike).
- Existing chat/streaming E2E suites must stay green (pipeline refactor touches the
  message push path).
- Real push-service delivery (server → Google/Mozilla/Apple → device) is deliberately
  untested in CI (non-hermetic); iOS device delivery is a founder-owned manual step
  documented in Task 11's report.

## Phase-4 additions

- Full unscoped pass per skill (typecheck, lint, test:api/web/shared/db/realtime,
  duplication, knip).
- Completeness critic close-out.
- Doc-proposal review: besides Task 00's doc, expect ARCHITECTURE.md §slices line for
  notifications ("email, push, device tokens" → mention web push + preferences) and
  TECH-STACK if the plugin belongs in the Mobile table — PROPOSALS ONLY, founder
  approves each.

## Task 17 — Move the enable prompt into the sidebar (founder-reported)

**Objective:** the one-time notification offer currently renders inside `<main>` above the
route content; it belongs in the LEFT SIDEBAR, directly below the conversation list and
above the account footer, restyled for a narrow column.

**Design context:** Task 08 shipped the prompt mounted at `app-shell.tsx:44` (a row above
`{children}`), laid out horizontally (text left, buttons right) because it sat in a wide
container. The founder expected it in the sidebar. The horizontal layout cannot survive a
~260px column, so the presentation is rewritten; the STATE MACHINE IS CORRECT and stays.

**Acceptance criteria:**
- The prompt renders in the sidebar body AFTER the conversation list and BEFORE
  `footer={<SidebarFooter />}` (`sidebar.tsx:145`); it no longer renders in `<main>` and
  the `app-shell.tsx` mount + its comment are removed.
- Vertical card layout suited to the sidebar width. Copy exactly:
  heading "Turn on notifications"; body "Know when a reply lands or a run finishes, even
  when HushBox is closed. Never includes message content. Change this any time in
  Settings."; buttons "Enable" (primary) and "Later" (ghost).
- Button names stay **Enable** / **Later** and the string "Turn on notifications" is
  retained — the Playwright spec selects the region by its two button names and the
  Maestro flow matches the visible text; renaming either breaks both suites.
- Collapsed (rail) sidebar: render a COMPACT AFFORDANCE, not nothing (founder ruling
  2026-07-25, superseding the original "hide in rail" criterion — the desktop sidebar
  defaults to collapsed at `stores/ui.ts:15`, so hiding meant a first-time desktop user
  never saw the offer). In rail mode: an aria-labelled bell button with a subtle dot;
  clicking it EXPANDS the sidebar and reveals the full card. Never cram the card text
  into 48px. Mobile drawer: renders normally inside the drawer.
- E2E fallout of the move is IN SCOPE for this task: the Playwright notification tests
  that assert the offer on a fresh context must expand the sidebar first, and both
  Maestro flows must open the drawer before asserting the offer text.
- `role="status"`, never steals focus, both answers are real buttons, keyboard reachable
  (G8) — all preserved.
- `useEnablePrompt` and `prompt-dismissal.ts` are UNTOUCHED (audited correct).
- Placement tests updated; the a11y and suppressor tests carry over green.

**Files:** `apps/web/src/components/notifications/enable-prompt.{tsx,test.tsx}`,
`apps/web/src/components/shared/app-shell.tsx` (remove mount),
`apps/web/src/components/sidebar/sidebar.tsx` (add mount), and the app-shell test.
**Scoped checks:** `pnpm test:web`; `npx turbo lint typecheck --filter=@hushbox/web --force`.
**Sensitive:** no → 1 auditor.

## Proof-hardening tasks (18–21) — raise external-boundary coverage

Context: an honest proof audit rated the server decision logic and the web delivery
surface as prod-equivalent, but found the two EXTERNAL boundaries unproven — no test in
this repo has ever made a real call to FCM or to any push service. Research on 2026-07-26
(seven parallel researchers + one empirical analyst) answered every unknown these tasks
carried; the spikes originally planned inside Tasks 18 and 20 are DELETED as answered,
and Task 21 is killed as scoped. Tasks 18–20 are independent and run in parallel.

### FOUNDER RULINGS 2026-07-26 (binding)

- **R-A — Resend's false evidence row is fixed by DELETION, not by a real call.** New Task 22.
- **R-B — Task 18 lands without a local real-call verification.** No agent may hold the
  credential; the real call first executes in the founder's CI. The audit CANNOT verify the
  real call and must not treat that as a failure — see Task 18's audit note.
- **R-C — Task 21 stays killed.** Firefox + autopush is declined; Task 19 is the proof.
- **R-D — the CI FCM service account uses a CUSTOM IAM role holding exactly
  `cloudmessaging.messages.create`**, not the predefined `roles/firebasecloudmessaging.admin`.

### Research findings binding on all four tasks (authoritative — do not re-derive)

**F1 — Evidence rows must prove a real call, and two of ours do not.** `service_evidence`
is a Postgres table; `recordServiceEvidence(db, isCI, service)` no-ops unless `isCI`;
`pnpm verify:evidence --require=<svc>` exits 1 and hard-fails the CI job on a missing row
(`scripts/verify-evidence.ts:86-91`). Honest writers record only after a real call
succeeded: Helcim after an approved sandbox charge (`payment-helcim.ts:159-164`), Linear
after a real GraphQL call (`linear-real.integration.test.ts:134-137`), R2 after a real S3
PUT (`storage-r2.ts:207-209`). `push-fcm` does NOT: `push-fcm.integration.test.ts:82-103`
lands the row with `fetchImpl` mocked, and `ci.yml:222-224` admits it in a comment. The
FOUNDER RULE for this work is: **an evidence row is written only when a real network call
to the real external service actually happened.**

**F2 — FCM credentials must follow the Linear pattern, not the env registry.** Declaring
a `secret()` for `Mode.CiVitest` makes `generate-env.ts:246-248` throw
`Missing required secrets in process.env` and hard-fails CI the moment the code lands.
Linear avoids this: the secret is a raw job env var (`ci.yml:142`) read directly via
`process.env['LINEAR_API_KEY_READ']` (`linear-real.integration.test.ts:37-39`) behind
`describe.skipIf(!shouldRun)`, with `verify:evidence` as the real guard
(`linear-real.integration.test.ts:23-24`). Gating derives from ONE `createEnvUtilities()`
call plus explicit key/db-presence terms — never raw `process.env['CI']` sniffing, and
never key-presence alone. Fork PRs already cannot run CI at all (OPENROUTER's ciVitest
`secret()` already fail-fasts), so forks impose no new constraint.

**F3 — FCM `validate_only` semantics are settled; NO SPIKE IS NEEDED.** It is a
top-level snake_case sibling of `message` in the POST body to
`https://fcm.googleapis.com/v1/projects/{projectId}/messages:send` (Google REST
reference). The documented ErrorCode taxonomy separates the token cases: fabricated →
400 `INVALID_ARGUMENT`; real-but-other-project → 403 `SENDER_ID_MISMATCH`; real-but-lapsed
→ 404 `UNREGISTERED`; each carries `details[].@type` of
`type.googleapis.com/google.firebase.fcm.v1.FcmError` (or `google.rpc.BadRequest`).
UNVERIFIED and therefore NEVER to be asserted: the exact success placeholder (community
reports `projects/{id}/messages/fake_message_id`; absent from Google's docs) and any one
specific status for a fabricated token. Google's throttling page never mentions
`validate_only` (zero matches) — assume it debits normal send quota. Scope required:
`https://www.googleapis.com/auth/firebase.messaging`.

**F4 — CDP `ServiceWorker.deliverPushMessage` bypasses RFC 8291 entirely.** Its `data`
parameter is a plain string with no `p256dh`, no `auth`, no VAPID input; it injects
plaintext after the point where decryption would occur. Our existing notifications E2E
therefore proves the service worker's handling logic and NOTHING about our encryption —
which is exactly the gap Task 19 closes.

**F5 — Task 13's focus finding does NOT transfer to the page's own attention state.**
`push-harness.ts:238-240` concluded focus emulation is unusable — but that is about the
service worker's `clients.matchAll({focused:true})`, a browser-process-wide view outside
the CDP target. The page's own `document.hasFocus()` is inside it and IS deterministically
controllable. Measured on this machine, Playwright 1.60.0 / chromium-1223:
- second tab + `bringToFront()`: **0/26 away** across same-context, cross-context, both
  headless modes, with and without focus emulation — the state is UNREACHABLE, and it
  fails silently (count stays 0), so this approach is a defect, not a risk.
- `Emulation.setPageVisibilityOverride`: command does not exist in modern Chrome.
  `Page.setWebLifecycleState('frozen')`: accepted, zero effect. `page.emulateMedia`:
  cannot touch visibility.
- `Emulation.setFocusEmulationEnabled({enabled:false})` **+**
  `Browser.setWindowBounds({windowId, bounds:{windowState:'minimized'}})` — BOTH required,
  neither works alone (0/6 each): **6/6 away, 7/7 at CI's exact worker count of 7, 0 extra
  polls, real `blur` event, real `focus` event on restore 7/7.** `visibilityState` stays
  `"visible"`; timers keep full rate; title writes still land. Fails under `--headed`
  (0/4 under bare Xvfb) — acceptable, since CI and every `e2e:*` script are headless.
- `navigator.setAppBadge` IS callable and RESOLVES in a plain headless tab on
  `http://localhost` (secure context), so `app-badge.ts:11`'s guard passes and the real
  API really runs. There is **no `getAppBadge`** — a wrap-and-delegate spy is the only
  possible observation, and that unavoidable leaf spy is honest.

**F6 — real Web Push against Chrome is not achievable, on three independent grounds.**
(a) A genuine `pushManager.subscribe()` needs headed Chromium + `launchPersistentContext`;
our auth is entirely `storageState` (`playwright.config.ts:212`, `fixtures.ts:36-39`), and
Push in incognito is unsupported by design (open Chromium feature request). (b)
`--host-resolver-rules` can redirect only `fcm.googleapis.com`, the SEND-side endpoint;
browser delivery rides a separate persistent MCS connection to `mtalk.google.com:5228`
speaking a proprietary protocol — no evidence anyone has made this work. (c) The only tool
that ever did this, `GoogleChromeLabs/web-push-testing-service`, was archived 2021-08-31.
The one evidenced real path is **Firefox + Mozilla autopush** (`dom.push.serverURL` +
`dom.push.testing.allowInsecureServerURL`, Playwright `firefoxUserPrefs`, `autopush-rs`
containerized) — which requires a new docker-compose service and is an INFRASTRUCTURE
decision reserved to the founder.

## Task 18 — Prove the FCM send path against Google, and make its evidence row honest

**Objective:** make one real, authenticated call to FCM HTTP v1 in CI, and ensure the
`push-fcm` evidence row is written only when that real call happened.

**Design context:** two defects are being fixed at once, and they are inseparable —
fixing the call without fixing the evidence row would leave a mocked row satisfying
`ci.yml:227-228`. Per F3 no spike is needed; per F2 the credential rides the Linear
pattern; per F1 the row must follow a real call. The strongest part of this proof is the
OAuth leg: a real POST to `https://oauth2.googleapis.com/token` with an RS256-signed
service-account JWT proves `packages/crypto/src/rs256-jwt.ts` produces a signature Google
itself accepts against a real RSA key — nothing verifies that today.

**Acceptance criteria:**
- `push-fcm.ts` supports a validate-only send. Production sends are byte-identical to
  today: when the flag is off, the request body must contain no `validate_only` key at
  all. Pin that with a unit test asserting the key's absence in the default body.
- One CI-gated integration test makes the real two-leg call (OAuth exchange, then
  `messages:send` with `validate_only: true` and a fabricated token) and asserts:
  (a) the OAuth exchange returned an access token — a failure here fails the test;
  (b) the send returned a parsed FCM response: EITHER 200 with a `name` string, OR an
  error whose `details[]` carries `@type` ending in `google.firebase.fcm.v1.FcmError` or
  `google.rpc.BadRequest`. A `401` fails the test.
  Do NOT assert a specific HTTP status, a specific errorCode, or the success placeholder
  string (F3 — those are unverified and Google may change them).
- The test also asserts our OWN classifier against Google's real error body: feed the
  actual response body to `collectFcmErrorCodes` and assert it returns the codes present.
  This is the part that replaces mock-shaped error handling with reality.
- Gating follows `deriveLinearGate` exactly: one `createEnvUtilities()` call, `isCI &&
  !isE2E && hasCredentials`, expressed as a named pure function with its own unit test,
  behind `describe.skipIf`. Credentials read from `process.env` directly. NO new
  `env.config.ts` entry, and no `secret()` for any CI mode (F2).
- `recordServiceEvidence(..., SERVICE_NAMES.PUSH_FCM)` is called as the LAST statement of
  that test, only after every assertion passed — mirroring
  `gateway-metadata.integration.test.ts:75`.
- The pre-existing mocked evidence write is GONE: delete the row-fabricating test at
  `push-fcm.integration.test.ts:82-103`, and remove the evidence write from `push-fcm.ts`
  itself (the adapter's real path never runs in CI — the factory returns mocks for
  `isLocalDev || isCI` — so its only consumer was that mocked test). Removing the seam is
  what makes the rule structural rather than a convention. Drop the now-unused `db`/`isCI`
  config fields if nothing else uses them; if the factory passes them, update it.
- `ci.yml` passes the two credentials as raw job env vars on the `test` job, alongside
  `LINEAR_API_KEY_READ`. The existing `--require=push-fcm` step is UNCHANGED — it now
  guards a real call instead of a mock.
- The misleading comment at `ci.yml:222-224` is corrected: it currently claims FCM's
  evidence is a mocked-seam code-path assertion. After this task that is true only of
  Resend. Narrow it, do not delete it.
- Not on the hot test path: `*.integration.test.ts`, skipped locally.

**Founder-provisioned credential (R-D):** a service account whose ONLY permission is
`cloudmessaging.messages.create`, via a custom IAM role — not
`roles/firebasecloudmessaging.admin`. Exposed to CI as two GitHub secrets named
`FCM_PROJECT_ID_CI` and `FCM_SERVICE_ACCOUNT_JSON_CI` — distinct from the production
`FCM_PROJECT_ID`/`FCM_SERVICE_ACCOUNT_JSON` so a production credential can never be the
thing CI reads. The test reads both from `process.env` directly (F2).

**AUDIT NOTE (R-B) — what the auditor CAN and CANNOT verify.** The credential does not
exist in any agent's environment, so the real two-leg call CANNOT be executed during
implementation or audit, and its absence is NOT a finding. What the auditor MUST verify:
the gate function's unit test; that the suite skips (not fails) with no credential; that
the default request body contains no `validate_only` key; that the classifier assertion
consumes a real response body rather than a fixture the test itself authored; that the
evidence write is the last statement after all assertions; that the mocked evidence write
and its test are gone; and that no `env.config.ts` `secret()` was added for a CI mode.
The real call is proven by the founder's next CI run, not by this audit.

**CAVEATS (state in the report):** proves OAuth/JWT signing, project id, scope, request
shape and error classification against Google — NOT delivery to a device. Requires a
founder-provisioned service account; without it the test skips and
`verify:evidence --require=push-fcm` fails loudly, which is the intended guard.

**Files:** `apps/api/src/slices/notifications/adapters/push-fcm.ts`, its unit test, a new
`push-fcm-live.integration.test.ts`, deletion of the mocked evidence test in
`push-fcm.integration.test.ts`, `push-sender-factory.ts` if the config shape changes,
`.github/workflows/ci.yml`.
**Scoped checks:** `pnpm test:api`; `turbo lint typecheck --filter=@hushbox/api --force`.
**Sensitive:** no → 1 auditor, but see the coordination note: this task edits CI.

## Task 19 — Prove our Web Push ciphertext is decryptable by something that is not us

**Objective:** close the gap where our aes128gcm output matches one RFC vector but no
independent implementation has ever decrypted arbitrary output of ours.

**Design context:** `encrypt.test.ts:39` pins the full body (header ‖ ciphertext) byte-exact
to RFC 8291 Appendix A. That proves we reproduce ONE fixed case with a caller-supplied
salt and ephemeral key. It does not prove a real receiver can decrypt output generated
from random keys — and per F4 our E2E push path cannot prove it either, because CDP
injects plaintext. The deterministic seam already exists and needs no production change:
`encryptWebPushPayload` takes `salt` and `ephemeral` as plain parameters
(`encrypt.ts:58-69`); production randomness lives one layer up in `send.ts:70-72`.

**The decryptor must have its own external anchor.** Written from RFC 8291/8188 text, NOT
by mirroring our encrypt code — and verified against the RFC vector in the DECRYPT
direction BEFORE it is trusted as an oracle. A decryptor derived from the same reasoning
as the encryptor would share its bugs and prove nothing. Concretely it must independently
parse the aes128gcm header (salt(16) ‖ rs(4, big-endian) ‖ idlen(1) ‖ keyid), redo the ECDH,
rebuild the `WebPush: info` IKM and both `Content-Encoding: aes128gcm` / `nonce` HKDF
derivations, AES-GCM-decrypt, and strip the 0x02 delimiter — reading the RFC, not
`encrypt.ts`.

**Acceptance criteria:**
- The decryptor is verified against RFC 8291 Appendix A in the decrypt direction first
  (vector body in → vector plaintext out), then used as the oracle.
- Round-trip proven over freshly generated P-256 subscription keypairs, random auth
  secrets and random salts — several independent iterations, not one — so it covers
  arbitrary output rather than one fixed case.
- At least one negative control: a deliberately corrupted body (flipped ciphertext byte,
  or a mismatched auth secret) must FAIL to decrypt. A round-trip test with no negative
  control cannot distinguish a working oracle from one that returns the input.
- Test-only; no production code changes; no new dependency (WebCrypto only, as
  `encrypt.ts` already uses).
- Any new fixed test secret is added to `.gitleaks.toml` as an AND-pinned path+value
  allowlist entry matching the four existing webpush entries. Run gitleaks on the new
  files before declaring done — a prior task in this run shipped a gitleaks failure by
  scanning only config and not its own tests.

**CAVEATS (state in the report):** proves the CRYPTO and wire format only — NOT that a
push service accepts our HTTP request (headers, TTL, Topic, VAPID audience). Say so plainly.

**Files:** `apps/api/src/slices/notifications/adapters/webpush/**` (a test-only decryptor
helper + its test), `.gitleaks.toml` if a new fixed secret is introduced.
**Scoped checks:** `pnpm test:api`; `turbo lint typecheck --filter=@hushbox/api --force`;
gitleaks over the changed paths.
**Sensitive:** YES (crypto) → 2 auditors.

## Task 20 — Prove the unread title and app badge in a real browser, on the real journey

**Objective:** prove end-to-end, in a real browser, that a real message from another user
arriving while the user is genuinely not focused raises the tab title to `(1) HushBox`,
drives `navigator.setAppBadge(1)`, and that returning to the app clears both.

**Design context:** this supersedes the earlier, weaker scoping of this task, which
assumed (from Task 13) that a real unfocused state was unreachable. F5 disproves that:
Task 13's finding is about the service worker's view, not the page's own. The lever is
deterministic — 7/7 at CI's worker count with zero added polls — so the real journey is
available at no flake cost, and every unit in the chain is already unit-covered
(`use-activity-sinks.test.ts`, `app-badge.test.ts`, `app-attention.test.ts`,
`use-conversation-activity.test.ts`). The ONLY marginal proof an E2E can add is the seam,
so the test must keep that seam real end to end.

**Three constraints that are load-bearing — do not deviate:**
- The **group conversation fixture is mandatory**, not a convenience: `use-group-chat.ts:75,86`
  opens a socket only when `members > 1`, so a 1:1 conversation emits no `message:new` at all.
- **Bob turns AI off before sending** (the `getAiToggleButton()` pattern already in
  `realtime.spec.ts`). With AI on, the assistant reply is a second countable event and
  `(n)` becomes racy. This is for determinism, not speed.
- **Both CDP calls are required** — `Emulation.setFocusEmulationEnabled({enabled:false})`
  AND `Browser.setWindowBounds({windowState:'minimized'})`. Each alone measured 0/6.

**Acceptance criteria:**
- Extends `e2e/group/realtime.spec.ts` (Pillar 4.1 — the fixtures and WS-ready helpers are
  already there); tagged `@chromium-only`, since `newCDPSession` is Chromium-only.
- The badge spy is installed via `context.addInitScript` BEFORE any navigation and is
  **wrap-and-delegate**, not replace: `'setAppBadge' in navigator` must stay true and the
  real API must still be invoked. Record both `setAppBadge` arguments and `clearAppBadge`
  calls.
- The test asserts its own precondition after going away —
  `expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false)` — so a lever
  regression or a `--headed` run fails loudly and self-explainingly instead of producing a
  mystery assertion failure. Measured to need zero extra polls, so it costs nothing.
- Title asserted with the web-first retrying `expect(page).toHaveTitle('(1) HushBox')`
  (rule 2.8), never a bare `page.title()` read. Base title is `HushBox`
  (`apps/web/index.html:154`); format from `use-activity-sinks.ts:28-31`.
- Restoring the window (`windowState:'normal'`) fires a real `focus` event; assert the
  title returns to bare `HushBox` and that the spy recorded `clearAppBadge` — covering
  `use-activity-reset.ts:9-23` and `app-badge.ts:12`'s zero-routes-through-clear rule in
  the same journey.
- Both raw CDP mechanisms live in ONE named helper pair in `e2e/helpers/` (rule 3.3 — raw
  mechanisms live in helpers, never specs). Name them so they cannot be confused with
  `push-harness.ts`'s existing `leaveApp`/`returnToApp`, which mean "navigate to
  about:blank" — these are genuinely different states (no window at all vs. window present
  but unfocused) and both are needed.
- The doc comment at `push-harness.ts:229-243` is NARROWED, not deleted: it currently
  asserts focus emulation is unusable, which as written would mislead the next agent into
  rejecting this approach. It must say it is unusable *for the service worker's view*.
- Green at `--retries=0`. No `waitForTimeout`, no sleeps.
- Test-only; no production code changes.

**CAVEATS (state in the report):** the badge is observed through a wrap-and-delegate spy
because no `getAppBadge` exists — the call is real, the observation is a spy. The lever is
Chromium-only and uses a Playwright-unsupported CDP surface; it does not work `--headed`.

**Files:** `e2e/group/realtime.spec.ts`, a new helper in `e2e/helpers/`,
`e2e/notifications/push-harness.ts` (comment narrowing only).
**Scoped checks:** `turbo lint typecheck --filter=@hushbox/e2e --force`; the touched suite
green at `--retries=0`.
**Sensitive:** no → 1 auditor.

## Task 21 — KILLED AS SCOPED (real push service against Chrome)

**Status: killed before dispatch, on evidence (F6), and CONFIRMED KILLED by founder ruling
R-C 2026-07-26. Not a deferral — a negative result.**

The original spike proposed redirecting Chrome's push endpoint to a local server. That is
not achievable, on three independent grounds recorded in F6: `pushManager.subscribe()`
requires headed Chromium + `launchPersistentContext` which our `storageState` auth cannot
survive; `--host-resolver-rules` reaches only the send-side `fcm.googleapis.com` and not
the `mtalk.google.com:5228` MCS delivery channel; and the only tool that ever did this was
archived in 2021. Running the spike would have consumed a task to reach this same answer.

**Re-entry condition (founder decision, NOT an agent decision):** the one evidenced path
to genuine end-to-end Web Push — our server encrypts → a real push service delivers → a
real browser service worker decrypts — is **Firefox + Mozilla autopush**, via
`firefoxUserPrefs` (`dom.push.serverURL`, `dom.push.testing.allowInsecureServerURL`) and a
containerized `autopush-rs`. It would subsume Task 19's proof rather than sit beside it.
It requires adding a service to `docker-compose.yml` (autopush-rs wants a Bigtable
emulator, ~1.5GB) and lifting the notifications suite out of `@chromium-only`. Per
AGENT-RULES that is new infrastructure and a tech-stack change — reserved to the founder.


## Task 22 — Delete Resend's false evidence claim (depends on Task 18)

**Objective:** stop claiming CI verified a Resend call, since it structurally cannot.

**Design context (founder ruling R-A):** the `resend` evidence row can never be earned.
Two conditions must both hold — a real call, and `isCI` — and `email-sender-factory.ts:64-84`
makes them mutually exclusive: `isLocalDev || isCI` returns `withMailboxCapture(createMockEmailSender())`,
so the real adapter is constructed only in production, where `recordServiceEvidence` no-ops
on `!isCI`. `RESEND_API_KEY` has no entry outside production (`env.config.ts:331-335`). The
only writer is `email-resend.integration.test.ts`, whose every test stubs `fetchImpl`
(`:27-29`). The founder ruled deletion over building a real Resend call: no claim beats a
false one. Note this does NOT reduce real coverage — E2E still exercises email end to end
through `/dev/mailbox` (`dev/routes.ts:723,731`) backed by `withMailboxCapture`; only the
false *claim* goes away.

**DEPENDS ON TASK 18** — solely because both edit `.github/workflows/ci.yml`. Do not run
them concurrently. Task 18 rewrites the FCM half of the `ci.yml:222-224` comment; Task 22
removes the Resend half and the step.

**Acceptance criteria:**
- The `Verify Resend was called` step and its `pnpm verify:evidence --require=resend` line
  are removed from `ci.yml`. The comment above it no longer mentions Resend; after Task 18
  the FCM claim is real, so what remains must describe only that.
- The evidence write is removed from `email-resend.ts` — the `recordEvidence` helper and
  both call sites in `send()`/`sendBatch()`. Removing the seam is what makes the deletion
  structural rather than a convention.
- The two evidence-asserting tests in `email-resend.integration.test.ts` are deleted. Every
  other test in that file must still pass untouched — the file also covers request shape and
  error handling, which stay.
- `SERVICE_NAMES.RESEND` is removed from `packages/db/src/evidence.ts` and from the
  assertion at `evidence.integration.test.ts:49`. A registry entry no writer can satisfy is
  dead weight, and `verify-evidence.ts`'s `VALID_SERVICES` derives from this object, so
  leaving it would keep `--require=resend` a legal argument that can never pass.
- Orphans YOUR change creates are removed: if `db`/`isCI` become unused on
  `ResendEmailSenderConfig`, drop them and update `email-sender-factory.ts:75-77`. If that
  makes `db` unused in `createEmailSenderFromEnv`'s signature, REPORT the ripple rather than
  forcing it through — that touches the composition root and is a judgment call for the
  orchestrator.
- `pnpm lint:unused` (knip) must be clean for the touched files — this task deletes
  exports, which is exactly what knip catches.

**CAVEATS (state in the report):** after this, no CI signal asserts anything about Resend
beyond the mock-backed E2E newsletter flow. That is the intended, honest state. Re-entry
condition, recorded for the future: Resend publishes test-mode addresses and restricted
send-only keys, so a real CI call is buildable later on Task 18's exact shape — that was
considered and declined, not overlooked.

**Files:** `.github/workflows/ci.yml`, `apps/api/src/slices/notifications/adapters/email-resend.ts`,
`email-resend.integration.test.ts`, `email-sender-factory.ts` (if the config shape changes),
`packages/db/src/evidence.ts`, `packages/db/src/evidence.integration.test.ts`.
**Scoped checks:** `pnpm test:api`; `pnpm test:db`; `turbo lint typecheck --filter=@hushbox/api --filter=@hushbox/db --force`; `pnpm lint:unused`.
**Sensitive:** no → 1 auditor.

## Standing amendments

- **FOUNDER RULING 2026-07-24 — I7's `push-event` postMessage is REMOVED (supersedes I7,
  Task 07's "push→postMessage when a focused client exists" criterion, and Task 09's
  "SW postMessage intake" criterion).** The SW's focused-client check now only SUPPRESSES
  `showNotification`; it posts nothing, and there is no page-side intake. Rationale at the
  time: the SW posted only to focused clients while the badge counted only while away, so
  the path could never execute. `handlers.test.ts`'s "hands a focused client nothing" is
  therefore CORRECT, not an inverted criterion. (Orchestrator bookkeeping failure: this was
  recorded in the ledger and docs/NOTIFICATIONS.md but not here, so the Phase-4 pass
  correctly flagged it against the plan as written.) NOTE: a Phase-4 finding shows the
  ruling's stated premise — "they'll see it in the conversation list" — is FALSE (the list
  is not refreshed while the tab is visible), and the suppression's blast radius includes
  ANY focused same-origin tab (e.g. /blog). Re-raised to the founder.

- **Known-external reds (other workstreams, NOT this run — attribute around, never
  "fix"):** (1) `@hushbox/web` lint fails on
  `apps/web/src/hooks/billing/use-prompt-budget.ts` (complexity 11>10) — a billing
  workstream file, outside every notifications task's ownership; our web files must lint
  clean on their own. (2) `packages/shared/src/index.ts` is concurrently edited by the
  estimate re-home workstream; notification barrel exports coexist there — sequence any
  shared-barrel edit to append, never rewrite the file, and expect churn around it.
- **Migration verification (from Task 02 audit):** every DB migration in this run must be
  proven on an INCREMENTAL apply with the real migrate binary, not only a fresh reset
  (Task 02 criteria updated). The fresh-reset path runs all migrations co-transactionally
  and masks Postgres enum-add-then-use hazards.
- **gitleaks scans ALL owned files (from Task 03 audit):** any task committing test
  fixtures or dev values with secret-shaped strings must run gitleaks over EVERY new/
  changed owned file (test files included, not just config), and add a narrow, path-AND-
  value-pinned `.gitleaks.toml` `[[rules.allowlists]]` entry (stream-handler/media-assets/
  seed-crypto precedent) — never a broad path exemption. gitleaks gates the whole CI DAG
  (`needs: [gitleaks]`), so a fire blocks everything.
- **Two `role="status"` regions now exist in the app shell** (Task 08's enable prompt and
  Task 09's activity announcer): Task 13 must select by ACCESSIBLE NAME, never by role
  alone.
- **Task 07's `pushsubscriptionchange` postMessage has no client listener** (Task 09's
  message handler validates and correctly ignores it). Accepted: the designed backstops
  — re-registration on next authenticated start and server-side 404/410 pruning — cover
  it. Do not add a second consumer path.
- **Client surface shipped by Task 08 — Tasks 09/10/13 MUST build on it, not beside it:**
  the `notificationChannel` facade has a FOURTH method beyond I6,
  `ensureRegistered()` (the three named methods cannot re-register without prompting,
  which the re-registration-on-authenticated-start criterion requires); it is
  deliberately skipped when `globalEnabled` is false so a global-off unregister is not
  undone by the next app start — preserve that. The prefs query lives in
  `apps/web/src/hooks/notifications/use-notification-preferences.ts`: **Task 10 extends
  that file, never adds a second prefs hook** (G3/One-Implementation). **Task 09 adds its
  notification-clearing functions to the facade**, not to a parallel module. No
  `TEST_IDS` entries exist for the prompt (literal `data-testid` is lint-banned and
  `packages/shared` was out of bounds): **Task 13** selects by `role="status"` and the
  button names "Enable"/"Later", or adds registry entries itself.
- **Store/port surface added by Task 04's fix — later tasks MUST match it:**
  `PushDelivery` gains an optional `deliveredTokens`; `DeviceTokenStore` gains a REQUIRED
  `touchLastSeen`. Any store stub, fake, or test double in a later task must implement
  `touchLastSeen` or it will not typecheck. Task 06's retention delete now sees refreshed
  `lastSeenAt` on actively-notified devices — that is what makes its "stale deleted, fresh
  kept" criterion true. `touchLastSeen` failure degrades the notify Result exactly like
  the dead-token prune does (orchestrator ruling: correct as-is — the Result is swallowed
  at the composition root, so G2 still holds; do not "fix" it to be silent).
- **Known stale comment to sweep in Phase 4:** `apps/api/src/slices/identity/ports/email.ts`
  references `PresenceReader`, which Task 04's fix deleted. One-word correction, outside
  every notifications task's ownership — batch it into the Phase-4 close fixer.
- **Lint must be verified with the PACKAGE-WIDE command (from Task 09 audit):** running
  `eslint <files>` from the wrong cwd silently no-ops under ESLint v9, so a scoped run can
  report exit 0 while the real gate is red. Every task MUST finish by running the same
  command CI runs — `turbo lint --filter=<package> --force` — and report ITS output.
  Prettier is an ESLint rule here, so unformatted code fails this gate too.
- **Never restate an acceptance criterion (from Task 04 correctness audit):** an
  implementer may not mark a criterion "met" by substituting a weaker one (Task 04
  reported `lastSeenAt` satisfied because `updatedAt` was bumped and the column had an
  insert default). If a criterion cannot be met, return DONE_WITH_CONCERNS or BLOCKED
  naming the exact unmet criterion — never a paraphrase that reads as satisfied.
  Auditors verify criteria literally.
- **Presence rides the caller's fire-time snapshot; there is no `PresenceReader` port**
  (Task 04 removed its last consumer and the orphan is deleted in its fix). Task 05 and
  any later event source pass `presentUserIds` on the `notifyEvent` input — do not
  reintroduce a presence port or query the DO from the slice.
- **Alias-stamping is composite-only (from Task 04 security audit):** the notifications
  barrel exports the raw `createWebPushSender`/`createFcmPushSender` factories (Task 06
  needs the sibling mock export). Only the COMPOSITE sender derives and stamps the G1
  collapse alias. Therefore: no production code may construct or call a raw transport
  sender directly — the factory/composite is the only construction site. Task 06 and any
  later task must route through the composite; auditors check this.
- **Ops note for founder (Phase 4 / secret-provisioning):** `VAPID_PUBLIC_KEY` and
  `VITE_VAPID_PUBLIC_KEY` are two distinct GitHub secret names that MUST hold the
  identical public key or web subscriptions break (inherent to the VITE_ split).
