# Backend Redesign — Wave 2a Handoff (Complete End-to-End State)

> **Purpose.** A new agent (or human) should be able to read this file alone and resume
> the backend rewrite exactly where it paused, with no missing context. It is a snapshot,
> not a plan: the plan of record is `docs/history/BACKEND-REDESIGN.md` (§20 = task list +
> dependency waves). This file records *where execution actually is* against that plan.
>
> **Snapshot taken:** 2026-06-22 · branch `main` · working tree **uncommitted** (by design).
> **Why this file exists:** three background subagents (T2.1a, T2.2a, wire-1) were killed
> mid-run by a transient `claude-fable-5` model-access error (not real task failures). They
> left substantial work on disk in varying states of completeness. The model is now restored
> (Opus 4.8 / Fable 5). This file captures precisely what is clean, what is on-disk but
> unverified, what is partial-and-red, and what was never started.

---

## 0. TL;DR — resume in one paragraph

We are executing **Wave 2a** of the backend redesign via the subagent-driven-dev skill. The
orchestrator (main session) **never writes production code** — it dispatches `sdd-implementer`
and `sdd-auditor` background agents and judges their verdicts. Every task ends on a clean
audit; ⚠️ sensitive tasks get a **three-lens panel** (correctness / security / conventions).
**Wave 1 is fully complete (20/55 §20 tasks).** In Wave 2a: **4 tasks are CLEAN** (W2a-0
Redis registry, the §19 smoke scaffold, T2.6 notifications, T2.8 account). **1 task is
on-disk-complete but unverified/unaudited** (wire-1: mounted account+notifications into
`app.ts` + 2 smoke specs). **2 ⚠️ tasks are partial and currently RED** (T2.1a identity,
T2.2a conversations) — their agents died mid-task; the `apps/api` package does not currently
typecheck/lint because of them. **3 tasks were never started** (T2.1b, T2.1c blocked on
T2.1a; T2.2b blocked on T2.2a). **Next action:** finish T2.1a and T2.2a to green (resume,
do not blind-restart — good test-first work exists on disk), then panel-audit each, then
proceed down their chains.

---

## 1. The mission and the rules (orchestrator doctrine)

- **Skill:** `subagent-driven-dev`. Main session = ORCHESTRATOR. **Writes zero production
  code.** Holds the plan + distilled subagent reports in context; never reads/writes source
  itself except to verify a verdict via a *bounded* tail of an auditor transcript.
- **Task lifecycle:** ready → implementing → auditing → (fixing → re-auditing)\* → clean.
  Cap **3 fix→audit cycles**, then escalate to the founder.
- **Audits:** every implementation is followed by an audit the orchestrator reads and agrees
  found nothing valid. ⚠️ (auth / authz / payments / crypto / user-data / deletion / uploads)
  tasks get a **3-lens panel** (correctness, security, conventions) — clean only when all pass.
- **TDD is mandatory** (red → verify red → green → refactor). Code written before its test is
  deleted. Implementers self-gate before reporting.
- **Standing founder bar:** "Absolutely no short-cuts" / "We don't want even a single quality
  flaw." Minor inherited-from-legacy findings still get fixed (see T2.8 below).
- **No git mutations by anyone** (orchestrator or subagents). Tree stays uncommitted for the
  founder. Forbidden git ops: `stash`, `checkout --`, `restore`, `reset --hard`, `clean -f`.

---

## 2. Where we are in the plan

`docs/history/BACKEND-REDESIGN.md` §20 dependency waves (verbatim structure):

```
Wave 0a/0b/0c   — DONE (Phase 0 foundation)
Wave 1 (∥)      — DONE  (T1.1·T1.2a·T1.4·T1.5·T1.7·T2.9a ; then T1.2b·T1.3)
Wave 2a (∥)     — IN PROGRESS  ← WE ARE HERE
                  [T2.1a → T2.1b → T2.1c] · [T2.2a → T2.2b] · T2.6 · T2.8
                  (+ W2a-0 Redis-registry foundation, + §19 API smoke project)
Wave 2b (∥)     — NOT STARTED  [T2.3a→T2.3b→T2.3c] · T2.4 · T2.5 ; then T2.9b→T2.9c
Wave 2c         — NOT STARTED  T2.7a→T2.7b→(T2.7c ∥ T2.7d) · T4.4a sub-spike
Wave 3 (∥)      — NOT STARTED  T3.1 · T3.3 ; then T3.2
Wave 4          — NOT STARTED  T4.1·T4.2·T4.6→T4.3→T4.4a→T4.4b→T4.8→T4.5→T4.7→T4.9
Wave 5          — NOT STARTED  T5.1→T5.2→T5.3→T5.4 (admin plane; after T4.7)
```

**Score:** 20/55 §20 tasks clean before Wave 2a. Wave 2a adds W2a-0 + smoke + T2.6 + T2.8
clean (+4 toward done), with T2.1a/T2.2a/T2.1b/T2.1c/T2.2b + wiring still open.

---

## 3. Wave 2a task board (exact status + agent IDs)

| Task | What | Status | Last agent (ID) |
|---|---|---|---|
| **W2a-0** | Typed Redis key-registry foundation (`defineKey`/`defineRateLimitKey` + `redisGet/Set/Del`) at `apps/api/src/lib/redis/` | ✅ **CLEAN** (audit PASS, 0 findings, 100×4 cov) | impl `a4e6d6df7f7e0064a`; audit `a7b3c3c07e0f534ee` |
| **smoke** | §19 API smoke project (typed-client harness + health spec + `smoke` vitest project) | ✅ **CLEAN** (audit PASS; 1 minor informational, behaviorally proven intact) | impl `ae993ec0047b28132`; audit `af16a02719833c4dd` |
| **T2.6** | notifications slice (EmailSender + Resend/console, push FCM+mock filtered by mute+presence, device-token upsert) | ✅ **CLEAN** (audit PASS; 2 minor judged — see §6) | impl `a209a225f24d65ac8`; audit `a8833f87bb0566255` |
| **T2.8** ⚠️ | account slice (user search w/ exclusion, encrypted instructions, preferences LWW) | ✅ **CLEAN** (audit PASS → 1 minor fix → re-audit PASS all dims 1.0) | impl `a215c1b404bf34f80`; audit `a38cf3fee3bedea7c`; fix `ad18b9c344caff310`; re-audit `a95bdc5cf3d7991b6` |
| **wire-1** | Mount `/account` + `/notifications` in `app.ts` + 2 smoke specs | 🟡 **ON DISK, UNVERIFIED** (agent died during final report; files present) | impl `a6093781f578167d3` (died on model error) |
| **T2.1a** ⚠️ | identity: OPAQUE + sessions + revocation | 🔴 **PARTIAL / RED** (full tree on disk; package typecheck+lint+arch RED; agent stalled) | impl `a58a15faee8bb3c41` (failed: watchdog stall) |
| **T2.2a** ⚠️ | conversations: core + epochs + rotation + MembershipVerifier | 🔴 **PARTIAL / RED** (full tree on disk; **verifier NOT composed**; agent died on model error) | impl `a2e3a067fb05d8358` (died on model error) |
| **T2.1b** ⚠️ | identity: TOTP + step-up + recovery + email-verify | ⛔ **NOT STARTED** (blocked on T2.1a) | — |
| **T2.1c** ⚠️ | identity: token-login + link-guest | ⛔ **NOT STARTED** (blocked on T2.1b) | — |
| **T2.2b** ⚠️ | conversations: shares + links | ⛔ **NOT STARTED** (blocked on T2.2a) | — |

> Agent IDs are resumable via `SendMessage({to: "<id>"})` **only while their transcripts
> exist this session**; after a session restart they are gone and a fresh implementer is
> required. The dead agents (T2.1a/T2.2a/wire-1) should be treated as needing fresh dispatch.

---

## 4. Detailed state of each task

### ✅ CLEAN — fully audited, done (do not touch)

**W2a-0 — Redis key-registry foundation.** Files (all new):
`apps/api/src/lib/redis/{define-key.ts, operations.ts, index.ts, define-key.test.ts,
operations.integration.test.ts}`. `defineKey`/`defineRateLimitKey` (Zod schema + `ttlSeconds`
+ `buildKey` with full inference); `redisGet`/`redisSet`/`redisDel` take a `Redis` instance +
definition, validate through Zod, return `ResultAsync<_, DomainError>` (validation/unavailable),
`set` applies `{ ex: ttlSeconds }`. **Helpers only — no concrete key entries** (entries live
per-slice). Legacy `redisSetRateLimitData`/`redisIncrByFloat` deliberately NOT ported
(audit-affirmed: float-increment for money would violate nano-USD doctrine). 100% per-file
coverage. This is the mechanism every slice's Redis keys must use.

**smoke — §19 API smoke project.** Files: `apps/api/src/smoke/{harness.ts, health.smoke.test.ts}`
+ a `smoke` project added to `apps/api/vitest.config.ts` (the config was restructured into
`test.projects` = `api` + `smoke`, both `extends: true`; coverage block + 95 gates +
`perFile: true` behaviorally unchanged; `src/smoke/**` excluded from the coverage denominator).
`createSmokeHarness()` boots `createApp()` with real local bindings (fail-fast from
`process.env`) and returns `{app, client, env}` where `client` is `testClient` from
`hono/testing` with response types statically inferred from `AppType`. Convention documented
in the harness doc-comment: **one `<slice>.smoke.test.ts` per wired slice.** Audit's 1 minor
finding was that the "coverage block byte-untouched" claim is unverifiable against git HEAD
(HEAD predates the whole rewrite) — but the 95 gates were proven live-intact; no fix needed.

**T2.6 — notifications slice.** Tree: `apps/api/src/slices/notifications/**` —
`index.ts` (barrel), `routes.ts` (manifest basePath `/notifications`, device-token routes,
all `routeClass('session')`), `ports/{EmailSender,PushSender,PresenceReader,MembershipReader,
DeviceTokenStore}`, `adapters/{email-resend(+evidence),email-mock,email factory,push-fcm,
push-mock,push factory,device-token-store-db}`, `domain/{device-tokens,session-claims,wire,
push-recipients,notify-message,templates/*}`. Also: `packages/db/src/evidence.ts` gained
`SERVICE_NAMES.RESEND: 'resend'` (+ integration test). 146 tests. Resend = HTTP `fetch`
adapter (no npm pkg); writes a service-evidence row when `isCI`. Push filtered by mute AND
presence. Idempotent device-token upsert (`idempotent.byUpsert`). FCM keeps a module-level
OAuth token cache (audit-affirmed as a recoverable optimization, not state-of-record).
**Two carried-forward facts** (see §6): the `PresenceReader`/`MembershipReader` ports are
**unbound** (no consumable conversations barrel yet — bind at composition/chat-slice time,
never silently to fakes); the dev verification-link console echo was dropped (raw console is
lint-banned in slices) — **T2.1b must restore a dev-only exposure or local signup is
uncompletable.**

**T2.8 — account slice** (⚠️, audited + fixed + re-audited clean, all dims 1.0). Tree:
`apps/api/src/slices/account/**` — `ports/stores.ts` (UserDirectory/InstructionsStore/
PreferencesStore + `isActiveMember`), `adapters/stores.ts` (drizzle: left-join exclusion
search, `INSERT…ON CONFLICT` upserts, atomic LWW guard via `setWhere stored.updatedAt <=
incoming`, `isActiveMember` authz read), `domain/{principal,user-search,instructions,
preferences,index}.ts`, `routes.ts` (basePath `/account`, 6 routes, all `routeClass('session')`),
`index.ts`. 70 tests, 100% per-file. **Key fix applied:** user-search now gates on the
caller's active membership of the supplied `conversationId` (was a membership-probe infoleak
inherited from legacy); non-member / former-member / nonexistent-conversation all collapse to
one indistinguishable `403 {code: FORBIDDEN}` (no existence oracle). Deliberate legacy
divergences (all audit-affirmed): search is GET w/ required conversationId; LIKE
metacharacters escaped; clear via DELETE; stale LWW returns authoritative state. Instructions
blob cap = **32 KiB decoded** (43,691 base64 chars; rejects, not truncates; exact arithmetic).

### 🟡 ON DISK, UNVERIFIED — needs verification + audit before it counts

**wire-1 — mount account+notifications.** The agent **completed its file writes** before
dying during its final report. Confirmed on disk:
- `apps/api/src/app.ts` now chains `.route(accountManifest.basePath, accountManifest.routes)`
  and `.route(notificationsManifest.basePath, notificationsManifest.routes)` after the health
  mount (chained, not looped — preserves `AppType` inference).
- `apps/api/src/smoke/account.smoke.test.ts` and `notifications.smoke.test.ts` exist.

**It has NOT been verified green or audited.** Because it mounts two already-clean slices,
it is likely fine — but it must be run (`pnpm --filter @hushbox/api test --project smoke` +
package typecheck) and audited before being marked clean. **Caveat:** the package as a whole
will not typecheck right now because of T2.1a/T2.2a (see below), so wire-1 can only be fully
gated *after* identity/conversations are green — or verified in isolation against just the
smoke project. Verify that `app.ts` imports the two manifests from the slice **barrels**
(`./slices/account/index.js`, `./slices/notifications/index.js`), not internals.

### 🔴 PARTIAL / RED — agents died mid-task, work incomplete

**T2.1a — identity: OPAQUE + sessions** (⚠️). Agent `a58a15faee8bb3c41` **stalled** (watchdog,
no progress 600s) near the end ("Now the moved test files for sessions and revocation…").
Full tree exists on disk:
`apps/api/src/slices/identity/` → `index.ts`, `routes.ts`, `routes.integration.test.ts`,
`domain/{index,login,registration,opaque,opaque.test}.ts`,
`adapters/{auth-state(+integration.test),keys(+test),revocation(+integration.test),
sessions(+integration.test),stores(+integration.test)}.ts`,
`ports/{auth-state,sessions,stores,index}.ts`.
**Cross-cutting (T2.1a was exclusive owner this wave):** `apps/api/src/middleware/
pipeline-session.ts` was edited for revocation wiring, and `apps/api/src/lib/context/principal.ts`
was in its ownership.
**CURRENT STATE = RED.** As observed by the T2.6/T2.8 audits running concurrently:
- typecheck errors: `src/middleware/pipeline-session.ts:40` (TS7030, not-all-code-paths-
  return), `src/slices/identity/routes.integration.test.ts` (TS6133 unused / TS2307 cannot
  find module).
- lint: ~116 errors, all under `src/slices/identity/**`.
- `arch:check`: 2 violations at `apps/api/src/slices/identity/routes.ts:72` (likely an
  idempotency-wrapper lexical-visibility miss, or a routes→lib import).
- `routes.ts` shows a malformed import in the on-disk snapshot (`import { match } 'ts-pattern'`
  — missing `from`) — at least one syntax-level breakage is present.
**Not yet verified:** whether the OPAQUE round-trip / enumeration-safety / revocation-across-
route-classes tests actually pass. Treat T2.1a as **incomplete**: it must be driven to green
(all acceptance criteria in the brief) and then **panel-audited**. Brief acceptance criteria
are reproduced in §7.

**T2.2a — conversations: core + epochs** (⚠️). Agent `a2e3a067fb05d8358` **died on the model
error** after ~44 min / 162 tool-uses. Full tree exists on disk:
`apps/api/src/slices/conversations/` → `index.ts`, `routes.ts`, `routes.integration.test.ts`,
`domain/{conversations,members,rotation(+test),parent-chain(+test),eviction,outcomes(+test),
principal,schemas(+test),index}.ts`,
`adapters/{stores,membership(+integration.test),membership-verifier,realtime-do(+test),
realtime-room,realtime-room-bindings(+test)}.ts`,
`ports/{realtime,revocation,stores,index}.ts`.
**CRITICAL INCOMPLETENESS:** `adapters/realtime-room-bindings.ts:87` **still calls
`createUnboundVerifier()`** — the real MembershipVerifier composition (Redis cache + Drizzle
source replacing the throwing placeholder) was **deliverable #7 and was NOT wired in.** The
`membership.ts` / `membership-verifier.ts` building blocks exist but are not composed at the
binding site. This is the single biggest gap.
**Also RED:** `domain/outcomes.test.ts` had a typecheck error; `domain/rotation.test.ts` had
a load failure — both observed during concurrent audits. Treat T2.2a as **incomplete**: finish
the verifier composition, drive to green, then **panel-audit**.

### ⛔ NOT STARTED

- **T2.1b** ⚠️ (blocked on T2.1a): TOTP setup/verify/disable, step-up, password change
  (writes the `auth:pw-changed:${userId}` key that T2.1a's read-side enforcement consumes),
  recovery flows (enumeration-safe wrapped-key retrieval), email verification + resend,
  TOTP/deletion lockouts. **MANDATORY add (from T2.6 audit):** when binding identity→email,
  add a dev-only exposure for the verification link (debug endpoint or dev-gated structured
  log) — the notifications email-mock's `getSentMessages()` is instance-held and the factory
  builds a fresh mock per call, so local signup is otherwise uncompletable.
- **T2.1c** ⚠️ (blocked on T2.1b): billing-portal token login (token-is-key), link-guest
  principal. (T2.1a already built the billing-only session *issuance* helper + the principal
  reaches only `billing-token` routes; T2.1c consumes it.)
- **T2.2b** ⚠️ (blocked on T2.2a): shared links, shared messages (+`createdBy` severing on
  deletion), public share read, revoke + expiry endpoints (enforced lazily at read), link
  privileges; the share endpoint asserts a rate-limit registry entry (enforcement itself is
  T4.1).

---

## 5. The blocking fact: `apps/api` is currently RED

As of this snapshot, `pnpm turbo typecheck lint --filter=@hushbox/api` **fails**, and
`arch:check` reports violations — **entirely** because of the incomplete T2.1a (identity) and
T2.2a (conversations) trees. The 4 clean tasks + wire-1 are individually green and were
each verified against their own files with concurrent-agent failures attributed out-of-scope.
**The package gate cannot pass until identity + conversations are completed (or their trees
removed).** Do not interpret the current red package as a regression in the clean work.

---

## 6. Findings judged but not fixed (orchestrator rulings)

- **T2.6 / evidence-file diff attribution (minor).** The working-tree diff on
  `packages/db/src/evidence.ts` + `scripts/verify-evidence.ts` exceeds T2.6's claim
  (EvidenceConfig interface removed, unit test → integration test, `createDb` signature fix).
  **Ruling:** those extra lines belong to the prior service-evidence *restoration* task
  (audited last session), not T2.6; T2.6 added only `SERVICE_NAMES.RESEND` + its test. db
  package is green at 100%. **No action.**
- **T2.6 / dev verification-link echo dropped (minor).** Real but unreachable today (slice
  unmounted at the time; identity unwired). **Ruling:** pinned as a **mandatory requirement
  on T2.1b** (see §4 / §7). Not a T2.6 fix.
- **T2.6 / unbound PresenceReader + MembershipReader ports.** Audit-affirmed genuinely
  unreachable today. **Ruling:** bind at composition/chat-slice time; never silently bind to
  fakes. Tracked open.
- **T2.8 / membership-probe infoleak (minor, inherited from legacy).** **FIXED** (not waved
  through — founder's zero-flaw bar) and re-audited clean.

---

## 7. Reproduced acceptance criteria for the two RED tasks

So a resumer needs no other file for these. (Full briefs were in the orchestrator's dispatch;
these are the audit contracts.)

**T2.1a identity — acceptance:**
1. Full OPAQUE register→login round-trip integration test using the **real** `packages/crypto`
   client+server (no mocked crypto), real local Postgres/Redis.
2. Enumeration safety: login-start for a nonexistent identifier returns the same shape/status
   as real-user-wrong-password (fake-registration-record path exercised).
3. Revoked/stale cookies rejected on **every** authenticated route class (session, pending-2fa,
   billing-token): parameterized over (a) logout-revoked, (b) sessionActive absent/expired,
   (c) issued-before-pw-changed-at.
4. TOTP-enabled user's login → **pending-2fa** session reaching only pending-2fa routes;
   non-TOTP login → **full**.
5. Locked account (`users.lockedAt`) cannot log in (typed error).
6. Per-identifier registration/login rate limits enforced (typed error; window/attempts asserted).
7. Pending OPAQUE state is TTL-bound in Redis and single-use (replay of consumed state fails).
8. No secret material in any log call; all error paths return `{code}` via `createErrorResponse`.
9. 95% per-file coverage; all routes exercised through the pipeline.
- Scope: owns `slices/identity/**`, plus `lib/context/principal.ts` + the session stage of
  `middleware/pipeline-session.ts`/`pipeline.ts` (revocation wiring), + anchored additions to
  `packages/shared/src/error-codes.ts`. Billing-only session **issuance** helper lives here
  (consumed by T2.1c). OUT of scope: TOTP/step-up/recovery/email-verify (T2.1b), token-login/
  link-guest (T2.1c) — except login of a TOTP-enabled user must mint a pending-2fa session.

**T2.2a conversations — acceptance:**
1. Rotation is **atomic**: one transaction inserts the new `epochs` row (previousEpochId chain
   + chainLink/confirmationHash) + all `epochMembers` wraps + bumps `conversations.currentEpoch`;
   mid-rotation failure leaves no partial state; concurrent rotations serialize (test).
2. Epoch FK chain enforced (previousEpochId; epochNumber unique per conversation; wrap to a
   stale epoch rejected).
3. Fork-tip concurrency: two concurrent tip updates → exactly one wins (expected-state
   conditional write), no corruption.
4. Removed member: Redis membership-cache entry evicted (real Redis) + `evict()` invoked (port
   seam) + verifier returns revoked next check; non-member cannot read or write anything.
5. Full-history vs rotation `visibleFromEpoch` semantics tested for both add paths.
6. Member limit enforced (typed error).
7. Mute/pin updates are member-scoped (cannot set another member's flags).
8. 95% per-file coverage; all routes through the pipeline; no check-then-act anywhere.
- **#7 composition (THE GAP): replace `createUnboundVerifier()` in
  `adapters/realtime-room-bindings.ts` with `createCachedMembershipVerifier` from
  `@hushbox/realtime`**, composed with a Redis-backed `MembershipCache` (using the W2a-0
  `apps/api/src/lib/redis/` mechanism) + a Drizzle `MembershipSource` (active = `leftAt IS
  NULL`). **freshnessMs must be ≪ cacheTtlSeconds** — pick and justify principled values.
  Integration tests: cache hit within freshness, DB recheck on miss, removed→revoked after
  eviction, source failure → bounded last-known-good then **pause** (never un-revoke).
- Scope: owns `slices/conversations/**` (evolve in place — realtime adapters predate this
  task) + anchored `error-codes.ts` additions. Consume `packages/realtime` + `packages/db`
  (no edits). OUT: shares/links (T2.2b), messages/content (chat slice owns `messages`; read-only).

---

## 8. Founder rulings in force (binding, do not re-litigate)

- **CI may be red until the end of the run** — focus on **local** tests passing. (CI's e2e +
  legacy integration suites are dark until Phase 4 by design.)
- **Stryker (mutation testing): skip entirely** — won't-fix for this run.
- **backup.yml is known-broken — ignore it forever**; never re-surface it.
- **Blanket permission to update dependencies**, even proactively.
- **New env vars require founder approval before adding** (some are better hard-coded). No new
  env var has been needed in Wave 2a so far.
- **Frontend coverage (web / ui / marketing): deferred to Phase 4 (T4.5).** Backend packages
  hold the 95% line now.
- **`legacy_` corpus type-drift is a transient state** that dies at T4.7 (corpus deleted) —
  documented in the plan; the TECH-STACK standard is untouched, not degraded.
- **Guest typing relay:** leave as-is (revisit at T2.7).
- **`.md` files are read-only** without explicit per-file grant. (This handoff file was
  explicitly requested, so writing it is authorized; `docs/history/BACKEND-REDESIGN.md` edits
  need a grant — the prior as-built-facts grant covered specific amendments already made.)
- **Tree stays uncommitted**; the founder commits. Never commit/push without per-action approval.

---

## 9. Open founder actions (not the orchestrator's to do)

1. **Provision the `SENTRY_DSN` GitHub secret** before the next deploy (the workflow expects it).
2. **Commit the entire uncommitted rewrite tree** when ready — it is large. (Committing also
   settles the seed-crypto corpus at 81 tracked files; 81 of 162 were already deleted on disk
   pre-run, inert, reader demoted; restoring would need forbidden git ops.)

---

## 10. Key infrastructure map (so a fresh implementer can build)

**Slice anatomy.** Template at `apps/api/src/slices/_template/**`. A slice exposes routes via
a manifest: `routes.ts` exports `create<Name>Manifest(deps)` returning
`defineSliceManifest({ basePath, routes })` (from `apps/api/src/middleware/pipeline-manifest.ts`,
alongside `routeClass`). The slice **barrel `index.ts` is the only public surface.** Mount =
**one chained `.route()` line in `apps/api/src/app.ts`** (chained, not looped — preserves
`AppType` inference). `app.ts` is the composition root and is owned only by wiring micro-tasks.

**Default-deny pipeline** (`apps/api/src/middleware/pipeline*.ts`). Stages: env → bindings
(fail-fast DI) → session → authorize → idempotency-key. Route classes (closed set):
`public | session | pending-2fa | billing-token | dev-only`. Every route declares one via
`routeClass(...)`; unmarked → default-denied. `dev-only` answers 404 in production
byte-identically to a missing route. DI via `c.var`: `envUtils, bindings, db, redis, logger,
principal`. `Principal` kinds: `none | pending-2fa | billing-only | full` (in
`apps/api/src/lib/context/principal.ts`: `SessionClaims`, `parseSessionClaims`, `derivePrincipal`).

**lib surface.**
- Errors: `createErrorResponse(code, details?)` (`apps/api/src/lib/errors/`); codes +
  `friendlyErrorMessage` map in `packages/shared/src/error-codes.ts` (`ERROR_CODES`,
  `DOMAIN_ERROR_CODE_TO_WIRE_CODE`). New code needs the constant AND the message entry.
  **This file is a concurrent-edit hotspot — anchored single-insertion Edits only, re-read
  immediately before each edit, never rewrite wholesale.**
- Result: `apps/api/src/lib/result/` re-exports neverthrow.
- Resilience: `apps/api/src/lib/resilience/policies.ts` (`retryPolicy`/`timeoutPolicy`/
  `retryWithTimeoutPolicy`); raw `cockatiel` importable only by the factory (lint-enforced).
- Idempotency: `apps/api/src/lib/idempotency/index.ts` — the 5 wrappers
  `idempotent.{byKey,byUpsert,byTransition,byEventId,byExternalPreClaim}`; `runMutation`
  accepts only `Idempotent<T>`. Boundaries lint forbids routes→lib, so slices re-publish
  `createErrorResponse`/`idempotent`/`runMutation` through their `domain/index.ts` barrel
  (the established `_template` pattern — keeps wrappers lexically visible at the route seam
  for `arch:check`). Never check-then-act: `UPDATE … WHERE expected_state`, assert rows.
- Redis: **use the W2a-0 mechanism** `apps/api/src/lib/redis/` (`defineKey`,
  `defineRateLimitKey`, `redisGet/Set/Del`). Define entries **per-slice** (e.g.
  `slices/<name>/keys.ts`). Session revocation is **Redis-tracked** (legacy keys
  `sessions:user:active:${userId}:${sessionId}`, `auth:pw-changed:${userId}`) — there are NO
  `passwordChangedAt`/`sessionActive` columns on `users`. No migration needed for sessions.
- Telemetry: `c.var.logger` is `SafeLogFields` — `msg` is a compile-time literal; allowlisted
  fields only; `captureError(error, code)`. **Never log** content, prompts, tokens, cookies,
  emails, keys, ciphertext, PII.

**Ports / adapters that exist.** `ModelProvider` (models slice), `PaymentProvider` (billing,
Helcim+mock), `Storage` (media, S3/MinIO+R2), `RealtimeBroadcast` (conversations →
ConversationRoom DO). `EmailSender` + `PushSender` now exist (T2.6 notifications).

**packages/db schema** (`packages/db/src/schema/`, no migrations this wave): `users` (id,
email uq, username uq varchar20, emailVerified, opaqueRegistration bytea, totpSecretEncrypted,
totpEnabled, hasAcknowledgedPhrase, publicKey/passwordWrappedPrivateKey/recoveryWrappedPrivateKey
bytea, lockedAt+lockReason, deletionRequestedAt); `verificationTokens`; `deviceTokens`
(platform ios|android); `conversations` (userId owner, title bytea, titleEpochNumber,
currentEpoch, nextSequence, budgetNanoUsd); `conversationMembers` (privilege enum,
visibleFromEpoch, joinedAt/leftAt/acceptedAt, muted, pinned; unique-active where leftAt IS
NULL); `epochs` (conversationId+epochNumber uq, previousEpochId self-FK, epochPublicKey/
confirmationHash/chainLink bytea); `epochMembers` (memberPublicKey uq per epoch, wrap bytea,
visibleFromEpoch); `messages` (READ-ONLY for conversations — chat owns it); `conversationForks`
(name uq per conv, tipMessageId FK SET NULL); `sharedLinks`/`sharedMessages`;
`customInstructions` (userId uq, encryptedInstructions bytea); `preferences` (userId uq,
accessibility jsonb); `serviceEvidence` (id/service/details jsonb/createdAt). Helpers:
`recordServiceEvidence(db, isCI, service, details?)`, `verifyServiceEvidence`, `SERVICE_NAMES`
(now includes RESEND) in `packages/db/src/evidence.ts`. Client: `createDb(connStr, {neonDev?,
injectLatencyMs?})` → `Database`. Member privileges: `MEMBER_PRIVILEGES` single source in
`packages/shared/src/member-privilege.ts`.

**packages/crypto** (consume; STOP+report if a helper is missing): `opaque-server.ts`
(`createOpaqueServerFromEnv`, `deriveServerCredentials`, `createFakeRegistrationRecord`,
`OPAQUE_SERVER_IDENTIFIER`), `opaque-client.ts` (`createOpaqueClient`, start/finish
Registration/Login — for tests), `wrap.ts` (`wrapSecretTo`/`unwrapSecret`), `envelope.ts`
(`encryptContentEnvelope`/`decryptContentEnvelope`), `totp.ts`, `recovery-phrase.ts` (BIP39).

**packages/realtime** (consume; no edits): `conversation-room.ts`
(`createConversationRoomClass`, `RoomBindings`), `room-core.ts`, `job-dispatcher*.ts`,
`revocation.ts` (`createCachedMembershipVerifier({cache, source, freshnessMs, lastKnownGoodMs,
cacheTtlSeconds, now})`, `MembershipCache`/`MembershipSource` interfaces,
`MembershipDecision = 'member'|'revoked'|'pause'`). DO binding name in apps/api wrangler:
`CONVERSATION_ROOM` + `JOB_DISPATCHER`. `FlowExecutor` seam in `packages/shared/src/flow-executor.ts`.

**Env** (`packages/shared/src/env.config.ts`, per-mode values, no `??` fallbacks): auth-related
`OPAQUE_MASTER_SECRET`, `IRON_SESSION_SECRET` (both in `RequiredBindings`,
`apps/api/src/lib/context/bindings.ts`); `RESEND_API_KEY`, `FCM_PROJECT_ID`,
`FCM_SERVICE_ACCOUNT_JSON` (prod secrets; dev/test use console/mock). Session cookie:
name `hushbox_session`, 30-day max age (legacy-compatible).

**Tests.** Integration-first against real local infra (`pnpm db:up` starts Postgres :5432,
Neon proxy :4444, Redis :6379, SRH :8079, MinIO :9000). Integration suffix
`.integration.test.ts`; they read `DATABASE_URL`/`UPSTASH_*` via the `scripts/with-env.ts`
wrapper — **bare `pnpm exec vitest …` bypasses with-env and the integration files fail-fast by
design** (use `pnpm --filter @hushbox/api test <path>`). Coverage: static `coverage.include`
in `apps/api/vitest.config.ts` + `thresholds.perFile: true` (so a never-imported 0% file
can't hide in an average). AI calls in CI are cassette-replay only (no charged real calls).

---

## 11. Verification commands

```bash
# Per-slice (use the with-env wrapper, NOT bare vitest exec):
pnpm --filter @hushbox/api test src/slices/identity
pnpm --filter @hushbox/api test src/slices/conversations
pnpm --filter @hushbox/api test src/slices/account        # 70/70 green
pnpm --filter @hushbox/api test src/slices/notifications  # 146 green
pnpm --filter @hushbox/api test --project smoke           # health+account+notifications smoke

# Package gates (currently RED on identity+conversations only):
pnpm turbo typecheck lint --filter=@hushbox/api
pnpm turbo test:coverage --filter=@hushbox/api            # exit 0 once 2a is green
pnpm arch:check

# Sibling packages touched this wave (green):
pnpm turbo typecheck lint test:coverage --filter=@hushbox/db
pnpm turbo typecheck lint test:coverage --filter=@hushbox/shared

# Local infra:
pnpm db:up
```

Scoped duplication for a task: `jscpd --threshold 2 <changed-paths>` (not whole repo).
Whole-repo `pnpm lint:unused` (knip) is noisy mid-wave — defer to the Phase-4-style close pass.

---

## 12. Recommended resume procedure

1. **Finish T2.1a (identity).** Dispatch a fresh `sdd-implementer` (background) with a brief
   that says: *substantial test-first work exists on disk from an interrupted run; assess it,
   complete it to green against the §7 acceptance criteria, do not blind-restart.* It owns
   `slices/identity/**` + `lib/context/principal.ts` + the session stage of
   `middleware/pipeline-session.ts`/`pipeline.ts` + anchored `error-codes.ts`. First job:
   fix the syntax/typecheck breakage (e.g. the malformed `ts-pattern` import in `routes.ts`,
   the TS7030 in `pipeline-session.ts:40`, the arch violation at `identity/routes.ts:72`),
   then drive every acceptance test green. Then **3-lens panel audit**.
2. **Finish T2.2a (conversations) in parallel** (disjoint files). Same framing. **The headline
   gap: compose the real MembershipVerifier** (replace `createUnboundVerifier()` at
   `adapters/realtime-room-bindings.ts:87`) per §7 #7; fix `outcomes.test.ts` typecheck +
   `rotation.test.ts` load failure; drive green. Then **3-lens panel audit**.
3. **Verify + audit wire-1** once the package is green (or in isolation via the smoke project
   now). It is the last gate before account/notifications are "wired and proven end-to-end."
4. **Then the chains:** T2.1a clean → dispatch **T2.1b** (carry the mandatory dev
   verification-link exposure requirement; it writes `auth:pw-changed`); T2.1b clean → **T2.1c**.
   T2.2a clean → **T2.2b**. Each ⚠️, each panel-audited. Wire each into `app.ts` + a smoke spec
   via a serialized micro-task as it goes clean.
5. **Wave 2a closes** when all of T2.1{a,b,c} + T2.2{a,b} + T2.6 + T2.8 + wiring are clean and
   a **final unscoped pass** (typecheck, lint, all `test:coverage`, jscpd, knip, arch over the
   non-legacy tree) is green except the founder-accepted exceptions (e2e dark; web/ui/marketing
   coverage deferred). Then **Wave 2b**: `[T2.3a→b→c] · T2.4 · T2.5 ; then T2.9b→T2.9c`.

**Resumption hygiene:** the dead agents' IDs (T2.1a `a58a15faee8bb3c41`, T2.2a
`a2e3a067fb05d8358`, wire-1 `a6093781f578167d3`) are only `SendMessage`-resumable while this
session's transcripts persist; after a restart, dispatch fresh implementers. Never let a fix go
unaudited; cap 3 fix→audit cycles then escalate.

---

## 13. Persistent trackers

- **Orchestrator ledger:** harness Task **#4** ("Wave 2a execution state") holds the live
  per-task status map + agent IDs + audit notes + open items in its metadata. Keep it current.
- **Memory** (`/home/dev/.claude/.../memory/`): `backend-redesign-status.md` (execution
  status), `git-commit-only-on-explicit-request.md`, `deps-update-permission.md`,
  `e2e-system-architecture.md`, `e2e-hardening-decisions.md` — indexed in `MEMORY.md`.
- **Plan of record:** `docs/history/BACKEND-REDESIGN.md` (§19 = test/early-signal seams; §20 =
  task list + dependency waves). Amendments already written this run: service-evidence
  retention (2026-06-12), e2e-red disposition, as-built deltas (dispatch-from-outputs, flex
  service tier, SafeLogFields +jobType/attempt), corpus type-drift note.
```
