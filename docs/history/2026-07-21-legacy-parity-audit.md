# Legacy → New Backend Parity Audit — 2026-07-21

A full comparison of every behavior and exact value recorded in
`legacy/LEGACY-BEHAVIOR-REPORT.md` (5,022 lines, 12 sections, covering all 374 legacy
TypeScript files) against the new codebase as of this date (uncommitted working tree).

**Method.** Twelve comparison subagents, one per report section, each reading its section
in full and locating the new-code counterpart for every behavior/value, classifying each as
SAME / DIFFERENT (justified vs regression-candidate) / ABSENT. All 35 resulting regression
candidates then went through independent adversarial verification (13 verifier agents,
briefed to refute, given citations but not the finders' reasoning). Every claim below was
verified by reading code this run; citations are new-code `file:line` (working tree) and
legacy-report line numbers (L####). Prior founder rulings (2026-07-08, 2026-07-12/13,
2026-07-18 audits) were used as a suppression list — accepted deviations are not re-raised,
and previously ordered fixes were re-verified as present.

**Outcome:** 28 verified findings survive (7 medium, 1 low-medium, 20 low); 7 candidates
were refuted. The overwhelming bulk of the legacy surface — every rate limit, TTL, dollar
constant, cushion, email subject, crypto invariant, and settlement rule checked — is
preserved or deliberately improved. All ~20 previously ordered regression fixes were
re-verified present.

Findings in this doc are **verified but not yet ruled** — no fix has been ordered from this
audit at the time of writing.

---

## 1. Differences that are regressions (verified findings)

### Medium severity

#### R1 — Delete-account 24h hard lock trips one attempt later than designed (off-by-one)

- **Legacy** (L579, L583): the 3rd consecutive step-up failure itself engaged the 24h lock
  and that very response carried `403 DELETE_ACCOUNT_LOCKED`.
- **New**: the attempt-reservation gate is `count > maxAttempts` with `maxAttempts: 3`
  (`apps/api/src/slices/identity/domain/lockout.ts:33-44`,
  `apps/api/src/slices/identity/domain/keys.ts:220-224`), and reservation runs before
  verification (`deletion.ts:171-189`) — so attempts 1–3 are all admitted and answered
  `bad-proof`/`invalid-totp`; only a 4th attempt observes `lockedOut`. An attacker pacing
  exactly 3 guesses per rolling hour never trips the 24h hard lock at all. The code's own
  comment (`deletion.ts:174-175`, "3 failures inside the hour — engages the… 24-hour hard
  lock") asserts behavior the code does not implement. Secondary: the locked response is
  `429 TOO_MANY_ATTEMPTS`; `DELETE_ACCOUNT_LOCKED` exists (`error-codes.ts:117`) but is
  never emitted (client works around it — `delete-account-modal.tsx:50-59`).
- **Verdict:** CONFIRMED regression, defect. The attempt-reservation *mechanism* is the
  ruled 2026-07-13 redesign; the unadjusted threshold semantics are not. Exploitability is
  bounded (OPAQUE + optional TOTP), hence medium not high.

#### R2 — `width`/`height`/`durationMs` dropped from history and public-share wire shapes

- **Legacy** (L850-853, L1226-1227): both reads served media dimensions/duration.
- **New**: `contentItemViewSchema` omits all three
  (`apps/api/src/slices/conversations/domain/content-item-view.ts:11-18`;
  `domain/history.ts:20-26`); the DB columns still exist and are populated
  (`packages/db/src/schema/content-items.ts:34-39`) but are never served. The client
  actively depends on them: `apps/web/src/lib/api.ts:140-146` types them;
  `media-preview.tsx:47-72` uses persisted dimensions as aspect-ratio tier 2 (now dead);
  the adapters hardcode `width: null, height: null, durationMs: null` with comments
  acknowledging the server no longer sends them (`hooks/chat/chat.ts:88-113`,
  `use-shared-message.ts:98-100`). Every non-square media item reloaded from history or
  opened via a share link renders in a wrong-shaped (square-fallback) preview box — a
  persistent visual defect, not transient jank. Also: `publicShareContentItemSchema`
  (`packages/shared/src/schemas/api/message-shares.ts:69-88`) still declares the old
  legacy shape and has zero references — stale dead code.
- **Verdict:** CONFIRMED regression, defect. Columns exist; fix is threading three fields
  through the view schema and two adapters.

#### R3 — Media GC lost its runtime budget and operational stats

- **Legacy** (L1332-1351): `MAX_GC_RUNTIME_MS = 25_000` chosen explicitly against the
  Workers 30s `cpu_ms` ceiling; early bail with `partialCompletion: true`; stats
  `{scanned, orphansFound, deleted, bytesReclaimed, durationMs, partialCompletion}`.
- **New**: `runMediaGc` recurses the full listing to exhaustion with no budget check
  (`apps/api/src/slices/media/domain/gc.ts:113-138`); report carries only scan/reclaim
  counts (`gc.ts:56-61`); evidence records only after a complete pass (`gc.ts:104-110`).
  The same platform ceiling still applies (`apps/api/wrangler.toml:17-18`,
  `cpu_ms = 30000`), and GC now shares one cron invocation — and one CPU budget — with the
  ledger-conservation and snapshot-drift billing auditors
  (`apps/api/src/scheduled.ts:92-124`, `apps/api/src/jobs/cron.ts:22-36`, `Promise.all` in
  one isolate; a platform CPU kill is not a catchable exception). The sweep re-lists the
  entire media prefix every pass, so the scaling variable is total live object count —
  breach is an eventual certainty, and with no checkpointing a pass that can't finish
  in-budget makes zero forward progress every hour thereafter.
- **Verdict:** CONFIRMED regression, defect (reinstate a soft budget bail + partial
  evidence). The 30-min GC grace itself is the ruled/suppressed item and is fine.

#### R4 — User-only ("AI off") messages lost fork support; message can vanish from fork view

- **Legacy** (L1704-1709, L1793, L1799): `POST /:conversationId/message` resolved the
  parent via `forkId` → fork tip, and advanced the fork tip.
- **New**: `userOnlyMessageSchema` is `{messageId, content}` only
  (`packages/shared/src/schemas/api/conversations.ts:156-159`); `saveUserOnlyMessage`
  resolves the linear tip unconditionally
  (`apps/api/src/slices/chat/domain/user-message.ts:52-58,151`); the route reads no
  `forkId` (`chat/routes.ts:1266-1298`). Paid turns kept full fork machinery
  (`settlement.ts:147-152, 257-263, 548-553`). Because the fork view is a strict tip→root
  `parentMessageId` walk (`apps/web/src/hooks/chat/use-fork-messages.ts:13-31`), a
  user-only send while viewing a non-Main fork is parented onto Main — after refetch the
  message disappears from the fork the user was looking at.
- **Verdict:** CONFIRMED regression, defect (visible correctness bug in group+forks+AI-off
  intersection).

#### R5 — Every server-seeded conversation gets an empty title

- **Legacy** (L4598, L4645, L4663, L4667-4680): seed conversations had real titles,
  including the dedicated `Screenshot: ${name}` titles.
- **New**: the one shared shell hardcodes `title: encryptTextForEpoch(epochKey, '')`
  unconditionally (`apps/api/src/platform/dev/factories.ts:154-181`, line 176); none of
  the four factory param interfaces expose a title; the frontend has no "Untitled"
  fallback (`apps/web/src/components/sidebar/chat-item.tsx:49-61` renders verbatim;
  `page-header.tsx:80-88` omits the block entirely). Every seeded conversation shows a
  blank sidebar row. The "breaks marketing screenshots" angle is weaker than it looks:
  `scripts/generate-screenshots.ts:18-20,401-410` is already blocked by an unrelated stale
  guard, and 3 of 4 target resolutions CSS-hide the header title anyway; the hq-tour
  capture drives a separate `/demo` route and does not use this seed data.
- **Verdict:** CONFIRMED regression, defect (thread a `title` param through
  `seedConversationShell` and its callers).

#### R6 — Fork-tip / epoch-wrap settlement conflicts surface as `INTERNAL` 500 + Sentry page

- **Legacy** (L4783-4794): `ForkTipConflictError` had its own prioritized wire code
  `FORK_TIP_CONFLICT`; the client mapped it to "Someone else updated this branch. Refresh
  and try again."
- **New**: `ForkTipConflict`, `EpochWrapConflict`, `ForkTipMovedConflict` are thrown from
  the settlement commit (`apps/api/src/slices/chat/domain/settlement.ts:54-90`) and caught
  nowhere by name — they land in the engine's `settle()` catch
  (`workflows/engine/interpreter.ts:1009-1039`), which discriminates only
  `AllBranchesFailedError`/`StorageUnavailableError`, and everything else becomes a Sentry
  `workflowSettlementDefect` + generic `{outcome:'failed', code: INTERNAL}`
  (`failures.ts:73-84`). The codebase's own docstrings grade two of the three as expected,
  never-defect conditions (`conversations/domain/wrap-epoch.ts:25-26`,
  `fork-tip.ts:18`) — while `advanceForkTip`'s CAS zero-row site is documented as a
  genuine defect (`fork-tip.ts:58-59`), so the single `ForkTipConflict` class currently
  conflates one true defect with one expected outcome. These fire on ordinary group-chat
  concurrency (membership rotation mid-turn; two members/devices regenerating the same
  fork tip), not rare races. No retry layer exists in between. `FORK_TIP_CONFLICT` remains
  wired for the `PUT /forks/:id/tip` CAS path (`conversations/domain/outcomes.ts:119-125`)
  — reachable there, never from chat settlement. This also contradicts stated
  observability doctrine (expected domain failures are `Result` values → `{code}`
  responses; Sentry is for unexpected errors only).
- **Verdict:** CONFIRMED regression, defect — extend the existing discrimination pattern;
  requires splitting the expected throw sites from the genuine-defect CAS site first.

#### R7 — `[req]` request-log line removal breaks the dev-stack idle heartbeat (and orphans APK log tooling)

- **Legacy** (L182-193): dev request log `[req] <ISO> <METHOD> <path> <status> <ms>ms
  v=<version>` on stdout.
- **New**: `request-log.ts` emits structured JSON via the typed logger
  (`apps/api/src/middleware/request-log.ts:38-43`,
  `lib/telemetry/console-adapter.ts:37`) — nothing emits `[req]` anymore. Two consumers
  are stranded: `scripts/lib/extract-mobile-api-log.ts` (mobile-APK traffic extraction,
  now dead) and — more consequentially — the dev-stack idle heartbeat:
  `scripts/lib/heartbeat-source.ts:1-20` (`/^\[req\]\s/`) feeds
  `scripts/wrangler-dev.ts:158-166`, so live API traffic never ticks the heartbeat and
  `ensure-stack`'s idle daemon (`ensure-stack-cli.ts:41`, 60-min TTL) can reap the local
  Docker stack out from under a developer who is actively using the app in a browser for
  over an hour (tests/E2E tick via separate sources).
- **Verdict:** CONFIRMED regression (upgraded by verification), defect — either emit a
  heartbeat-compatible line again or repoint the heartbeat source; delete or repoint the
  APK extraction script.

### Low-medium severity

#### R8 — DO `webSocketClose`/`webSocketError` no longer complete the close handshake

- **Legacy** (L3567-3576): `webSocketClose` echoed the peer's `code`/`reason` into
  `ws.close(code, reason)`; `webSocketError` closed with `1011`/"WebSocket error".
- **New**: both handlers ignore code/reason entirely and only untrack + rebroadcast
  presence (`packages/realtime/src/conversation-room.ts:264-272`,
  `room-core.ts:344-347`); no `socket.close()` call exists on this path. Cloudflare's
  docs make the echo call unnecessary only under the `web_socket_auto_reply_to_close`
  behavior gated to `compatibility_date >= 2026-04-07`; this Worker pins
  `compatibility_date = "2026-03-01"` with no override flag (`apps/api/wrangler.toml:6-7`)
  — the mitigation that would excuse the omission is not active.
- **Verdict:** CONFIRMED, defect (echo the close, or advance the compat date / add the
  flag deliberately).

### Low severity

#### R9 — Auth rejection wire codes collapsed to generic `UNAUTHORIZED`/`FORBIDDEN`

Legacy's seven distinct session-gate codes (`SESSION_REVOKED`, `PASSWORD_CHANGED`,
`2FA_EXPIRED`, `2FA_REQUIRED`, `BILLING_SESSION_RESTRICTED`, `NOT_AUTHENTICATED`,
`USER_FOUND`) are gone from the taxonomy (L228-241;
`apps/api/src/lib/context/principal.ts:98-113` documents the collapse as deliberate;
`route-class.ts:34-51`). Verification downgraded this: the current client never consumed
the distinctions (every mid-session 401 → one clear-auth-and-redirect flow,
`apps/web/src/providers/query-provider.tsx:37-52`) and pending-2FA is signaled positively
in the login response. Real API-surface narrowing with no live UX cost today. *Decision*:
accept, or restore granular codes if "why was I signed out" UX is ever wanted.

#### R10 — OPAQUE `ke1`/`ke3` 1024-element cap dropped across all four flows

Legacy Zod-capped KE arrays at 1024 (L571, L740). New schemas are `.min(1)` with no max in
deletion, login, password-change, and 2FA-disable
(`identity/domain/deletion.ts:32,36`, `login.ts:35,40`, `two-factor-disable.ts:24,28`,
`password-change.ts:20,25`). The 40 MiB global body cap
(`middleware/body-limit.ts:26`) does not meaningfully bound parse cost (a JSON number
array can pack ~10M elements under it). Systemic, unruled. Defect: restore a max.

#### R11 — Delete-account hard lock not checked at `/init`

Legacy checked at both init and finish (L570). New checks only inside the finish flow
(`deletion.ts:58-72` vs `:152-162`); the init route's comment even claims a lockout that
isn't applied (`identity/routes.ts:845-867`). A locked user burns a full OPAQUE round-trip
+ Redis pending state before learning of the lock. Defect.

#### R12 — Link/guest display-name cap silently changed 100 → 200

L936/994/1002 vs `SHARE_DISPLAY_NAME_MAX_LENGTH = 200`
(`conversations/domain/schemas.ts:31`). Loosening, harmless, but an unexplained drift in an
otherwise exactly-ported value set. Defect (pick a value, document it).

#### R13 — Read-time MIME defense-in-depth gone on public share read

Legacy re-parsed stored `mimeType` against the allowlist at read time (L1220-1222). New
serves it as a plain nullable string (`content-item-view.ts:15`, `shares.ts:679-697`);
write-time enforcement exists (the ruled MIME-at-put fix, verified present). A named
second-layer defense at a different lifecycle moment was silently dropped — not a
collapse-the-duplicate case. Defect (low).

#### R14 — Member-removal refusal code inconsistent with sibling privilege-change path

Removal answers generic `FORBIDDEN` (`members.ts:370`) while privilege-change preserves
`PRIVILEGE_INSUFFICIENT` with a comment explicitly citing the legacy distinction
(`members.ts:643-648`); legacy used `PRIVILEGE_INSUFFICIENT` for both (L1071-1073,
L1086-1087). Likely cause: the new `PRIVILEGE_INSUFFICIENT` copy was narrowed to
privilege-setting wording (`error-codes.ts:197`). *Decision*: restore a removal-appropriate
specific code, or accept `FORBIDDEN` and fix the overclaiming comment.

#### R15 — WS-upgrade non-member answers 403 (existence-revealing), odd one out in its own slice

Legacy: 404 existence-hiding (L3463-3464). New: `userUpgradePrincipal`/
`guestUpgradePrincipal` answer `403 FORBIDDEN`
(`conversations/routes.ts:366-374,394-400`) while the sibling `GET /:conversationId`
still answers existence-hiding 404 (`conversations.ts:158-167`, `outcomes.ts:49-54`).
*Decision*: align WS with 404, or declare 403 the WS-upgrade contract.

#### R16 — Regenerate can never re-enable web search

Legacy read `webSearchEnabled` off the regenerate body
(`legacy/apps/api/src/legacy/routes/chat.ts:1027` — verified in legacy source, not just the
report). New `regenerateTurnBodySchema` has no such field; the in-code comment states the
omission but no ruling exists (`chat/routes.ts:130-171, 1034-1037`). Retrying a
search-backed answer silently produces a non-search answer. *Decision* for the founder.

#### R17 — Per-model discrete video-duration pre-flight is currently enforced nowhere

Legacy rejected out-of-set durations with `400 UNSUPPORTED_DURATION` per model (L1701).
New has only global range bounds; the ParamSpec compiler that would restore per-model
enforcement (`models/domain/wire-params.ts:26-46`) is exported but never called from any
live path (verified repo-wide), and `video-adapter.ts:146-154` admits the wiring is
pending. Out-of-set requests fail at the provider instead of pre-flight. Defect (finish the
acknowledged wiring).

#### R18 — "Smart Model" chip lost on any classifier failure

Legacy set `isSmartModel` from `stagesRun` regardless of billing — a classifier throw still
badged the answer (L1528, L1543, L1678, L2103). New anchors the chip to a classifier
*charge* (`settlement.ts:472,484-489`); any classifier failure (typed or thrown) yields no
charge (`smart-model-execution.ts:159-186`; pinned by its own test), so the fallback answer
persists unbadged. Secondary: a genuinely unclassified thrown error now fails the whole
node as a Sentry defect (`model-call-execution.ts:250-256` → `interpreter.ts:576-604`)
where legacy degraded gracefully — rare in practice since the adapter pre-classifies
almost everything. *Decision*: accept the redefinition ("Smart = classifier ran and was
billed") or restore legacy chip semantics.

#### R19 — Idempotency-conflict wire-code override dropped in slices that bypass `domainWireCode`

The shared helper exists (`lib/errors/domain-error.ts:60-61`) but 8 slices map
`DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code]` directly, discarding `error.wireCode` —
today live only in `billing` (`/billing/login-link` uses `idempotent.byKey`,
`billing/routes.ts:120-125,217`) and `admin` (engine claims key rows,
`admin/domain/engine.ts:412,467-469`): a reused-key body mismatch or in-flight retry
answers generic `CONFLICT` instead of `IDEMPOTENCY_BODY_MISMATCH`/`REQUEST_IN_PROGRESS`
(different user copy; HTTP 409 either way). The other six raw slices have no
`wireCode`-bearing path today — a landmine for future `byKey` additions. Direct
"One Implementation, Shared" violation. Defect: route all slices through
`domainWireCode()`.

#### R20 — Unique-violation (23505) cause-chain walk re-implemented 4× with drift

One legacy module (depth-capped, message-fallback; L5002-5013) became four independent
copies: `conversations/adapters/stores.ts:38-51`, `identity/adapters/stores.ts:46-56`,
`chat/domain/user-message.ts:78-88`, `admin/adapters/stores.ts:10-25` — already drifted
(identity drops the message fallback; chat ignores constraint matching). Missing depth cap
is defensive-only (Drizzle wraps exactly once). Defect: hoist one shared helper.

#### R21 — `content_items` CHECK/partial-unique constraints no longer proven against real Postgres

Legacy integration-tested actual DB rejection (L4141-4149). New asserts only the constraint
*name* (`shape-tables.test.ts:446`); `schema.integration.test.ts` has the `expectDbError`
harness in active use for sibling constraints (lines 389-623) but no `content_items` case.
Coverage gap, not behavior change. Defect: extend the existing pattern.

#### R22 — Dev/test fidelity drops (five items, all dev/mock/test-only, no production impact)

- Dev-server mock delays (60/3000/1000 ms typewriter/media/classifier) gone — streaming UI
  states invisible in local dev (`mock-provider.ts:172-206`; only the per-request header
  delay survives). *Decision.*
- `recordedFromSha` never stamped on new cassettes (`recording-fetch.ts:139-202`) while
  `docs/CI-CASSETTES.md:173` still documents it — active doc drift. Defect (wire it or fix
  the doc).
- Mock echo lost grapheme-safe chunking (Intl.Segmenter, 24-grapheme) and the trailing
  JSON fence (`mock-provider.ts:60,385,416-421`) — latent emoji-split transient only; no
  E2E spec depends on the fence. *Decision.*
- Mock media ignores `aspectRatio` (fixed 400×300 PNG / fixed MP4,
  `mock-provider.ts:72-74,156-162`); E2E asserts the fixed dims, so aspect-dependent
  rendering has zero mock fidelity coverage. *Decision.*
- Integration tests assert only `byteLength > 0` on real recorded media
  (`image-adapter.integration.test.ts:53`, `video-adapter.integration.test.ts:55`) —
  legacy sniffed magic bytes + size bounds. Defect (reinstate; uncontroversial).

#### R23 — Seed/dev-surface content drift (three items)

- Bulk per-persona sample data (alice: 150 conversations) gone; `hasSampleData` is dead
  code never read (`scripts/lib/seed-personas.ts:46,56,109,139` vs zero reads;
  `scripts/seed.ts:440-483`). No workflow found that depends on list-scale data.
  *Decision* (restore some bulk generator, or delete the vestigial field).
- `DELETE /dev/usage-rate-limits` omits `share:create:user:ratelimit:*`
  (`platform/dev/redis-resets.ts:85-93`) while the limiter is live and the E2E helper's
  own doc comment claims it's cleared (`e2e/helpers/auth.ts:174-179`). Currently inert (no
  spec approaches 20 shares/60s). Defect: one-line addition.
- Charlie seed 4→2 messages / real content, and media seed cost $0.01→$0.003 —
  confirmed accurate but harmless; no consumer pins either value. Non-actionable.

---

## 2. Differences that are justified

Grouped by the sanctioned redesign that explains them. All were individually verified; a
value change inside a redesigned mechanism was only cleared when the value itself was
preserved or the change is documented/ruled.

**Pipeline & routing** — per-prefix middleware chains → one default-deny pipeline with
per-route `routeClass()` (undeclared route = 403); `/api` prefix removed repo-wide (typed
`AppType` client keeps lockstep); CORS public wildcard is class-keyed with `Vary: Origin`;
CSRF allowlist gains `ADMIN_URL`/`MARKETING_URL`; `UPGRADE_REQUIRED` → `VERSION_MISMATCH`
in the uniform `{code, details}` envelope (all semantics preserved); platform header parsed
at point of use; error handler never sees `HTTPException` (Result-based domain errors);
missing `IRON_SESSION_SECRET`/Upstash vars are named-binding defects (fail-fast doctrine).

**Auth & identity** — slim cookie claims (user fields re-read from DB; pre-cutover cookie
compat preserved by design); step-up handshakes single-use via atomic `GETDEL` (bad proof
costs a fresh init — documented); `session-mismatch` collapsed onto `no-step-up`
(enumeration defense); TOTP replay marker claimed via `SET NX` *before* verify (race-proof;
mistyped-code burn documented in-file); TOTP decrypt failure is a 500 defect per taxonomy;
advisory limiter + lockout marker pairs → atomic attempt reservation (ruled 2026-07-13);
delete-account R2 cleanup → `media.reclaimUser.v1` job (Pattern C); deletion revokes all
sessions (improvement over legacy's current-cookie-only); per-flow step-up error codes
collapsed to shared `NO_PENDING_STEP_UP`/`AUTH_FAILED`; registration username/email
tightened; instructions moved to account slice with a new 32 KiB cap; token-login
locked-account refusal (documented divergence — `lockedAt` postdates legacy); admission
hold TTL 180s → 16 min (must outlive the 15-min media deadline; legacy TTL covered SSE
turns only).

**Conversations / links / media** — error taxonomy consolidated to blind
`NOT_FOUND`/`FORBIDDEN`/`VALIDATION`/`CONFLICT` with domain codes retained where
behaviorally meaningful (`STALE_EPOCH`, `WRAP_SET_MISMATCH`, `MEMBER_LIMIT_REACHED`,
`ROTATION_REQUIRED`, `FORK_NAME_TAKEN`, …); share presign moved to client-minted URLs with
a new per-shareId re-mint cap; `limit` clamp → 400 reject (fail-fast); fork create
201/200 → 200 + `isNew`; `Guest {N}` naming moved client-side; `.enc` storage-key suffix
dropped (bucket holds only ciphertext; AAD binds the tuple); list-XML non-numeric `<Size>`
now aborts instead of skipping (safer for GC, documented); share-create/read distinctions
deliberately blinded (`FOR SHARE` membership lock preserved).

**Chat & workflow engine** — SSE protocol → WS run frames from the ConversationRoom DO
(ruled); client-supplied `parentMessageId` → server-resolved inside settlement (removes a
trust-the-client seam); reservation callbacks → atomic Lua admission holds + unguarded
settlement; funding source server-resolved (`BILLING_MISMATCH` 409 unrepresentable);
`LAST_MESSAGE_NOT_USER` made structurally impossible by the request shape; presign moved
to the media slice (same 300s TTL); push copy typo fixed; `message:new` no longer carries
prompt content pre-stream (doctrine comment in-file); trial cents-ceiling math moot in
integer nano-USD.

**Inference & catalog (Gateway → OpenRouter, all sanctioned)** — `getGenerationStats`
retry ladder → authoritative inline `usage.cost` (design of record); cassette header
allowlist 4→2 with a correct `v1`→`v2` version bump; per-request live catalog → hourly
jittered DB snapshot with per-reason exclusion alerts; 283-entry E2E fixture → live
`catalog:refresh --require-e2e-models` fail-loud gate; `applyFees`-at-catalog → single
canonical estimator + `applyMarkup` (ruled); web search pinned `engine:'perplexity'`
(ruled H1 design); cheapest-model test picker → hardcoded integration ids (documented
cassette-stability rationale); mock stats registry → inline mock cost; typed
`InferenceError` taxonomy replaces string matching.

**Billing (cents → nano-USD, all values preserved)** — money as `bigint` nano-USD
end-to-end; process/poll payment flow → D-pattern (pre-claim + webhook + `payment.verify.v1`
reconcile; route-level retry loops obsolete); budget PATCH → PUT in the conversations slice
(single-writer); renewal ledger rows → period-keyed allowance rule (ruled); per-wallet
concurrent-run cap is additive.

**Notifications** — console email/push dev adapters → mock sender + queryable
`/dev/mailbox` (ruled drop; strictly more capable); password-changed/reset split into two
honest templates (the ruled subject fix, verified); welcome tagline now matches the copy
legacy's own test called canonical (legacy shipped an internal copy/test contradiction).

**Roadmap/Linear** — `/api/public/roadmap` → `/public/roadmap` (subdomain architecture);
`RoadmapCache` class → typed key-registry entries with Zod-validated reads; three
`TEAM_KEY` literals → one shared constant.

**Realtime** — `ready` ordering relative to presence (socket already accepted; client only
gates on `ready`); missing DO binding 503 → required typed binding (fail-fast); DO 404
body JSON `{code}` per error contract; presence push suppression via inline snapshot
instead of a racy second HTTP hop; client relay payloads Zod-validated (closes a spoofing
hole); `http://internal` dummy host renamed.

**DB schema** — uuidv7 PK defaults; ledger redesigned to true double-entry with house
accounts and new CHECK invariants; `payments.status` `refunded`→`expired` (Reversibility
Iron Law: no admin refunds); `errorMessage`→`errorCode`; `senderType` `ai`→`assistant`+
`system`; `free_tier`→`free`; `users.email` mandatory+unique (backs the ruled email-verify
gate); two-phase `usage_records` → single-settlement columns; model attribution
deduplicated onto parent rows; `member_budgets` fail-closed explicit (no-row = deny);
drizzle-zod row-schema layer retired (validation moved to domain/Zod-at-boundary);
factory-per-table → four factories + slice-local fixtures + real-domain-call integration
tests (verified deliberate substitution).

**Scripts/dev** — `DELETE /dev/test-data` and `POST /dev/expire-session` retired with
load-bearing comments naming their successors; seed cache CLI folded into `db:seed`; raw
bulk-upsert seeding → seeding through real production stores/settlement; 2FA dual
limiter+lockout → one attempt-reservation mechanism (same 10/900 values); dev reads keyed
on direct FKs instead of polymorphic `sourceType`/`sourceId`.

---

## 3. Same behaviors / values (verified preserved)

The parity core. Each item was checked value-by-value against the legacy report; citations
live in the per-section verification (this doc records the roll-up).

**Security & session** — CSP directive list byte-identical; `nosniff`, `DENY`,
`no-referrer`; full CSRF rule set (methods, Capacitor origins, URL-origin normalization,
malformed → 403 `CSRF_REJECTED`); cookie `hushbox_session`, 30-day max age, `httpOnly`,
`secure: isProduction`, `sameSite` prod `none`/dev `lax`; client-IP precedence chain
(`cf-connecting-ip` → first `x-forwarded-for` → `x-real-ip` → `unknown`); SHA-256 IP
hashing; version-check semantics (skip versions, exempt prefixes, mobile updateUrl).

**Every rate limit and lockout constant checked** — login 5/900 user + 20/900 IP; register
3/3600 + 10/3600; 2FA 10/900; recovery 3/3600 user + 10/3600 IP (get-key same — the ruled
values, verified); resend-verify 1/60 email + 5/60 IP; verify-email 30/3600 IP + 10/3600
token; media download 60/60; share read 30/60 IP; share create 20/60 user (exact legacy
Redis key, mount verified in `app.ts` — a stale routes-file comment claims otherwise);
chat stream 30/60; roadmap 30/60; delete-account 3/3600 (but see R1 for engagement
semantics); lockout TTLs and the 90-day purge.

**Redis key registry** — all session/step-up/OPAQUE key templates, TTLs (300s pendings,
120s login/TOTP-replay, 30d session/pw-changed), schemas, and the UUID-handshake anti-
clobber rationale preserved verbatim, comments included.

**Money (every value survived the nano-USD migration)** — 50¢ paid cushion (paid-only);
$0.05 free daily allowance; $0.20 welcome credit; trial 5/day + $0.01 per-message cap +
UTC midnight; 15% total markup (`MARKUP_BASIS_POINTS = 1500n`, drift-guarded); storage
rates exactly 300 nano/char and 18 nano/byte, additive after markup (ruled fix, verified);
search reservation 10 × $0.005 × markup, N-not-N²; $5 whole-cent minimum deposit; 30-min
payment expiry; 60s billing login-link TTL; Helcim token min length; webhook HMAC scheme;
double-entry zero-sum legs; two wallets per user with purchased-priority; usage analytics
routes.

**Chat/turn semantics** — `computeSafeMaxTokens` contract byte-for-byte; one `batchId` per
turn; contiguous sequence blocks (user at index 0); retry-one/retry-all/edit deletion
semantics incl. fork-exclusive tails; Smart Model cheapest-doubling classifier, fallback
ladder, `[HUSHBOX_CLASSIFIER]` marker, classifier output token cap, worst-case-eligible
pricing; trial single-model, persist-nothing, `TRIAL_MESSAGE_TOO_EXPENSIVE`; video
progress constants (95/10/5000ms/×8/5s); image/video mime allowlists; presign TTL 300s;
max media object 250 MB; 8-mime allowlist; forks max 5, members max 100, `Fork {N}`
auto-naming, "Main" reserved, linear-revert.

**Inference plumbing** — env three-way gate (mock/dev, cassette/CI-vitest, real) with
fail-fast key checks; the entire cassette mechanism (canonical descriptor, sha-16 hash,
atomic write, defensive read, record-on-miss <400 only, deliberately interoperable with
legacy recordings); integration timeouts 30/60/300s; `MAX_SEARCH_TOOL_CALLS = 10`;
`SMART_MODEL_ID` rejection; empty-turn/length-truncation/tool-error-hold decision table;
`mediaType` field contract; evidence-on-success-only.

**Notifications** — Resend URL/from byte-identical; base HTML template diff-empty
(colors, wordmark, layout); placeholder engine identical; all seven templates and every
subject line byte-identical (verified against legacy source, not the report text); 24h
verification TTL; account-locked fire-once + 15-min copy math; capture-email-before-delete;
unconditional welcome email (ruled fix, verified); FCM constants, OAuth JWT flow, token
cache formula, `Promise.allSettled` isolation, mute/sender/presence recipient selection,
single-field `data` payload, best-effort-never-throws contract.

**Realtime** — ping/pong wire strings and single-registration semantics; ping no-op
defense; binary-drop; sender-excluded relay; all-socket broadcast; 404-not-405; one DO per
conversation via `idFromName`; `x-link-public-key` header + `linkPublicKey` WS query
fallback; typing/message event shapes (additively extended).

**Schema-level** — bytea lengths (64/32/48/48/32); non-null crypto columns;
`content_items` type-consistency CHECK SQL and partial unique storage-key index;
epoch/epoch-member constraints; unique `(conversationId, epochNumber)` and
`(userId, type)`; `createDb()` pool semantics; enum value sets cross-checked.

**Seed/dev** — seed safety-gate refusal string byte-identical + same local-host set;
multi-model cost ladder (2+index)/1000 USD exact; all 7 Playwright project names/codes;
persona roster (11 — the report's "10" was its own imprecision); screenshot conversation
structure (5 conversations, exact member/message counts); `/dev/set-version`,
`/dev/wallet-balance`, SCAN-count-1000 reset mechanics; dev email/password domains.

**Roadmap** — route contract, 3600s cache TTL, cache-key, 30/60 limiter, GraphQL endpoint
+ page size + team-key query shape, full normalization pipeline (orphan project, status
ranks, depth-64 clamp, 12-char id hashing, progress counting), 14-issue mock fixture
id-for-id.

---

## 4. Other improvements found (new code better than legacy)

Security/correctness improvements with no legacy counterpart, found during comparison:

1. **Default-deny route authorization** — an undeclared route is 403 even with a full
   session; legacy was default-open per prefix.
2. **App-wide session revocation on every cookie-bearing request** with production
   fail-fast if unwired; fail-closed 503 when Redis can't confirm liveness. Legacy
   enforced revocation only on some prefixes and deletion only killed the current cookie.
3. **Atomic attempt-reservation on secret-guessing surfaces** (exactly-N under
   concurrency) closing legacy's check-then-act undercount race; TOTP single-use via
   `SET NX`; step-up single-use via `GETDEL` with no-pending/mismatch collapse.
4. **HSTS + default-deny Permissions-Policy; headers applied in `finally`** (500s carry
   them too); edge request body limit (413).
5. **Universal Idempotency-Key pipeline stage** — legacy had no route-level idempotency.
6. **Broadcast-time membership + session revalidation** (no zombie sockets), client-relay
   identity overwrite (closes a real spoofing hole where a client could forge `userId` in
   relayed typing events), CSWSH Origin guard on WS upgrade, presence `conversationId: ''`
   bug fixed, accurate delivery accounting, session-revocation socket fan-out, resumable
   Last-Event-ID replay.
7. **Settlement integrity** — atomic saved⟺billed single-transaction settlement; epoch
   fail-fast (legacy silently fell back to epoch 1 on a missing conversation row);
   fork-tip TOCTOU fence; R2 key asserted against the AAD tuple before row writes; media
   put barrier before settlement; nil-UUID assistant sender so account deletion can't
   brick co-members' decryption; prompt storage charged once across fan-out.
8. **Billing hardening** — dispute/chargeback clawback (`byEventId`) + account auto-lock;
   IPv6 /64 collapsing on trial counters; single markup site with marketing-constant
   drift guard; DB-enforced idempotency keys on payments/usage/ledger;
   `helcimTransactionId` unique; double-entry CHECK invariants; repo-wide
   no-numeric-money-column architecture test; `runId` grouping for monthly reconciliation.
9. **Identity** — sessionActive-written-before-cookie ordering; realistic recovery dummy
   blob; LIKE-escape fix in user search + membership-probe oracle closed; OTA bundle
   sha256 checksums; locked-account refusals on login and token-login; decoy store write
   on unknown-email resend (timing uniformity); dead `verifyTokenRateLimit` config made
   live.
10. **Inference** — ZDR enforcement strengthened (`zdr:true` + `data_collection:'deny'` +
    `allow_fallbacks:false` + `transforms:[]`, lint-guarded, non-ZDR models never even
    persisted); video download byte-cap metering + SSRF-hardened redirects; `maxRetries: 0`
    on every SDK call (one-retry-mechanism doctrine); refuses to record cassettes against
    the mock key; valid-by-construction mock PNG; catalog exclusion observability;
    balance-independent Smart-Model candidate menu.
11. **Notifications** — FCM dead-token pruning; device tokens never in error text;
    provider bodies never in email errors; typed Result error channel; batch send with
    provider-level idempotency; dev mailbox + account-deleted preview gap closed.
12. **Structure** — GC per-delete failure isolation (ruled fix, verified); blind uniform
    not-found across guest-reachable reads; malformed list-XML aborts; refusal-before-write
    + `FOR UPDATE` discipline across membership/link/fork mutations; batch keychain partial
    semantics; storage/target error split in dev seed routes (503 vs 404); dev wallet
    balance set via balanced ledger pair; per-worker E2E persona pool; retired dev routes
    documented in place; telemetry scrubbing structural (allowlist-rebuilt Sentry events)
    rather than keyword-gated.

---

## 5. Refuted candidates (checked, not issues — do not re-raise)

| Candidate | Why refuted |
|---|---|
| Vision/image input to text models "lost" | Legacy never shipped it: client wire schema was `content: string` only; `buildAIMessages` always produced strings; the image-part converter was reachable only from its own unit test. New engine's text-only input port is a documented invariant (`workflows/engine/model-ports.ts:14-37`). Same real behavior in both eras. |
| Trial per-IP 20/60s burst limiter dropped | Already ruled: `docs/plans/CODEBASE-AUDIT-2026-07-18.md` F-24 — subsumed by the 5/day dual-identity cap. |
| `/auth/token-login` CSRF exemption | Already ruled safe (same audit): the 122-bit single-use, 60s POST-body token is the credential; CSRF's ambient-authority premise doesn't apply. Global CSRF coverage is broader than legacy's. |
| Unscoped user search dropped | Already ruled safe (finding IC-1, same audit): the only caller is the conversation-scoped AddMemberModal; no pre-conversation search flow exists. |
| Conversation-id collision 409 vs legacy 404 | Consistent slice-wide idempotency-conflict pattern for client-chosen ids; information content equivalent to legacy's; uuid collision contrived. Decision-class philosophy difference at most. |
| `account_deletion_events` purge `retentionDays` param dropped | Matches the codebase's own retention-constant convention (`lib/jobs/prune.ts`) and the anti-speculative-configurability doctrine; no caller ever varied it. |
| (Partial) `respondDomainError` blast radius | The duplication is real (see R19) but the "8 slices show wrong codes today" framing was cut down to 2 (billing, admin); the rest have no wireCode-bearing path yet. |

## 6. Coverage notes

- Section agents each reported an explicit clean record (files read in full) and
  "could not locate" lists; two cross-section handoffs (`resolveLinkGuestByKey` → media
  caller resolution; recovery-reset pending TTL) were covered by the owning sections.
- Billing (§06), notifications (§07), and internal tooling (§08) produced **zero**
  regression candidates — every value checked was preserved, ruled, or improved.
- Not audited here: env generation/stack orchestration/cassette *tooling* behavior beyond
  §12's scope (legacy report itself carries no section for most of it), and anything in
  `legacy/` not captured by the behavior report.
