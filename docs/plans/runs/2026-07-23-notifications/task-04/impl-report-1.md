# Task 04 — Pipeline core — impl report 1

## Objective

Generalize the push path into `notifyEvent` (I3): a pure decision function (prefs +
quiet hours + boolean mute + presence + global switch + actor exclusion), a composite
`PushSender` (I4) over the FCM adapter + Task 03's in-house Web Push sender with
collapse-alias stamping (G1), the prefs read/write routes, and typed web-subscription
registration. `sendPushForNewMessage` becomes the `message` case of `notifyEvent`.

## workerd Intl spike (BLOCKER gate — PASSED)

Production quiet-hours evaluation runs inside workerd (ConversationRoom DO + Worker), but
the api vitest project runs in `node`. So the spike was run in the **real workerd binary**
(`@cloudflare/workerd-linux-64@1.20260611.1`, `workerd test`, compat-date 2026-06-01):

- `America/New_York` @ 2026-01-15T12:00Z → `07:00` (EST, UTC-5) and @ 2026-07-15T12:00Z →
  `08:00` (EDT, UTC-4) — DST honored.
- `Asia/Tokyo` → `21:00` (UTC+9); `Asia/Kolkata` → `17:30` (UTC+5:30, half-hour offset).
- An invalid zone (`Not/AZone`) throws (fail-fast).

Result: `SPIKE_OK` / `[ PASS ]`. workerd honors arbitrary IANA `timeZone` values, so quiet
hours via `Intl.DateTimeFormat({ timeZone })` is safe. NOT blocked; no UTC-offset fallback.
The behavior is also pinned in CI by `quiet-hours.test.ts` (node, same result set).

## Files changed

New (notifications slice):
- `domain/quiet-hours.ts` — `localMinutesOfDay` / `isWithinQuietHours` (IANA tz via Intl).
- `domain/notify-decision.ts` — `selectNotifyRecipients` pure decision fn.
- `domain/notify-event.ts` — `notifyEvent` (I3) + `CATEGORY_COPY` (fixed generic per-category copy).
- `domain/notification-preferences.ts` — prefs body schema (nested quiet-hours, IANA-validated) + get/save + view projection.
- `ports/notification-preferences.ts` — `NotificationPreferences`/`Store` port, `CATEGORY_TOGGLE`, `DEFAULT_NOTIFICATION_PREFERENCES`.
- `adapters/notification-preferences-store-db.ts` — `notification_preferences` single-writer.
- `adapters/collapse-alias.ts` — `createCollapseAliasDeriver` (truncated HMAC-SHA-256, base64url ≤32; G1 alias).
- `adapters/push-webpush.ts` — Web Push partition `PushSender` over `sendWebPush`; 404/410 → `deadTokens`.
- `adapters/push-composite.ts` — composite `PushSender`: alias-stamp + partition by platform + fold.
- Tests for each of the above (+ `device-token-store-db.test.ts` unit for row widening).

Modified:
- `ports/push-sender.ts` — `PushRecipient` widened to the I4 platform-tagged union; added `PushDeviceRef` (the prune key) and `PushMessage.collapseKey`.
- `ports/device-token-store.ts` — `DeviceTokenRegistration` gains optional `p256dh`/`auth` (web).
- `adapters/device-token-store-db.ts` — upsert writes web keys; `listTokensForUsers` widens rows to the union (drops malformed web rows).
- `adapters/push-fcm.ts` — narrows to native targets; stamps `collapse_key`/notification `tag`/`apns-collapse-id` from `collapseKey`.
- `adapters/push-sender-factory.ts` — returns the composite in every mode (mock partitions in dev/CI, real FCM + Web Push in prod); requires `NOTIFICATION_TAG_SECRET` (all modes) and VAPID (prod), fail-fast.
- `routes.ts` — `POST /web-subscriptions`, `GET/PUT /preferences` (byUpsert, session-classed).
- `domain/index.ts`, `index.ts`, `ports/index.ts` — barrel wiring; removed `sendPushForNewMessage`/`selectPushRecipients`.
- `apps/api/src/adapters/push-notify.ts` — `createMessagePushNotify` rewired to `notifyEvent(category:'message')`; the documented membership-reader duplication is KEPT (see concerns).
- `apps/api/src/app.ts` — wires `preferencesStore: createNotificationPreferencesStore`.
- `packages/shared/src/env.config.ts` — appended `NOTIFICATION_TAG_SECRET` (all modes; committed dev value; prod secret; no fallback) + its backend schema entry.
- `apps/api/src/slices/chat/routes.integration.test.ts` — migrated caller (deviation, below).
- `.gitleaks.toml` — one path-and-value-pinned allowlist entry for push-webpush.test.ts.
- Regenerated env derived files (`generate:env`): `.env.development`, `.env.scripts`, `apps/api/.dev.vars`, `apps/api/wrangler.toml`, `.github/workflows/{ci,release,build-android,run-ops-script}.yml`.

## Self-gate (all after last edit)

- workerd Intl spike — **pass** (see above).
- `pnpm test` notifications slice (via with-env) — **pass**, 249/249 (25 files); with `push-notify.test.ts` + coverage run: 256/256 (26 files). Chat push integration tests (migrated caller): 7/7 pass.
- `turbo typecheck --filter=@hushbox/api` — **pass**; `--filter=@hushbox/shared` — **pass**.
- `eslint <owned files>` (from `apps/api`) — **pass**, exit 0, clean.
- `jscpd --threshold 2` (owned files, repo `.jscpd.json`) — **pass**, exit 0 (1.64% lines / 2.37% tokens; only routes.ts route-boilerplate clones, tests ignored per config).
- gitleaks `detect --no-git` over every owned file — **pass**, 0 findings (after the push-webpush.test.ts RFC-vector allowlist entry).
- Coverage 95% per-file (owned files, with-env) — **met**: zero owned files under threshold. push-fcm.ts 100/98.07/100/100; the 3 previously-short files (device-token-store-db, push-composite, push-webpush) closed with the row-widening unit test, the alias-derivation-rejects test, and the no-collapseKey test.
- `pnpm verify:env --mode=development` — **pass**.
- `pnpm db:migrate` (Task 02 migration applied locally for integration tests) — clean.

## Acceptance criteria

- **Pure decision fn, exhaustive** — met. `notify-decision.test.ts` (15) + `quiet-hours.test.ts` (14): each category toggle, category independence, global switch off, mute, present, actor, quiet hours (same-day inclusive-start/exclusive-end, cross-midnight both arms + daytime gap, tz boundary NY vs Tokyo, half-hour Kolkata, DST, zero-length window, missing-row defaults), all with injected `now`.
- **`notifyEvent` barrel export; callers migrated; message path behavior-identical** — met. `notify-event.integration.test.ts` proves absent-delivered / muted-suppressed / present+actor-suppressed / global-off / dead-token-prune / membership-failure over the real device-token + prefs stores; `push-notify.test.ts` proves the composition-root wiring; the chat route push integration tests stay green.
- **Composite partitions; FCM `collapse_key`+`tag`, web `Topic`; no raw conversationId in any web header** — met. `push-composite.test.ts` (partition + alias on both partitions + no-raw-id), `push-fcm.test.ts` (collapse fields = alias), `push-webpush.test.ts` (Topic = alias; serialized url+headers and the encrypted body both assert `not.toContain(conversationId)`), `collapse-alias.test.ts` (pinned HMAC vector, url-safe, ≤32, never the raw id).
- **Web Push 404/410 → deadTokens prune through the mock seam; `lastSeenAt` touched** — met. push-webpush maps 404 and 410 to `deadTokens` keyed by endpoint; `notify-event` prunes via `deleteByToken`; the store's `upsert` bumps `updatedAt` and the schema defaults `lastSeenAt` at insert (retention read is Task 06's).
- **`GET/PUT /notifications/preferences` with Zod + web-subscription upsert** — met. `routes.integration.test.ts`: prefs GET defaults / PUT round-trip + idempotent replay + unknown-timezone 400; web-subscriptions register (web row) + malformed 400 + store-failure 503.
- **workerd Intl spike** — met (above).

## Deviations (with reasons)

1. **Edited `apps/api/src/slices/chat/routes.integration.test.ts`** (outside the plan's Task 04 file list). Its `notify` stand-in called the removed `sendPushForNewMessage`; leaving it breaks the entire `@hushbox/api` compile, so the brief's "callers migrated / message-path integration tests still green" cannot hold otherwise. The edit is a mechanical swap to `notifyEvent(category:'message')` + a defaults prefs store; no chat production code or assertion semantics changed.
2. **I4 recipient union carries `userId` on both arms**, and `deadTokens` is a distinct `PushDeviceRef` (`{userId, token}`), not the union. The plan's I4 shorthand omits userId, but the existing prune contract (`deleteByToken(userId, token)`, token = the unique `device_tokens.token`/endpoint) structurally requires it.
3. **Regenerated env derived files** via `generate:env` after adding `NOTIFICATION_TAG_SECRET` — required by the CI env-drift gate; `verify:env` green. Touches committed workflow/env files beyond the slice.
4. **`.gitleaks.toml`** gained one narrow allowlist entry (exact path + exact value) for the inert RFC 8291 Appendix-A auth vector reused in `push-webpush.test.ts`, per the run's standing gitleaks amendment.

## Concerns and limitations

- **Membership-reader duplication KEPT, not hoisted.** `push-notify.ts`'s `createChatPushMembershipReader` still duplicates the conversations adapter's `createPushMembershipReader` (the workerd value-import constraint is unchanged, and the hoist target is a conversations-slice file the plan assigns to Task 05). No third copy was added.
- **Prefs are read over all active members**, even when every candidate is dropped by the cheap conversation-scoped signals (mute/presence/actor). This matches the design doc's "three batched queries per event" model; not pre-filtered.
- **Shared-file coordination:** `.gitleaks.toml` and `packages/shared/src/env.config.ts` are concurrently edited by other workstreams; my edits are append-only/additive. `generate:env` also regenerated the workflow/env files those workstreams touch.
- **External red (NOT this task):** `domain/templates/template-html.test.ts` fails 7 snapshots ("byte-stable across the builder-helper refactor") — the concurrent email-builder refactor removed a Google-Fonts `<link>` without updating the snapshot. I touched zero template files; reproduces independently of this task.

## Confidence

**High** — every owned file passes typecheck, lint, jscpd, gitleaks, and the 95% coverage
gate; the workerd Intl blocker was verified against the real runtime; the message-path
behavior is proven identical over real stores and through the migrated chat integration
tests. Medium only on the one out-of-ownership chat-test edit, which is raised for the
orchestrator to confirm sequencing.
