# Server pipeline design — analyst decision material (2026-07-24)

Authoritative for implementation briefs. Founder rulings that constrain this: FCM stays the
single mobile gateway; all payloads generic (event type + conversationId deep link only);
in-house Web Push sender (no new dep); dismiss-on-read-elsewhere kept; prefs/mute/quiet
hours evaluated server-side.

## Grounding facts (Verified unless noted)

- Push today is best-effort, fired at the composition root via `createMessagePushNotify`
  (`apps/api/src/adapters/push-notify.ts:33-57`), from two call sites: chat's runless send
  via `waitUntil`, and the ConversationRoom DO's terminal sink, which passes a fire-time
  presence snapshot (`presentUserIds`) — no live DO round trip (`push-notify.ts:38`).
- The notifications slice never queries other slices or the DO directly; the composition
  root binds `PresenceReader`/`MembershipReader` ports.
- `sendPushForNewMessage` already does mute+presence filtering and dead-token pruning via
  `PushDelivery.deadTokens` (`slices/notifications/domain/notify-message.ts:37-95`).
- Mute is `conversation_members.muted` boolean, conversations-owned
  (`packages/db/src/schema/conversation-members.ts`; route `conversations/routes.ts:670`).
- `preferences` is an account-slice LWW jsonb blob for accessibility only
  (`packages/db/src/schema/preferences.ts:6-9`).
- No read-state exists anywhere (grep `lastReadAt|readCursor|markRead|seenAt`: zero product hits).
- Jobs: `enqueueWithinTx` in caller's transaction (`lib/jobs/enqueue.ts:25-71`).
- Doctrine: push is best-effort/degradable; cron hosts only pollers, retention deletes,
  read-only auditors — never delivery.
- Capacitor plugin exposes `getDeliveredNotifications` / `removeDeliveredNotifications` /
  per-notification `tag` (Verified in plugin type defs).

## 1. Event ingestion — RECOMMENDED: unified direct best-effort dispatch

One barrel entry point `notifyEvent({type, conversationId, actorUserId, presentUserIds?})`
generalizing `sendPushForNewMessage`; fired at composition-root call sites: DO terminal
sink (run-completion, new message during runs), chat route `waitUntil` (runless message),
conversations routes `waitUntil` (membership/fork/share). Presence rides the caller's
fire-time snapshot (DO events get real presence; route events pass what the broadcast path
already knows or none). The only job/cron in this workstream is the stale-token retention
delete (allowed: cron retention), never delivery.

REJECTED:
- Pattern-C job per notification event — category error (elevates degradable side effect
  into must-happen machinery), breaks presence semantics (dispatch-time ≠ event-time,
  and a live DO query violates the slice seam), couples billing-critical commit latency
  to a best-effort concern, per-message row cost.
- Hybrid (jobs for membership only) — two delivery mechanisms for one pipeline; premise
  false (membership row in PG is the recoverable truth).
- Live `PresenceReader` DO RPC — adds round trip, violates never-query-DO seam.

## 2. Decision layer — RECOMMENDED: pure domain fn + typed tables

Pure decision function in notifications domain extending `selectPushRecipients`: inputs =
members (with mute expiry), event category, per-user prefs rows, quiet-hours config,
presence snapshot, `now`; output = recipient list. Three batched queries per event:
members (existing), `notification_preferences WHERE user_id IN (...)`, tokens for
survivors (existing). No Redis caching initially (premature; keep store interface so it
can be added later).

Schemas (all require founder approval — schema changes are outside agent authority):
- NEW `notification_preferences`, notifications-slice-owned: one row per user, typed
  columns: per-category booleans (`messages`, `runCompletion`, `membership`),
  `globalEnabled`, `quietHoursStartMinutes`/`quietHoursEndMinutes` (nullable = off),
  `timezone` (IANA text). Written only by new notifications routes.
- `conversation_members.muted` boolean REPLACED by `mutedUntil timestamptz` (null =
  unmuted; `infinity`/far-future = forever; tiers = computed timestamps). Conversations
  slice keeps ownership; expiry is lazy (`muted = mutedUntil > now` at read via
  `MembershipReader`). No unmute job ever (same shape as day-keyed free allowance).
  Migration mapping for existing `muted=true` rows needs a founder ruling (→ forever?).
- `device_tokens` EXTENDED for web: platform enum gains `web`; `token` holds endpoint
  (already unique); nullable `p256dh`/`auth` columns + CHECK (`platform='web'` ⟺ keys
  present); add `lastSeenAt` (benefits FCM rows too — token accumulation is an existing
  gap). No separate `web_push_subscriptions` table (would duplicate the whole lifecycle).

REJECTED: prefs in account jsonb blob (client-LWW ≠ server-authoritative; fail-fast
violation); notifications-slice mutes table (splits one membership attribute across two
writers); Redis prefs cache now.

## 3. Dismissal sync — RECOMMENDED: collapse/tag + durable read cursor + lazy client clear

Platform reality: collapse/replace works everywhere (FCM `collapse_key`/notification
`tag`, Web Push `Topic` header — 32-char cap, VISIBLE to the push service ⇒ never a raw
conversationId; use a truncated-HMAC-derived alias. FCM already sees conversationId in the
data payload today — existing asymmetry to document). Remote clear is unreliable (iOS
silent push throttled ~2–4/hr, dead when force-quit); local clear is reliable
(`removeDeliveredNotifications({tag})` native; SW `getNotifications({tag})`+`close()` web —
Assumed standard, verify at impl).

Mechanism: server stamps every push with a per-conversation tag/collapse-key/Topic ⇒ at
most one pending notification per conversation. Durable `lastReadSeq` cursor on
`conversation_members`, conversations-owned, written monotonically
(`SET lastReadSeq = GREATEST(lastReadSeq, $n)` — naturally idempotent), fed by an explicit
client read signal (WS event via DO→conversations barrel, or plain PATCH route — either
fits; orchestrator to pin in plan). Client clears delivered notifications for a
conversation when it renders it, and on app foreground fetches read-state and clears tags
for conversations read elsewhere. Cross-device dismissal is eventual (next foreground) —
platform ceiling, documented.

REJECTED: server-pushed clear messages (mechanism cannot reach success on iOS by platform
design → would breed a banned backup mechanism; per-read push volume); collapse-only
without clearing (contradicts founder ruling).

## 4. Web Push sender seam — RECOMMENDED: one PushSender port, composite adapter

Widen `PushRecipient` to a discriminated union ({platform:'ios'|'android', token} |
{platform:'web', endpoint, p256dh, auth}); composition root binds a composite sender
partitioning recipients to the existing FCM adapter + new in-house
`slices/notifications/adapters/push-webpush.ts` (mock in dev/CI via
`push-sender-factory.ts` as today). Domain stays channel-blind; webpush adapter maps 404
AND 410 (both permanent per RFC 8030) into the existing `deadTokens` prune.

In-house sender: clean-room from RFC 8291/8188/8292 with Appendix-A test vectors via
injectable ephemeral key/salt; VAPID ES256 through already-present `jose ^6.2.3`. Never
vendor `web-push-neo` (MPL-2.0) — cross-check reference only. Lives in slice adapters
(narrowest scope; client needs no shared crypto — browser PushManager handles
subscription-side natively).

Keys: `VAPID_PRIVATE_KEY` (backend secret), public key to browser via `VITE_` registry
entry or config endpoint, `VAPID_SUBJECT` — all env.config registry entries, values for
every mode, committed throwaway keypair for dev/CI (sends go to mock), fail-fast at
factory construction.

Dev inbox: wrap the mock composite sender with a capture layer mirroring
`withMailboxCapture` + `/dev/push` routes (email mailbox pattern:
`platform/dev/routes.integration.test.ts:1297-1322`).

REJECTED: two ports (platform knowledge in domain, doubled surface); any third-party
webpush package (three of four are aesgcm-only → Apple 403s; the correct one is
v0.1/bus-factor-1/MPL).

## 5. Quiet hours — RECOMMENDED: IANA tz, server-evaluated; suppressed = dropped

Store IANA timezone string in `notification_preferences` (client-reported, refreshed
opportunistically on prefs save / app open); server evaluates "now inside [start,end)
local minutes" via `Intl.DateTimeFormat` with `timeZone` inside the pure decision fn
(injected `now` ⇒ trivially testable). VERIFY AT IMPL: workerd `Intl` honors arbitrary
IANA zones. Suppressed events are dropped (stated plainly in settings copy) — in-app
UI/WS/read-cursor is the truth; push is a nudge.

REJECTED: UTC offsets (silent DST breakage); client-computed windows (sync-contract
drift, banned); deferred delivery (durable pending store + cron/job delivery — banned
queue reintroduction); badge-only during quiet hours (silent-push unreliable on iOS,
no Android badge path).

## Load-bearing assumptions to verify at implementation

1. workerd `Intl.DateTimeFormat` arbitrary IANA `timeZone` support.
2. SW `registration.getNotifications({tag})` + `close()` across Chrome/Firefox/Safari.
3. iOS PWA push EU/DMA status (unresolved conflict in platform research).
4. `web-push-testing` suffices for local-parity Web Push testing (FCM/APNs keep the
   in-process mock).

## Raised to founder / plan

- All schema changes above (approval required per AGENT-RULES).
- Migration mapping for existing `muted=true` rows.
- Topic-alias doctrine (derived alias, never raw id) → goes in the notifications doctrine
  doc, alongside formalizing the content-free payload decision.
- `createChatPushMembershipReader` (`push-notify.ts:59-66`) is a documented forced
  duplication of the conversations membership query (workerd-import constraint). The new
  pipeline touches this seam — decide whether the reader can be hoisted to a module free
  of the `@hushbox/realtime` value-import instead of adding a third copy.

Key files: `apps/api/src/adapters/push-notify.ts`,
`apps/api/src/slices/notifications/domain/notify-message.ts`,
`apps/api/src/slices/notifications/adapters/push-sender-factory.ts`,
`packages/db/src/schema/device-tokens.ts`,
`packages/db/src/schema/conversation-members.ts`,
`apps/api/src/lib/jobs/enqueue.ts`, `packages/shared/src/env.config.ts`.
