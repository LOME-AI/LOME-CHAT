# Full Codebase Audit — 2026-07-18

**Scope:** complete legacy→new parity map (legacy = GitHub `origin/main` @ `fce35f4d`, the
deployed monolith directly before the backend refactor) plus deep audits of crypto, DB
schema, env-var discipline, single-source-of-truth, security, testing fidelity, admin
plane, OpenRouter, infra, e2e, and overall quality. Produced by a fleet of read-only
exploration subagents; every nontrivial claim carries file:line evidence and was
**Verified** against read source — remaining unknowns are explicit founder questions
(§25), not soft assertions. Checks (tests/typecheck/lint) were NOT run — reported green
repo-wide by the founder.

**Legend:** ✅ retained · ⚠️ changed · ❌ missing (regression candidate) · 🗑 intentionally
dropped · ➕ new (no legacy counterpart) · 🔴 critical · 🟠 major · 🟡 minor · ⚪ info

## 1. Executive summary

**Parity verdict: the rewrite is a faithful, mostly-stronger superset of the legacy monolith.** Every legacy route, gate, lockout, enumeration defense, rotation trigger, and email has a located counterpart (§2); OPAQUE is byte-identical with the challenge-state race fixed (§5); crypto stays 100% inside `packages/crypto` with a strictly stronger AAD envelope (§3/§4); the settlement core — lock order, atomicity, zero-sum trigger, fences, admission Lua, cost circuit — verified clean end-to-end (§2.H); Smart Model, token ratios, and the cassette store are exact-parity (§16/§10/§17). The only outright behavioral regression found: the password-reset email subject changed (Q11). (An earlier draft claimed the trial per-identity 5/day quota was dropped — **corrected**: it is fully retained; the $50/day pool is purely additive. See RL-1.) Everything else that differs is either founder-ruled design or a verified improvement.

**The three criticals are all about proof, not product:** nothing confines `@sentry/*` imports to the scrubbing adapter (SE-1), the real `settle()`/jobs pass has never been composed inside a Durable Object under workerd (JD-1), and the promised randomized settlement crash-injection suite doesn't exist (JD-2). The money code *looks* correct under line-by-line verification; these three close the gap between "verified by reading" and "verified by machine."

**Structural themes across the 🟠 tier:** (1) *enforcement gaps in otherwise-strong walls* — admin reversibility battery not mandated (AD-1/2), idempotency rule blind to non-exempt handlers (WF-3), Prettier unenforced (CI-1), pre-push cache masking (CI-2), watcher-less metrics (SE-2); (2) *the frontend's manual type bridge* — RPC response inference is vacuous on all 119 handlers, compensated by 69 hand-written casts (FE-1), plus auth-path fetch bypasses (FE-2) and no centralized 401 handling (FE-3); (3) *cutover debris* — Vercel-gateway env still shipped (OR-2), dual error-copy systems (ENV-8/FE-4), dual privilege-enum homes (DUP-1), `legacy*`-named live exports (LEG-1); (4) *new-surface hardening* — WS-upgrade Origin check (SEC-1/Q4), admin SPA headers (SEC-2), Overlay/Sheet overflow (UI-1/2), store deep-link placeholders (MK-1).

16 decisions need the founder (§25); every other finding carries a concrete recommended fix. Full ranked list: §24. Actionable work: the backlog below.

## Improvement backlog

The complete actionable list, self-contained. 🔴 first, then 🟠 grouped by theme, then a compact 🟡 table. Effort: S (<½ day) / M (a day-ish) / L (multi-day). Founder-decision items live in §25, not here.

### 🔴 Critical

1. **Confine Sentry imports to the telemetry adapter** *(SE-1, §9 — S)*. Nothing stops `import * as Sentry from '@sentry/cloudflare'` outside `lib/telemetry/adapters/`, which would bypass `scrubSentryEvent` and could ship message content to Sentry — the single guarantee the whole telemetry design exists to give. Fix: clone `no-external-cockatiel.mjs` into a `no-external-sentry` vendored rule; one test.
2. **Compose the real jobs pass + `settle()` inside a DO under workerd** *(JD-1, §13 — L)*. Today workerd tests use scripted fakes and `do-finalize` proves only a generic transaction; driver/waitUntil/connection differences between node and the production runtime are invisible exactly where money settles. Fix: vitest-pool-workers binding that runs the real executor + neon-proxy through `runDurableObjectAlarm`.
3. **Build the randomized settlement crash-injection suite** *(JD-2, §13 — L)*. The design doc promises crash-between-every-statement-pair fuzzing of settle × retry-claim × cancel; only ONE deterministic crash point is tested. Fix: seeded fuzzer (reuse `seeded-prng.ts`) against real PG asserting exactly-once + saved⟺billed under every interleaving.

### 🟠 Enforcement gaps (walls that don't fully close)

4. **Mandate the admin reversibility battery** *(AD-1, §14.3 — S)*: `describeAdminOp` registers `contract.name` into a module set; an aggregate test asserts equality with `ADMIN_OP_NAMES`. Today a new op ships with zero reversibility tests and green CI.
5. **Registry-driven undo round-trip harness** *(AD-2, §14.3 — M)*: per-op fixtures + generic snapshot→execute→undo→snapshot equality; a durable op with neither fixture nor justified exclusion fails the build. Inverse *existence* is enforced; inverse *correctness* is still convention.
6. **Close the idempotency-rule blind spot** *(WF-3, §2.H.8 — M)*: the arch rule inspects only declared-exempt routes; nothing statically proves a non-exempt mutating handler calls `runMutation`/`idempotent.*`, nor bans external calls inside a plain DB tx.
7. **Enforce Prettier** *(CI-1, §18 — S)*: add `format:check` to CI and pre-commit; fix the false claim in `docs/DEVELOPMENT.md:43`.
8. **Un-mask the pre-push test gate** *(CI-2, §18 — S)*: add `TURBO_FORCE` to the pre-push test task; warm cache currently replays green results and skips the coverage gate locally.
9. **Metric watcher registry** *(SE-5 + SE-3/SE-4, §9 — M)*: METRIC_NAMES registry + arch test that every metric names a live watcher; route recurring catalog exclusions to WAE digest instead of hourly Sentry; extend no-silent-catch so defects must captureError.
10. **Alarm-semantics + idle-step tests** *(JD-3/JD-4, §13 — M)*: miniflare timer-advance to exercise real alarm delivery/retry and the eviction-mid-decay idleStep path — everything today force-fires.

### 🟠 Frontend type bridge & auth paths

11. **Restore server→client response typing** *(FE-1, §2.G.2 — L)*: make the per-slice `respond*` tails return `TypedResponse` (or add client `Extract`+200 narrowing); today all 119 handlers contribute nothing to `AppType` and 69 `fetchJson<T>` casts carry the contract by hand — start with the locally-redeclared `MeResponse`/`KeyChainResponse` drift risks.
12. **Route OPAQUE/2FA fetches through the header shim** *(FE-2, §2.G.1 — S)*: 14 raw `fetch()` sites skip `X-App-Version`/platform headers, so auth traffic can't receive the 426 upgrade gate.
13. **Centralize mid-session 401/revocation** *(FE-3, §2.G.6 — M)*: add a `QueryCache.onError` (or fetch-layer) global handler that clears auth and redirects; today a revoked session just throws into whichever hook fires next.
14. **Finish the friendlyErrorMessage migration** *(FE-4/ENV-8, §2.G.8 — M)*: 6 web files + 1 packages/ui hook still consume `legacyFriendlyErrorMessage`/`ERROR_CODE_*`; migrate, then rename the `legacy*` exports (LEG-1).
15. **Fix the version-check error contract** *(ENV-7, §7.4 — S)*: move `currentVersion`/`updateUrl` under `details` — the only route violating strict `{code, details?}`.

### 🟠 Cutover debris (delete/rename)

16. **Delete the Vercel-gateway remnants** *(OR-2/DEAD-1, §15.3 — S)*: `PUBLIC_MODELS_URL` (shipped to Production!), `fetchModels`/`toRawModel`/`clearModelCache`, `SERVICE_NAMES.AI_GATEWAY`, stale `--require=ai-gateway` docs (CAS-2).
17. **Unify the privilege vocabulary** *(DUP-1, §10+21 — S)*: migrate `enums.ts` consumers to `member-privilege.ts`, delete the dual zod enum; also extract the byte-identical media MIME maps (DUP-4) into one shared const.
18. **Migrate the live VEO helpers, then delete capabilities.ts constants** *(OR-1 — M)*: `getSupportedVideo*` is live in `web/stores/model.ts` — move web to catalog-derived data first; the Imagen pair + dead enums.ts groups (DEAD-2) delete today.
19. **Delete `provisionUserBilling`** *(EM-1 — S)*: verified dead; removes the latent double-welcome-email path.

### 🟠 New-surface hardening

20. **Admin SPA security headers** *(SEC-2, §12 — S)*: the authed admin document ships no CSP/XFO/HSTS; add a `_headers` generator like web's.
21. **Overlay/Sheet overflow hardening** *(UI-1/UI-2, §2.I.4 — S, pending Q16)*: push the Dialog `max-h`/`overflow` fix into `SheetContent` + `OverlayDialog`/`OverlayContent`.
22. **Route harness-bypassing e2e specs through fixtures** *(E2E-1, §20 — M)*: demo/marketing/persona specs import raw `@playwright/test`, losing console/network auto-fail; add a lint ban.
23. **Fill the e2e coverage holes** *(E2E-2, §20 — L)*: 2FA recovery codes, user media upload, explicit stop-active-stream, marketing pages, Capacitor shell.
24. **Assert Resend + FCM in CI** *(CAS-3, §17 — M)*: both have evidence adapters but are mocked/unasserted; wire sandbox or evidence-require.

### 🟡 Minor (compact)

| Item | Source | Fix |
|---|---|---|
| Trial/classifier token estimates re-implement `ceil(chars/ratio)` | TE-1 §10 | route through `estimateTokensForTier` |
| 5 env existence-branches (cors.ts, payment-form, sidebar-footer, drizzle.config, admin-nav) + 3 stale comments | ENV-1…6 §7 | branch on mode / fail-fast; fix comments |
| Nano→dollar render ×4, `utcDayKey` bypass ×2, web PRIVILEGE_ORDER | DUP-3/5/2 §10+21 | import the canonical helpers |
| FCM RS256 signing outside packages/crypto; 5 keyless sha256 sites | CR-5/6 §3 | relocate or document carve-out |
| WS reconnect backoff lacks jitter | FE-5 §2.G.7 | reuse shared jittered backoff |
| 6 ad-hoc query keys; non-zod `validateSearch` | FE-6/7 §2.G | factories + zod schemas |
| `.astro` outside a11y lint wall; rAF ban `.tsx`-only; admin skip link | UI-4/6/7 §2.I | extend globs; add link |
| AASA↔allowlist mismatch; no `404.astro`; robots.txt noise | MK-3/4/5 §2.J | align lists; add page; prune allows |
| Conditional no-op e2e assertions; serial describes from shared personas | E2E-3/4 §20 | assert unconditionally; per-worker users |
| `maxTargets` guardrail unimplemented; 3 ops missing interleaving test | AD-3/4 §14 | implement or delete field; add tests |
| Scrub-allowlist regression test; client-SDK lint ban | SE-6 §9 | add both |
| Cassette/typecheck stale docs (`ERROR_CODE` schema paths, type-tag "save" claim, CLAUDE.md battery claim) | ENV-10/WF-2/AD-5 | doc fixes |
| jscpd/knip-adjacent deletes: Imagen pair, enums.ts groups, live-catalog-fetch relocation | DEAD-2 §10+21 | delete/move |
| JD-5…8: multi-isolate SKIP LOCKED race, neon-proxy latency injection, wake-delivery e2e, wall-clock lease test | §13 | as specified per row |

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Legacy feature parity checklist](#2-legacy-feature-parity-checklist)
   (identity/auth · conversations · chat/streaming · billing/payments · models ·
   media · notifications/emails · newsletter · account · platform · **2.G apps/web
   frontend · 2.H workflow engine/settlement/idempotency · 2.I packages/ui &
   accessibility · 2.J marketing/crawler-view/Capacitor · 2.K group-chat budgets & premium gating**)
3. [Encryption & crypto parity (must be EXACT)](#3-encryption--crypto-parity)
4. [Crypto segregation (where crypto lives, leaks)](#4-crypto-segregation)
5. [OPAQUE auth correctness](#5-opaque-auth-correctness)
6. [DB schema: table-by-table, column-by-column](#6-db-schema-audit)
7. [Env vars: existence-branching audit + new vars/secrets inventory](#7-env-vars)
8. [Model pricing fee hygiene (fees applied once)](#8-model-pricing-fee-hygiene)
9. [Sentry & error-reporting policy](#9-sentry--error-reporting)
10. [Token estimation & repo-wide single-source-of-truth](#10-ssot-audit) (part 2 — repo-wide SSOT/duplication/dead-code — follows §21)
11. [Rate limiting regression check](#11-rate-limiting)
12. [API & browser security (CSRF, CORS, headers…)](#12-api--browser-security)
13. [Jobs / Durable Objects: test fidelity (dev ⇒ prod)](#13-jobs--do-test-fidelity)
14. [Admin plane: code + reversibility test enforcement](#14-admin-plane)
15. [OpenRouter implementation (dynamic ZDR, no hardcoding, gateway remnants)](#15-openrouter)
16. [Smart Model parity](#16-smart-model-parity)
17. [Cassette system parity & CI real-API coverage](#17-cassettes--ci-real-api)
18. [New lint/coverage/arch rules — CI enforcement](#18-rule-enforcement-in-ci)
19. [Infra changes (vitest/turbo/wrangler configs)](#19-infra-changes)
20. [E2E suite audit](#20-e2e-suite)
21. [Duplication (email scaffolding and beyond)](#21-duplication)
22. [Codebase quality metrics](#22-quality-metrics)
23. [Net-new areas discovered during exploration](#23-net-new-areas)
24. [Consolidated findings register (ranked)](#24-consolidated-findings-register)
25. [Open founder questions](#25-open-founder-questions)

---

<!-- Sections are appended below as audit agents report. -->

## 6. DB schema audit

**Sources.** Legacy DDL = `git show origin/main:packages/db/src/schema/*.ts` (21 tables + `projects`). New DDL = `packages/db/src/schema/*.ts` (36 tables) + migrations `0037…0057`. Behavior traced through `apps/api/src/slices/**` (new) and `apps/api/src/legacy/**` (legacy). Anchors: `docs/plans/BACKEND-REDESIGN.md` §9/§20, `packages/db/CLAUDE.md`.

**Global changes (stated once, apply to every table):**

| Change | Change-type | Justified? |
|---|---|---|
| PK `id` `text`→`uuid` (same uuidv7 generator) | CHANGED | ✅ (shape-test mandate; `service_evidence` grandfathered) |
| All FK columns `text`→`uuid` | CHANGED | ✅ |
| Money `numeric(20,x)`→`bigint` nano-USD (legacy `parseFloat` reads eliminated) | CHANGED | ✅ |
| Closed-set `text`→`pgEnum` (`jobs.type` the one text exception) | CHANGED | ✅ |

### 6.1 Per-table column audit

#### users
| column | legacy | new | change | justified? |
|---|---|---|---|---|
| id | text PK uuidv7 | uuid PK uuidv7 | CHANGED | ✅ |
| email | text unique, **nullable** | text **notNull** unique | CHANGED | ✅ Verified (DB-4): both insert sites (identity/adapters/stores.ts:65,92) take `RegistrationValues` whose email is required `z.email().max(254)` (registration.ts:35-53); trial sessions are never persisted (trial-session.ts:22-23) and link-guest has no users insert |
| username | varchar(20) notNull unique | same | SAME | ✅ |
| emailVerified | bool notNull default false | same | SAME | ✅ |
| emailVerifyToken / emailVerifyExpires | text / timestamptz nullable | DROPPED | DROPPED | ✅ → `verification_tokens` |
| opaqueRegistration | bytea notNull | same | SAME | ✅ |
| totpSecretEncrypted | bytea nullable | same | SAME | ✅ |
| totpEnabled | bool notNull default false | same | SAME | ✅ |
| hasAcknowledgedPhrase | bool notNull default false | same | SAME | ✅ |
| customInstructionsEncrypted | bytea nullable | DROPPED | DROPPED | ✅ → `custom_instructions` |
| publicKey | bytea notNull | same | SAME | ✅ |
| passwordWrappedPrivateKey | bytea notNull | same | SAME | ✅ |
| recoveryWrappedPrivateKey | bytea notNull | same | SAME | ✅ |
| accessibilityPreferences(+UpdatedAt) | jsonb + timestamptz | DROPPED | DROPPED | ✅ → `preferences` |
| lockedAt / lockReason | — | timestamptz / enum nullable | NEW | ✅ (chargeback/admin lock; CHECK `users_lock_consistency`) |
| deletionRequestedAt | — | timestamptz nullable | NEW | ✅ (chunked deletion marker) |
| createdAt / updatedAt | timestamptz notNull defaultNow | same | SAME | ✅ |

#### conversations
| column | legacy | new | change | justified? |
|---|---|---|---|---|
| id / userId | text / FK cascade | uuid / FK cascade | CHANGED | ✅ |
| title | bytea notNull | same | SAME | ✅ |
| projectId | text FK→projects set null | DROPPED | DROPPED | ✅ (`projects` removed, migration 0037) |
| titleEpochNumber / currentEpoch / nextSequence | int notNull defaults | same | SAME | ✅ |
| conversationBudget→conversationBudgetNanoUsd | numeric(20,2) default '0.00' | bigint default 0 | CHANGED | ✅ (money) |
| createdAt/updatedAt | timestamptz | same | SAME | ✅ |

#### messages
| column | legacy | new | change | justified? |
|---|---|---|---|---|
| id / conversationId | text / FK cascade | uuid / FK cascade | CHANGED | ✅ |
| senderType | text notNull | `message_sender_type` enum | CHANGED | ✅ |
| senderId | text nullable, no FK (deletion-nulled) | uuid nullable, no FK | SAME | ✅ |
| wrappedContentKey | bytea notNull | same | SAME | ✅ |
| epochNumber / sequenceNumber | int notNull | same | SAME | ✅ (+ new composite FK below) |
| parentMessageId | text nullable, **no FK** | uuid nullable, **self-FK set null** | CHANGED | ✅ (adds integrity) |
| batchId | text default `gen_random_uuid()::text` | uuid default `uuidv7()` | CHANGED | ✅ |
| createdAt | timestamptz | same | SAME | ✅ |

Constraints: `UNIQUE(conversationId,sequence)` SAME (index→constraint) · **NEW composite FK** `(conversationId,epochNumber)`→`epochs` cascade (legacy had none) · parent index now partial. Writers: chat slice only.

#### content_items
| column | legacy | new | change | justified? |
|---|---|---|---|---|
| id / messageId | text / FK cascade | uuid / FK cascade | CHANGED | ✅ |
| contentType | text | `content_item_type` enum | CHANGED | ✅ |
| position / encryptedBlob / storageKey / mimeType / sizeBytes / width / height / durationMs | — | — | SAME | ✅ |
| modelName→modelId | text nullable | text nullable (renamed) | CHANGED | ✅ |
| providerName | — | text nullable | NEW | ✅ |
| cost→costNanoUsd | numeric(20,8) nullable | bigint nullable | CHANGED | ✅ |
| isSmartModel | bool notNull default false | same | SAME | ✅ |

storageKey partial-unique SAME · CHECK `content_items_type_consistency` SAME · NEW partial `model_id` index. Writers: chat only.

#### payments
| column | legacy | new | change | justified? |
|---|---|---|---|---|
| userId | FK set null | FK set null | SAME | ✅ (retention) |
| amount→amountNanoUsd | numeric notNull | bigint notNull | CHANGED | ✅ |
| status | text default 'pending' | enum (+`awaiting_webhook`/`expired`) | CHANGED | ✅ |
| idempotencyKey | text **nullable**, unique(userId,key) | text **notNull, globally unique** | CHANGED | ✅ Verified (DB-3): sole production insert `insertPaymentIfAbsentWithinTx` (billing/adapters/stores.ts:331) requires the key; `preClaimPayment` always sets `pay:<userId>:<key>` (payments.ts:139) fed by `requiredIdempotencyKey(c)` which throws on a missing header (routes.ts:138-144,501) |
| helcimTransactionId | text unique | same | SAME | ✅ |
| cardType / cardLastFour / webhookReceivedAt | — | — | SAME | ✅ |
| errorMessage→errorCode | free-form message | code only | CHANGED | ✅ Verified: the failure writer sets `{status:'failed', errorCode}` (billing/adapters/stores.ts:380) — codes only, per telemetry doctrine |

#### wallets
| column | legacy | new | change | justified? |
|---|---|---|---|---|
| userId | FK set null | FK set null | SAME | ✅ |
| type | text | `wallet_type` enum (purchased/free) | CHANGED | ✅ |
| balance→balanceNanoUsd | numeric default '0' | bigint default 0 | CHANGED | ✅ |
| ledgerSeq | — | bigint notNull default 0 | NEW | ✅ (snapshot CAS seq) |
| priority | int notNull | **DROPPED** | CHANGED | ✅ Verified (DB-5): spend order preserved — see spend-selection note below this table |

`UNIQUE(userId,type)` SAME. Writers: billing only.

**Spend-selection order (replaces `wallets.priority`) — Verified.** Legacy walked all wallets `ORDER BY priority` ascending and debited the first with sufficient balance (origin/main `transaction-writer.ts:234-257`); provisioning set `purchased.priority=0`, `free_tier.priority=1` — i.e. purchased before free. The new system moves the choice **upstream to run admission**: `senderPayerWallet` (chat/domain/turn-context.ts:232-258) selects the sender's `purchased` wallet **iff `balanceNanoUsd > 0n`**, else the `free` wallet (daily allowance); group turns select the OWNER's wallet when group headroom is positive (`isOwnerFundedTurn`, turn-context.ts:274). The chosen `walletId` is frozen into the run identity, admission gates only that wallet (admission.ts:87,156), and `chargeWithinTx` debits it unconditionally (charge.ts:95). Net rule: **purchased (if positive) then free** — reproduces legacy's priority-0-then-1 walk exactly, minus the DB `ORDER BY`.

#### usage_records
| column | legacy | new | change | justified? |
|---|---|---|---|---|
| type / status / sourceType / sourceId / completedAt | text lifecycle columns | **DROPPED** | DROPPED | ✅ Verified (DB-1): zero readers of status/type/completedAt/'pending' on usage_records anywhere in new code (repo grep + drizzle types make any survivor a compile error); rows are inserted once, fully-formed, inside settle() |
| cost→costNanoUsd | numeric notNull | bigint notNull | CHANGED | ✅ |
| isEstimated | bool default false | same | SAME | ✅ |
| contentItemId | — | uuid FK set null | NEW | ✅ (saved⟺billed anchor) |
| runId | — | uuid notNull (no run table) | NEW | ✅ |
| conversationId | — | uuid FK set null | NEW | ✅ |
| modelId / providerName / modality / generationId | — | text/text/enum/text | NEW | ✅ |
| idempotencyKey | — | text notNull unique | NEW | ✅ |

Writers: billing only (incl. post-insert conversationId update, same slice).

#### llm_completions
| column | legacy | new | change | justified? |
|---|---|---|---|---|
| usageRecordId | notNull unique FK cascade | same | SAME | ✅ |
| model / provider | text notNull | DROPPED | DROPPED | ✅ → usage_records |
| inputTokens / outputTokens | int notNull | same | SAME | ✅ |
| cachedTokens→cachedInputTokens | int default 0 | same (renamed) | CHANGED | ✅ |
| reasoningTokens | — | int default 0 | NEW | ✅ |
| toolSteps | — | jsonb default `[]` | NEW | ✅ (agentic tool activity) |

#### media_generations
usageRecordId SAME · model/provider DROPPED-justified → usage_records · mediaType→`modality` enum CHANGED-justified · imageCount/durationMs/resolution SAME.

#### ledger_entries
| column | legacy | new | change | justified? |
|---|---|---|---|---|
| transactionId | — | uuid notNull | NEW | ✅ (double-entry group) |
| walletId | text **notNull** FK **cascade** | uuid **nullable** FK **RESTRICT** | CHANGED | ✅ Verified (DB-2): no production path deletes a wallets row — account deletion deletes `users` and `wallets.userId` is `set null` (wallets.ts:14; deletion.ts:296), so wallets are orphaned, never deleted; `delete(wallets)` appears only in test cleanup. RESTRICT is defense-only |
| amount→amountNanoUsd | numeric notNull | bigint notNull | CHANGED | ✅ |
| balanceAfter→balanceAfterNanoUsd | numeric **notNull** | bigint **nullable** | CHANGED | ✅ (running balance only on wallet legs, CHECK-enforced) |
| entryType→kind | text | `ledger_entry_kind` enum | CHANGED | ✅ |
| houseAccount | — | enum nullable | NEW | ✅ |
| idempotencyKey | — | text notNull unique | NEW | ✅ |
| paymentId / usageRecordId | FK set null | same | SAME | ✅ |
| sourceWalletId | text FK set null | DROPPED | DROPPED | ✅ (transfers = two signed legs sharing transactionId) |

NEW: CHECK `one_account` (`num_nonnulls(walletId,houseAccount)=1`), CHECK balance-on-wallet-legs, **deferred zero-sum trigger** (migration 0039). Writers: billing only.

#### shared_links
linkPublicKey unique SAME · displayName/revokedAt SAME · **expiresAt NEW-justified** (lazy expiry) · legacy partial-active index → full FK index (🟡 minor, active filter now read predicate).

#### shared_messages
messageId FK cascade SAME · **createdBy NEW-justified** (uuid FK cascade — creator deletion severs shares, migration 0042) · wrappedContentKey SAME · legacy had **zero indexes** (unindexed FK) — new adds both. Improvement.

#### conversation_members
privilege text→enum CHANGED-justified; userId/linkId/visibleFromEpoch/joinedAt/leftAt/acceptedAt/muted/pinned/invitedByUserId all SAME. Unique-active partials SAME · partial-active lookups → full FK indexes (justified, cascade coverage) · NEW linkId + invitedBy partial indexes (fix legacy unindexed FKs) · CHECK identity-or-left SAME. Writers: conversations only.

#### device_tokens
All SAME except platform bare-text→pgEnum (CHANGED-justified).

#### epochs
epochNumber/epochPublicKey/confirmationHash/chainLink SAME · `UNIQUE(conversationId,epochNumber)` SAME (now FK target) · **previousEpochId NEW-justified** (referential chain + partial index).

#### epoch_members
All columns and constraints SAME.

#### member_budgets
| column | legacy | new | change | justified? |
|---|---|---|---|---|
| memberId | notNull unique FK cascade | same (named constraint) | SAME | ✅ |
| budget→budgetNanoUsd | numeric default '0.00' | bigint **no default** | CHANGED | ✅ Verified (DB-6): both production insert paths supply the cap explicitly and typed-required (billing/adapters/stores.ts:299-303 insert-only, :526-530 `setMemberBudgetCapWithinTx`); remaining sites are dead-legacy/dev-seed |
| spent→spentNanoUsd | numeric default '0' | bigint default 0 | CHANGED | ✅ ; **cumulative, no period** (confirmed §9) |
| createdAt | timestamptz | DROPPED (updatedAt added) | CHANGED | ⚪ — benign column swap |

Both write intents (settlement spend + owner cap-set) live in billing — single-writer intact; domain coupling to watch.

#### conversation_spending
totalSpent→spentNanoUsd CHANGED-justified; unique(conversationId) SAME; cumulative, no period. Writers: billing only.

#### conversation_forks
All SAME · unique(conversationId,name) SAME · legacy plain conv index DROPPED (covered by unique leading column, ⚪) · NEW tipMessageId partial index (fixes unindexed FK).

#### account_deletion_events / service_evidence
Fully SAME (`service_evidence` keeps text PK `crypto.randomUUID()` — grandfathered).

#### projects — DROPPED-justified
Table + index + `conversations.projectId` removed in migration 0037 (deliberate feature deletion).

#### New-only tables (all NEW-justified)
| table | owner slice | shape |
|---|---|---|
| admin_audit | admin | append-only (trigger-enforced); `undoes` unique self-FK = exactly-once undo claim; targetId text (polymorphic); no users FK |
| allowance_spending | billing | free-tier **period-keyed** `(userId, day)` unique + day-format CHECK |
| banner_config / banner_dismissals | announcements | messages jsonb; per-user unique dismissal + messageSetHash |
| custom_instructions | account | replaces users.customInstructionsEncrypted |
| preferences | account | replaces users.accessibilityPreferences |
| verification_tokens | identity | replaces users.emailVerifyToken/Expires; purpose enum |
| feedback | feedback | kind/status enums, status+createdAt index |
| idempotency_keys | billing/platform | `(userId,route,key)` unique; kind/status enums; claims fence; purge partial index; userId no FK (trial principals) |
| jobs | platform | text `type` (design exception); exactly 4 partial indexes (shape-test enforced) |
| model_catalog | models | `unique(modelId)`; descriptor jsonb; adminDisabledAt; popularityRank |
| newsletter_subscribers / issues / deliveries | newsletter | consent evidence; deliveries `unique(issueId,subscriberId)`, FKs NO ACTION (parents never deleted) |
| public_stats_snapshots | billing | leaderboard JSON snapshots |

### 6.2 Index / constraint diffs (net)

**Dropped (all justified or no-loss):** users email-verify-token idx · payments helcim idx (unique still backs) · payments composite idempotency unique (→ stronger global unique) · usage_records/llm/media model+source indexes (columns gone) · conversation_forks plain conv idx (covered) · partial-active member/shared_links indexes (→ full FK indexes).
**Added:** composite messages→epochs FK, all new-table indexes, and **five legacy unindexed-FK fixes** (shared_messages.messageId, conversation_members.linkId, .invitedByUserId, conversation_forks.tipMessageId, + parent partials).

### 6.3 FK on-delete diffs
1. `ledger_entries.walletId` cascade→RESTRICT (+nullable) — justified, financial retention.
2. `messages.parentMessageId` none→set null; `messages(convId,epoch)` none→cascade; `epochs.previousEpochId` none→NO ACTION; `shared_messages.createdBy` new cascade — all justified.
3. All financial FKs to users = set null (pseudonymization) — SAME/justified. No cascade↔set-null regressions found on surviving user-data tables.

### 6.4 Single-writer analysis
Every insert/update under `apps/api/src/slices/**` mapped: **no table written by more than one slice.** Watch item: member_budgets carries two write intents (settlement spend + owner cap) both inside billing.

### 6.5 Section findings
| # | sev | finding | status |
|---|---|---|---|
| DB-1 | 🟠→resolved | `usage_records.status/type` dropped — **Verified safe: no reader anywhere expects the async lifecycle** (repo grep zero hits; drizzle types compile-fence survivors) | justified, closed |
| DB-2 | 🟠→resolved | `ledger_entries.walletId` cascade→RESTRICT + nullable — **Verified safe: no wallet hard-delete path exists** (account deletion set-nulls `wallets.userId`; wallets rows are never deleted) | justified, closed |
| DB-3 | 🟠→resolved | `payments.idempotencyKey` notNull global-unique — **Verified safe: the sole payment-creation path always supplies `pay:<userId>:<key>` from a throw-on-missing header read** | justified, closed |
| DB-4 | 🟡→resolved | `users.email` notNull — **Verified safe: every users insert carries a required validated email; trial/link-guest principals never insert users rows** | justified, closed |
| DB-5 | 🟡→resolved | `wallets.priority` dropped — **Verified: purchased-if-positive-then-free selection at turn-context replicates legacy's priority walk exactly** (documented under the wallets table) | justified, closed |
| DB-6 | 🟡→resolved | `member_budgets.budgetNanoUsd` default removed — **Verified safe: both insert paths supply the cap, typed-required** | justified, closed |
| DB-7 | ⚪ | member_budgets createdAt→updatedAt swap; payments errorMessage→errorCode; shared_links partial→full index | benign |

## 2. Legacy feature parity checklist

### 2.A Identity / Conversations / Account

Scope: `apps/api/src/legacy/**` (== `origin/main` routes/services/middleware/lib) vs `apps/api/src/slices/{identity,conversations,account}`, `apps/api/src/middleware`, `app.ts`.

#### Identity — OPAQUE register / login
| Feature | Legacy evidence | Status | New evidence | Note |
|---|---|---|---|---|
| register/init OPAQUE round + dual (email+IP) rate limit | legacy/routes/opaque-auth.ts:455-525 | ⚠️ | identity/routes.ts:255-289; app.ts:514 | IP limit moved to app-level mount; user-key limit now domain outcome; `opaque-protocol` exempt class |
| register/finish, enumeration-safe fake success | opaque-auth.ts:527-640 (fake :553-564) | ✅ | routes.ts:290-324 (fake 201 :312-316) | email/username-taken 409 preserved |
| register/finish → wallets + welcome credit | (provisioning elsewhere) | ⚠️ | routes.ts:296-305 in-tx settlement | now atomic with user INSERT (improvement) |
| register/finish → verification + welcome emails | opaque-auth.ts:606-631 | ✅ | routes.ts:301-303 | best-effort |
| login/init anti-enum fake record + rate limit | opaque-auth.ts:642-744 (fake :704-710) | ✅ | routes.ts:325-352 | |
| lockout-trip → account-locked email | opaque-auth.ts:109-118 | ✅ | routes.ts:337 | |
| login/finish handshake + identifier-mismatch defense | opaque-auth.ts:746-834 | ✅ | routes.ts:353-385 | |
| email-not-verified gate → 401 | legacy | ✅ | routes.ts:374-376 | |
| account-locked → 403 | legacy | ✅ | routes.ts:373 | |
| login success shape `{success,userId,email,passwordWrappedPrivateKey}` | opaque-auth.ts:825-833 | ✅ | routes.ts:186-198 | identical |
| 2FA gate `{requires2FA,userId}` + pending session | opaque-auth.ts:810-816 | ✅ | routes.ts:377-379 | |

#### Identity — sessions / 2FA / password / recovery / deletion
| Feature | Legacy | Status | New | Note |
|---|---|---|---|---|
| login/2fa/verify promote + session rotation + lockout | opaque-auth.ts:836-932 | ✅ | routes.ts:475-517 | + live-socket eviction |
| logout (destroy + Redis DEL) | opaque-auth.ts:1006-1024 | ✅ | routes.ts:390-419 | pending-2fa may log out; + eviction |
| /me bootstrap | opaque-auth.ts:934-1000 | ⚠️ | domain/me.ts:16-54 | drops customInstructionsEncrypted (→/account/instructions) + pending-2fa reduced shape; adds publicKey — documented me.ts:7-15 |
| /me redundant Redis recheck | opaque-auth.ts:940-950 | 🗑 | pipeline supersedes | intentional |
| billing-only session scope | legacy: hit any authed route (opaque-auth.ts:936) | ⚠️ | principal.ts:92,111; pipeline-authorize.ts:85 | tightened to billing surface — security improvement |
| 2fa setup / verify / disable init+finish (+ emails, lockouts) | opaque-auth.ts:1026-1332 | ✅ | routes.ts:424-581 | all gates preserved |
| change-password init/finish (step-up, passwordChangedAt, email) | opaque-auth.ts:1400-1522 | ✅ | routes.ts:584-641 | + eviction |
| recovery get-wrapped-key (enum-safe dummy + limits) | opaque-auth.ts:1633-1669 | ✅ | routes.ts:645-669 | dummy now indistinguishable (§3 C1) |
| recovery reset init/finish | opaque-auth.ts:1524-1631 | ✅ | routes.ts:670-728 | path split /init |
| recovery/save (+hasAcknowledgedPhrase) | :433 | ✅ | routes.ts:936-957 | byUpsert |
| verify-email + resend (enum-safe) | ~1310-1398 | ⚠️ | routes.ts:768-820 | tokens → verification_tokens table; path renamed /verify-email/resend |
| token-login (60s TTL, deterministic session, no delete-on-use) | token-login.ts:13-85 | ✅ | routes.ts:740-766 | deliberately un-rate-limited (documented both sides) |
| delete init/finish (step-up + TOTP + phrase + lockout + saga) | delete-account.ts:238-334 | ✅ | routes.ts:839-925 | all gates preserved |
| deletion anonymous forensic event (ip/ua) | delete-account.ts:319-320 | ✅ | routes.ts:878-880 | |
| deletion response | 204 no-body | ⚠️ | 200 `{success:true}` routes.ts:903 | cosmetic — confirm client |
| deletion → media reclaim | inline saga | ⚠️ | deletionPurge + dispatcher wake | now jobs-based (design) |
| link-guest principal | require-link-guest.ts | ⚠️ intentional | principal.ts:94; domain/link-guest.ts | per ruling: legacy participation + revocable |

#### Account slice
| Feature | Legacy | Status | New | Note |
|---|---|---|---|---|
| user search | POST /users/search users.ts:12-38 (any authed, optional exclude) | ⚠️ 🟠 | GET /account/users/search; user-search.ts:11-70 | **conversationId now required + active-membership gate + LIKE-escape** — breaking for pre-conversation search flows (finding IC-1) |
| custom instructions read/write/clear | /me + PATCH users.ts:39-71 (uncapped, null-clears) | ⚠️ | GET/PUT/DELETE /account/instructions | +32 KiB cap (legacy uncapped); null → DELETE |
| accessibility prefs read/write (LWW, ≤ accepts equal) | user-preferences.ts:29-87 | ✅ | routes.ts:141-172; preferences.ts:57-80 | LWW preserved; stale-write returns authoritative state |

#### Conversations — CRUD / members / forks / shares / keys
| Feature | Legacy | Status | New | Note |
|---|---|---|---|---|
| list conversations (cursor + flags) | conversations.ts:114-150 | ✅ | domain/conversations.ts:221-255 | undecodable cursor → empty page (parity) |
| create-or-get (client id, converge, epoch-1) | :191-222 | ✅ | conversations.ts:82-149 | foreign id → conflict (no leak) |
| get conversation | :151-190 (bundles messages+forks) | ⚠️ | conversations.ts:158-185 | messages/forks split to own endpoints — confirm client fetches all three |
| update title (owner, titleEpochNumber) | :223-240 | ✅ | conversations.ts:278-302 | |
| delete conversation (owner, hard cascade) | service | ✅ | conversations.ts:317-358 | + pre-cascade eviction reads |
| message history (visibleFromEpoch) | inline in GET | ⚠️ | GET /:id/messages (guest-reachable) | honored |
| list/add/remove members, limits, ladder, visibleFromEpoch | members.ts:206-458 | ✅/⚠️ | domain/members.ts:42-372 | add now forbids granting ≥ granter (legacy admin could mint admin) — tightening (IC-2) |
| leave (owner→delete; else rotation) | members.ts:518-585 | ✅ | members.ts:419-486 | |
| accept/decline invite | members.ts:642-721 | ✅ | members.ts:555-600 | |
| change privilege (canChangePrivilege, distinct 403) | members.ts:459-517 | ✅ | members.ts:628-658 | |
| mute/pin | members.ts:586-641 | ✅ | members.ts:498-538 | |
| member/rotation/privilege broadcasts | members.ts:162-183… | ✅ | routes.ts:534-772 | post-commit best-effort |
| forks list/create/rename/delete (+ orphan messages) | forks.ts:31-133 | ✅/⚠️ | routes.ts:987-1114 | delete now atomically removes orphaned branch messages; response reshaped |
| shared links: list/create/revoke/privilege/display-name/my-name | links.ts:24-259 | ✅ | routes.ts:1115-1282, 923-941 | seat-guest-member semantics per ruling; lazy expiry |
| create shared message (FOR SHARE, createdBy) | message-shares.ts:43-109 | ⚠️ | routes.ts:1283-1306 | path/body renamed; createdBy FK added; rate-limited |
| public share read + IP throttle | message-shares.ts:159-217 | ✅/⚠️ | routes.ts:1314-1323; app.ts:549-553 | throttle retained; **inline downloadUrl dropped** — media presign now separate endpoint (IC-3: verify unauth presign accepts share id) |
| keychain single/batch, member-keys | keys.ts:56-138 | ✅/⚠️ | routes.ts:875-961 | batch POST→GET; member-keys now guest-reachable (consistent with link-guest ruling) |
| rotation triggers + wrap-set validation + stale-epoch OCC | members/links submitRotation | ✅ | domain/rotation.ts | identical visibleFromEpoch formulas |

#### Cross-cutting middleware
| Feature | Legacy | Status | New | Note |
|---|---|---|---|---|
| version-check (426, dev skip, WS pass) | version-check.ts:1-53 | ✅ | middleware/version-check.ts:1-80 | code renamed UPGRADE_REQUIRED→VERSION_MISMATCH |
| version-check exempt prefixes | 4 paths | ⚠️ | re-pathed same set | webhooks now /billing/webhooks |
| default-deny authorization | per-route only | ⚠️ ➕ | pipeline-authorize.ts:68-93 | uniform default-deny — fixes legacy defect #1 |
| session revocation on every request | step-up routes skipped it | ⚠️ ➕ | pipeline-session.ts | uniform — security fix |
| link-guest resolution (header + WS query fallback) | resolve-link-guest.ts | ✅ | routes.ts:308-331, 463-467 | |

#### ➕ New routes without legacy counterpart
`GET /auth/verify-email/dev-link` (dev-only) · `PUT /:id/forks/:forkId/tip` · conversation/member budget routes (`GET /:id/budgets`, `PUT /:id/budget`, `PUT /:id/member/:memberId/budget`) · `GET /:id/my-name` · admin link revoke/unrevoke (authz-only, per ruling).

#### Section findings
| # | sev | finding |
|---|---|---|
| IC-1 | 🟠→resolved | User search now requires existing conversation + active membership (user-search.ts:11-54). **Resolved safe: the only production caller is `useUserSearch` (enabled only with a conversationId), invoked solely by `AddMemberModal` inside the chat layout of a conversation the caller is viewing (add-member-modal.tsx:60); no pre-conversation search flow exists; there is no separate mobile app — Capacitor wraps the same web code.** Verified. |
| IC-2 | 🟡 | Add-member forbids granting ≥ granter's privilege (members.ts:141-145); legacy admin could add another admin. Stricter contract, undocumented. Verified. |
| IC-3 | 🟡→resolved | Public shared-message read no longer returns inline `downloadUrl` for media. **Resolved in §2.D: the unauthenticated public share presign endpoint exists and is correct (media/routes.ts:127-159, `public` class, bare shareId, shareAllows presign-authz.ts:96-108) — public shared media is fetchable.** Verified. |
| IC-4 | ⚪ | Deletion finish 204→200 `{success:true}`; numerous path/method renames (see list above); /me reshape. Verified, client-coordination items. |

**No ❌-missing behaviors found in these domains** — every legacy route, gate, lockout, enumeration safety, rate limit, and rotation trigger has a located counterpart.

## 3. Encryption & crypto parity

**Structural fact:** `packages/crypto` holds **two parallel blob stacks** keyed by version byte (`format.ts:8`): legacy v0x01 (`ecies.ts`, `symmetric.ts`, `message-encrypt.ts`, `message-codec.ts`, `content-key.ts`, `epoch-lifecycle.ts`) and new v0x02 (`envelope.ts`, `wrap.ts`, `keys.ts`, `epoch.ts`, `format.ts`, `recovery-dummy.ts`, `bounded-inflate.ts`). The live system is a **hybrid**: message/content encryption moved to v0x02 (AAD envelope + domain-separated wraps); **epoch key management still runs the legacy stack** (`createFirstEpoch`/`performEpochRotation`/`verifyEpochKeyConfirmation`, verified live usages).

### Message / content encryption
| Mechanism | Legacy | New | Verdict |
|---|---|---|---|
| Bulk cipher | XChaCha20-Poly1305 | XChaCha20-Poly1305 (envelope.ts:63) | SAME |
| Nonce | 24B randomBytes, prepended | same, after version byte (envelope.ts:62-65) | SAME |
| AAD | **none** | full location tuple `version‖convId‖msgId‖itemId‖position‖epoch‖senderId‖wrappedContentKey`, injective (envelope.ts:42-53; format.ts:30-50) | DIFFERENT — strictly stronger (anti-splice) |
| Content key/message | wrap-once to epoch (content-key.ts:26,30) | same shape + per-item location binding | SAME shape |
| Content-key wrap | eciesEncrypt, no domain label | `wrapSecretTo(…,'content-key.epoch')` HKDF-labeled (epoch.ts:15,55-59; wrap.ts:29-67) | DIFFERENT — domain separation added; legacy wrapper 0 live usages |
| Compression | compress-then-encrypt, flag byte (message-codec.ts) | identical codec | SAME |
| Decompression | `inflateSync` **unbounded** | boundedInflate 4 MiB cap | DIFFERENT — bomb defense added |
| Blob versioning | implicit v0x01 | explicit 0x02, rejects others (format.ts:8-23) | DIFFERENT — **not wire-compatible with v0x01** |
| Generic fields (titles, instructions) | encryptTextForEpoch (ECIES v0x01) | same, still live (rotation.ts:58; chat-item.tsx:75) | SAME |

### Epoch keys / rotation / password / recovery
| Mechanism | Verdict | Evidence |
|---|---|---|
| Epoch keypair X25519, ECIES member wraps, chain link, back-read traversal | SAME (same legacy module live) | epoch-lifecycle.ts:32-76 |
| Epoch confirmation = bare `sha256(epochPriv)` | SAME live; **stronger keyed `computeEpochConfirmation` exists with 0 usages** (epoch.ts:32-53) | finding CR-3 |
| Rotation: client-driven, server plans wrap set, FOR UPDATE + first-write-wins, prior wraps dropped, epochs retained | SAME | conversations/domain/rotation.ts:10-104 |
| Password change: OPAQUE step-up → re-register; re-wraps `passwordWrappedPrivateKey` only; `passwordChangedAt` revoke-all | SAME (+ socket eviction added) | credentials.ts:46-61; account.ts:49-55 |
| Recovery: BIP39 12-word; phrase never to server; client rewraps; reset rotates record+pwkey | SAME | recovery.ts:99-289 |
| Recovery dummy for unknown account | DIFFERENT — legacy fixed all-zeros 128B (**enumeration oracle**, origin/main opaque-auth.ts:1670); new HKDF-derived indistinguishable dummy (recovery-dummy.ts:50-67) | finding CR-1 |
| Client/server split: server never sees epoch priv key or user plaintext; server encrypts AI output to epoch **public** key; account key wrapped at rest | SAME both systems | settlement.ts:294-324; envelope.ts:20-24; registration.ts:44-46 |

### Section findings
| # | sev | finding |
|---|---|---|
| CR-1 | 🔴→fixed | Legacy recovery dummy (all-zeros, wrong length) was a certain account-enumeration oracle; new one is indistinguishable. Intentional, correct divergence — do NOT restore parity. Verified. |
| CR-2 | 🟠→resolved | v0x02 rejects v0x01 (format.ts:8,20) — **resolved moot: the 0x02 parser governs only the new envelope/wrap/chunk scheme; v0x01 ECIES remains the live wrap format for account/epoch/content keys and is decrypted by its own ecies paths — the schemes are domain-disjoint and never cross-read. No pre-cutover ciphertext exists (zero users; no migration/seed ciphertext backfill).** Verified. |
| CR-3 | 🟠 | Keyed epoch confirmation `computeEpochConfirmation` present but **dead (0 usages)**; live path still bare `sha256(priv)`. Wire it in or delete it — latent inconsistency. Verified. |
| CR-4 | 🟡 | deleteAccountLockout diverges: legacy 3/1h + 24h lock; new 3-in-24h window (keys.ts:212-222, self-documented). Confirm intent. Verified. |
| CR-5 | 🟡 | FCM RS256 signing via crypto.subtle outside packages/crypto (push-fcm.ts:94-102). Not E2EE, but asymmetric crypto outside the designated package — relocate or document carve-out. Verified. |
| CR-6 | ⚪ | Five non-E2EE SHA-256 uses via crypto.subtle instead of the crypto package's hash (rate-limit.ts:81, canonical-json.ts:81, billing-portal.ts:47, trial-quota.ts:189, roadmap/normalize.ts:46) — consistency only. Verified. |

## 4. Crypto segregation

**The one place: `packages/crypto/src/**`.** grep of `@noble/*`, `@scure/*`, `@cloudflare/opaque`, xchacha, x25519, hkdf, bip39 across apps/** and all other packages returns hits **only inside packages/crypto** — on both origin/main and HEAD. Segregation intact and unchanged from legacy.

Out-of-package crypto-adjacent uses, all judged non-leaks: UI CSPRNG ordering (`packages/shared/src/random.ts`, runtime.ts:149 engineRandom, recovery-phrase-modal quiz pick), keyless SHA-256 content addressing (5 sites, CR-6), FCM JWT signing (CR-5, borderline), cassette hashing (dev tooling). Every real key/nonce is generated by `@noble` randomBytes inside packages/crypto. OPAQUE core files are byte-identical (import-path-only diffs) vs origin/main.

## 5. OPAQUE auth correctness

Config unchanged from legacy: `OPAQUE_P256`, `serverIdentifier='opaque-server-v1'`, server keys HKDF-derived from `OPAQUE_MASTER_SECRET` (opaque-server.ts:12-57). Protocol usage verified correct end-to-end:

- **Register:** server-minted UUID session key, Redis 300s, atomic **GETDEL** consume; existing-email rides `existing:true` flag → fake success at finish. Matches legacy enumeration behavior.
- **Login:** unknown identifier gets deterministic fake registration record so authInit runs identically; `expected` state Redis 120s; all failure modes collapse to `auth-failed`. Correct indistinguishability.
- **Challenge state:** keyed by server-minted UUID never identifier; all consumes atomic GETDEL — **improvement over legacy's get-then-del race** (origin/main opaque-auth.ts:289-322). Closes double-finish race.
- **export-key:** never leaves client; account key wrapped under deriveWrappingKeyPair(exportKey).
- **2FA/step-up:** pending-2fa session (5min) instead of full; step-up handshakes GETDEL single-use, userId bound; TOTP replay-guard (120s) + lockout 10/15min.
- **Rate limits on handshakes:** login 5/900 atomic reserve-before-handshake + IP 20/900; register 3/hr + IP 10/hr; recovery 3/hr + IP 10/hr — **all budgets match legacy** (origin/main redis-registry.ts:49-124); login limiter upgraded advisory→atomic reservation (matches CODE-RULES secret-guessing class).

Findings: no protocol misuse found. m4 (⚪) — **resolved: parity confirmed.** Legacy change-password/init+finish (origin/main opaque-auth.ts:1404,1466) carried no per-user lockout or rate limit either; legacy 2fa/disable rate-limited only its TOTP component via `twoFactorUserRateLimit` (:1235), which the new system matches with the atomic 10/900 TOTP limiter (§11). Both systems gate these flows on session + fresh OPAQUE proof. Verified.

### 2.B Chat / turn / streaming

| Feature | Legacy evidence | Status | New evidence | Note |
|---|---|---|---|---|
| send message (single-model) | routes/chat.ts → stream-pipeline | ✅ | chat/routes.ts:779 → buildTurnDefinition → startRun | Verified |
| token transport | SSE (stream-handler.ts createSSEEventWriter) | ⚠️ | WS-only via ConversationRoom (room-core.ts:653; protocol.ts) | redesign; ordering preserved via chained promise |
| resume / Last-Event-ID | legacy resumable stream | ✅ | room-core.ts:369 resume → replay-buffer.ts:85; per-stream cursors ≥1; overflow → stream-gone → fetch-after-settlement | |
| disconnect | SSE abort tied run to request | ⚠️ | run survives client drop in DO; heartbeat lease room-core.ts:572; deadline alarm run-control.ts:73 | improvement, by design |
| stop + partial billing | legacy released reservation on abort | ⚠️ ruling | routes.ts:1187 /stop → run-control.ts:64; settlement commits produced generations | founder ruling: stop bills partial |
| regenerate / retry / edit | regeneration-guard.ts canRegenerate | ✅ | routes.ts:956; regenerate-guard.ts; verdicts→404/409/403 (routes.ts:260) | |
| message tree / fork tip advance | message-helpers.ts resolveParentMessageId, ForkTipConflictError | ✅ | fork-tip CAS fence settlement.ts:865-879; observedForkTipId routes.ts:1028 | TOCTOU fence threaded end-to-end |
| multi-model fan-out | lib/multi-stream.ts | ✅ | routes.ts:97 models[] → N sibling modelCall, optional+skip (turn-definition.ts:317); shared output ceiling (legacy parity :293) | each sibling own message/charge |
| trial mode 5/day no-persist/no-charge | trial-usage.ts | ✅ | routes.ts:1067 /trial; trial-quota.ts dual identity (token+IP, higher count); refusal burns no slot; burst 20/60s hashed IP | |
| queue-while-streaming | absent | ➕ | apps/web/src/stores/message-queue.ts | client-side; server one-run invariant |
| media output turns | media-pipeline.ts | ✅ | routes.ts:554; estimate.ts mediaCallUsageFor | |
| **multimodal image INPUT** | **none — legacy `InferenceMessage.content` is plain `string`** (legacy/routes/chat.ts:63-66) | ✅ | chat/smart-model input ports fixed text→text (smart-model-candidates.ts:74) | **parity, not a gap — CH-2 resolved; Q8 closed** |
| custom instructions injection | prompt/builder.ts:13 | ✅ | run-scoped (routes.ts:227) → interpreter.ts:904 → adapters; 5000-char bound; classifier deliberately excluded | never baked into definition |
| model params passthrough / maxOutputTokens | max-tokens.ts | ✅ | model-call-execution.ts:143; turn-definition.ts:228 | omitted ceiling → model default (parity) |
| title generation | client-side only (E2EE) | ✅ | still client-side only | no backend AI title either side |
| error surfaces | ERROR_CODE_* | ✅ | RUN_REFUSAL_STATUS map (409/402/503/429); admission refusals synchronous HTTP (room-core.ts:542) | |
| runless user-only message | saveUserOnlyMessage | ✅ | routes.ts:1244; + push side-band added (:1296) | |
| link-guest send (owner funds) | guest billing path | ✅ | routes.ts:871 /guest | |
| one-run-per-conversation | — | ⚠️ design | run-control.ts:32 claim; CONCURRENT_RUN 409 | |

Findings: **CH-1** ⚪ transport/stop/one-run divergences are all founder-ruled design (listed for sign-off). **CH-2** ⚪→resolved — **Verified: legacy chat input was text-only (`InferenceMessage { role; content: string }`, legacy/routes/chat.ts:63-66; no image/file field in the request path). New text-only turn input ports are exact parity, not a feature gap.** 

## 16. Smart Model parity

Shared helpers identical on both sides (`buildClassifierMessages`, `truncateForClassifier`, `CLASSIFIER_OUTPUT_TOKEN_CAP`, `resolveClassifierOutput` from @hushbox/shared).

| Aspect | Legacy | New | Verdict |
|---|---|---|---|
| context to classifier | latest user + assistant msg, truncated; no full history; candidates w/ descriptions (smart-model-stage.ts:52-66) | identical (smart-model-execution.ts:135-144); answer leg gets full history both sides | **SAME** |
| reservation | classifier worst-case reserved first; answer sized on remainder (smart-model-stage.ts:43) | same shape in nano-USD; classifier ceiling @2 chars/tok + output cap (smart-model-candidates.ts:108-136; smart-model-turn.ts:104-111) | **SAME** |
| algorithm | cheapest eligible = classifier = fallback; resolveClassifierOutput; budget-filtered candidates | identical ranking by combinedBasePrice ascending (smart-model-candidates.ts:156-159; smart-model-execution.ts:81-99) | **SAME** |
| degenerate cases | single-eligible skip (no bill); classifier throw → fallback (no bill); garbage output → fallback (**bill stands**) | identical three cases (smart-model-execution.ts:36-42,79-99,159-186) | **SAME** |
| billing | classifier billed when generated; final model normal settlement | classifier charge `<node>#classifier` via ctx.accrue, settles in the single fenced settlement; + feeds cost circuit | **SAME** |
| trial smart model | validateTrialSmartModel (trial-chat.ts:197-266) | buildTrialSmartModelCandidates: reserve + msg cost ≤ 1¢ | **SAME** |

**No blocking Smart Model divergence found.** Verified.

## 10. SSOT audit — token estimation (part 1)

**SSOT:** `packages/shared/src/constants.ts:179,185` — `CHARS_PER_TOKEN_CONSERVATIVE=2`, `CHARS_PER_TOKEN_STANDARD=4`; tier functions in `packages/shared/src/budget.ts:152-173` (`estimateTokensForTier`: paid→4 in, free/trial→2 in; `outputCharsPerTokenForTier` tier-inverted).

**Ratios and paid-vs-other distinction preserved EXACTLY** — new admission calls the same shared functions (turn-definition.ts:171-174, purchased→paid); legacy test-locked figures match. Verified.

**"Applied in exactly one place": partially.** All sites use the shared constant (no numeric literals), but the `ceil(chars/ratio)` *operation* is re-implemented in 2 extra sites instead of consuming `estimateTokensForTier`:

| site | expression | verdict |
|---|---|---|
| turn-definition.ts:173 | `estimateTokensForTier(tier, chars)` | ✅ canonical |
| trial-eligibility.ts:183 | `ceil(chars/TRIAL_CHARS_PER_TOKEN)` (=CONSERVATIVE) | 🟡 inline dup |
| smart-model-candidates.ts:118-119 | `ceil(chars/CLASSIFIER_CHARS_PER_TOKEN)` (=CONSERVATIVE) | 🟡 inline dup |

Other token math (all fine): `pricing.ts:33 estimateTokenCount` (÷4 content heuristic — web display only, NOT on new cost path; settlement prices observed provider Usage — improvement); `budget.ts:662` context-window % (physical, tier-agnostic by design); `eligible-models.ts:127` legacy-only (0 new consumers); mock-provider (non-prod).

Finding **TE-1** 🟡: route trial/classifier estimates through `estimateTokensForTier` (or a shared `estimateConservativeTokens`) to restore single-application. Verified.

## 15. OpenRouter implementation

### 15.1 Endpoint derivation map (Verified — implementation correct and complete)
| Endpoint | Consumer | Derives |
|---|---|---|
| `GET /models?sort=top-weekly` | gateway-metadata.ts:365 | modalities, context_length, supported_parameters, token pricing, releasedAt, deprecated, **popularityRank = array index** |
| `GET /endpoints/zdr` | :385 | authoritative ZDR membership set |
| `GET /images/models` (+ per-model /endpoints) | :401,:427 | image params (enum resolution/aspect, n range), per-image pricing rows |
| `GET /videos/models` | :457 | resolutions/aspects/durations, audio, seed, pricing_skus matrix |

ParamSpecs data-driven, no per-model code (normalize.ts:64-483). Pricing: exact string→nano-USD half-even; unparseable → unpriced → hidden. Image: only `output_image` rows price; unrecognized unit → **loud** exclusion. Video: sku interpreter with loud max-rate substitution fallback (normalize.ts:464). Refresh: hourly cron `0 * * * *` (wrangler.toml:38), ≤60s jitter, skip-unchanged content-compare, per-model byUpsert. Exclusion-with-alert only for fail-closed defects (refresh.ts:104-135); expected exclusions counted silently.

**Per-request ZDR:** single-sourced `routing-options.ts` — `{zdr:true, data_collection:'deny', allow_fallbacks:false}` on language (language-adapter.ts:414), image (:99), video (:187); web_search runs inside the language call so it inherits zdr, engine pinned `perplexity` (tool-registry.ts:40). Non-ZDR hidden fail-closed (list-descriptors.ts:29; normalize.ts:560).

**Cost extraction:** text `providerMetadata.openrouter.usage.cost` summed per step (language-adapter.ts:114-133); video `providerMetadata.openrouter.cost` (media-generate.ts:53); image deterministic estimate isEstimated=true; missing text/video cost → estimate + captureError + sanity-multiple guard (model-call-execution.ts:352,419). All per architecture.

### 15.2 Hard-coded model references
| Location | What | Verdict |
|---|---|---|
| shared/models/capabilities.ts:42-81 | VEO_CAPABILITY + IMAGEN_SAMPLE_SIZE_BY_MODEL per-model constants | 🟠 **violation, legacy-scoped** — consumed only by dormant legacy tree but exported from live shared barrel; delete with Phase 6 |
| shared/models/provider-map.ts | 8 provider display names | 🟡 display-only, slug fallback; primary path prefers OpenRouter's own split |
| models/domain/non-chat-exclusions.ts:12-23 | curated denylist (2 providers, 6 model IDs, `guard` regex) | 🟡 borderline — documented policy data, not capability/pricing; founder-awareness |
| tool-registry.ts:20 `perplexity` | search-engine pin | ✅ justified (ZDR guarantee) |
| SMART_MODEL_ID synthetic row | virtual model | ✅ justified |
| integration-setup.ts:59-61 | test fixtures | ✅ justified |

Ranking helpers (popularity/strongest/value) fully dynamic — no IDs. Verified.

### 15.3 Vercel AI Gateway remnants
**Dead, safe to delete:** `PUBLIC_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models"` in wrangler.toml:58, .dev.vars:23, env.config.ts:315 (shipped to Backend in ALL modes incl. Production, read only by legacy) · `packages/shared/src/models/fetch.ts` (dead fetcher, 0 web usages) · `SERVICE_NAMES.AI_GATEWAY` (evidence.ts:5, 0 prod usages).
**Naming/doc debt (functional code is provider-neutral):** `gateway-metadata.ts` module naming, `gatewayCost` param names + "AI Gateway" comments in pricing.ts/budget.ts, stale `process-models.ts` docstrings in schemas/api/models.ts:237, constants.ts:222, db schema comments.
**Clean:** no `@ai-sdk/gateway`, `AI_GATEWAY_API_KEY`, or `providerMetadata.gateway` anywhere in production; deps clean.

### 15.4 Catalog parity
One catalog, dedupe-by-id ✅ (normalize.ts:599-709, fixed merge priority, order-independent) · list fields parity + popularityRank ✅ · capability flags now ParamSpec-derived (same fields as legacy VEO map, dynamic) ✅ · param clamps re-validated at adapters, unknown keys rejected ✅ · adminDisabledAt + exposure gate single-sourced through listDescriptors ✅ · premium/trial gating single-sourced dynamic ✅.

### 15.5 Section findings
| # | sev | finding |
|---|---|---|
| OR-1 | 🟠 | capabilities.ts hard-coded per-model constants still exported from live shared barrel. **Corrected by §10+21 LEG-2: `getSupportedVideo*`/`VEO_CAPABILITY` are LIVE (consumed by `apps/web/src/stores/model.ts` + mock-provider) — migrating those consumers to catalog-derived data is a prerequisite; only `IMAGEN_SAMPLE_SIZE_BY_MODEL`+`getImagenSampleSize` are dead-deletable today.** Verified. |
| OR-2 | 🟠 | Vercel gateway env/config still shipped incl. Production (`PUBLIC_MODELS_URL` ×3) + dead fetcher + dead evidence name. Verified. |
| OR-3 | 🟡→resolved | Language adapter's missing `zdrReachable` check is **unreachable defense-in-depth, not a hole**: (1) every text turn resolves the client model string against the ZDR-filtered snapshot (list-descriptors.ts:29) and graph-compile refuses unknown/unexposed/non-ZDR models with a typed validationError before the run (turn-definition.ts:253-256,315,473-494); admin-disabled additionally rejected (chat/routes.ts:519-522); (2) every language call pins `provider.zdr:true` (language-adapter.ts:412) — OpenRouter 404s non-ZDR-routable models. No unchecked direct-model-id path exists. Verified. |
| OR-4 | 🟡 | PROVIDER_MAP + non-chat-exclusions denylist are hand-maintained data (display/policy — judged acceptable, flag for awareness). Verified. |
| OR-5 | ⚪ | Negative pricing sentinel "-1": legacy showed model as free, new hides it (fail-closed) — behavior delta. Stale "AI Gateway" docstrings. Latent `pricePerSecond` audio field (no adapter). Verified. |

### 2.C Billing / payments

| Feature | Legacy | Status | New | Note |
|---|---|---|---|---|
| Helcim credit-load | two-step: POST /payments + /:id/process (legacy/routes/billing.ts:119,172) | ⚠️ | single POST /payments Pattern-D + payment.verify.v1 job (billing/routes.ts:479) | equivalent; API shape changed |
| payment webhook credit | webhooks.ts:156 cardTransaction only | ⚠️ | /billing/webhooks/payment, full event taxonomy (payment-webhook.ts:303) | credit path preserved |
| webhook HMAC verify | fail-open if verifier absent non-prod (webhooks.ts:33) | ✅⚠️ | **fail-closed always** (routes.ts:67, webhook-verify.ts) | security improvement |
| payment poll GET /payments/:id | billing.ts:261 | 🗑➕ | removed; webhook + verify job authoritative | **Verified: zero poll call sites remain in web or the Capacitor shell (Q7 resolved — §2.G/§2.J); only `payments.$post` exists (billing.ts:109)** |
| refunds/chargebacks/disputes | **none in legacy** | ➕ | clawback legs + account lock + session.revoke.v1 + email; inquiry→notify (payment-webhook.ts:128-227) | major new capability |
| payment statuses | pending→awaiting_webhook→completed/failed + expiry | ⚠️ | preserved; pending not client-visible; verify expiry in verify job | |
| wallets purchased+free | ensureWalletsExist (wallet-provisioning.ts:18) | ✅ | provisionWalletsWithinTx (wallets.ts:29); free_tier→free rename; welcome as zero-sum promo legs | |
| spend order | charge-time wallet walk ORDER BY priority (transaction-writer.ts:242) | ✅ | selection upstream at turn-context: purchased-if-positive then free; owner-funded for group turns; frozen walletId charged unconditionally (turn-context.ts:232-274; charge.ts:95) | **Verified replicated — see §6 wallets spend-selection note (DB-5 resolved)** |
| welcome credit $0.20 | WELCOME_CREDIT_CENTS=20 | ✅ | identical amount; `welcome:<userId>` key; re-grant loop accepted | |
| free daily allowance $0.05 | lazy midnight wallet renewal (balance.ts:152) | ⚠️ | period-keyed allowance_spending UTC-day counter; same cap | cleaner mechanism |
| storage fee (ruling: restore) | STORAGE_COST_PER_CHARACTER, never fee'd | ✅ **restored** | 300n/char + 18n/byte media (money.ts:46), additive in chargeWithinTx (charge.ts:76), never marked up; init assertion ties to shared floats (money.ts:63); prompt storage on first charge only | |
| conversation budget | PATCH budget (budgets.ts:126) | ⚠️ | moved to conversations slice; enforced at admission scope; cumulative preserved | |
| member budgets cumulative | budgets.ts:106,174 | ⚠️ | addSpendingWithinTx scope member; cumulative-no-period confirmed | |
| group effective remaining | computeGroupRemaining min() | ✅ | group-budget.ts:22 — same fn feeds display + enforcement | |
| usage records + dimension rows | transaction-writer.ts:335 | ✅ | charge.ts:78,180; idempotent replay skips | |
| usage analytics (8 endpoints) | legacy/routes/usage.ts | ✅ | all present under /billing (routes.ts:222-440) | |
| transaction history | GET /transactions billing.ts:65 | ✅ | wire shape byte-identical incl. null padding (routes.ts:441-468) | |
| balance read | {balance, freeAllowanceCents} | ⚠️ | richer {purchased, free, allowance{…}} | client contract changed |
| billing login-link | 60s Redis token | ✅ | key shape preserved for cutover | |
| low-balance generateNotifications() | shared budget.ts client-side | ✅ | unchanged (frontend/shared concern) | |
| trial billing quota | 5/day token+IP atomic (trial-usage.ts:34) | ✅ | **RETAINED** — dual-identity 5/day (session+IP `Math.max`) at trial-quota.ts:68; per-IP burst 20/60s retained (rate-limit.ts:23); **NEW** global $50/day pool added (trial-spend.ts:61) | corrected — see RL-1 |
| public usage stats | — | ➕ | public-usage-stats + statsIpRateLimit | leaderboard feature |

## 8. Model pricing fee hygiene

**Legacy:** fees applied ONCE at catalog build (`applyFees` in process-models.ts:101-240); all downstream consumed fee-inclusive values.
**New: deliberately INVERTED** — catalog stores **base (pre-markup) nano-USD** (normalize.ts:111); markup applied once-per-amount at each consumption seam. Two primitives: `applyMarkup` (bigint half-even, money.ts:89, `MARKUP_BASIS_POINTS=1500n`) and `applyFees` (float, pricing.ts:56, `TOTAL_FEE_RATE=0.15`), rate-equality asserted at init (money.ts:25).

All 9 application sites verified single-application, **no double-application found**: charge.ts:76 (settlement) · settlement.ts:452 (content_items display mirror) · estimate.ts:293/:261/:22 (admission/call/search) · smart-model-candidates.ts:135 · list-models.ts:28 (display, applyFees) · premium-check.ts:60 · workflows/settlement.ts:173 (delegates).

| # | sev | finding |
|---|---|---|
| FEE-1 | 🟠→resolved | Dual markup primitives (float display vs bigint half-even charge). **Resolved in §2.H.9 (WF-7): the charge path never calls `applyFees`; divergence is confined to display/estimate and is sub-nano-USD; rates cross-asserted at init (money.ts:22-33). No rounding-parity assertion needed.** Verified. |
| FEE-2 | 🟡→resolved | Charged amount computed twice (charge.ts:76 ledger vs settlement.ts content_items mirror). **Resolved in §2.H.9: both use the same `applyMarkup` + additive storage fee on a single `withStorageFees` input (settlement.ts:436-460, 1026-1027) — equal by construction; extraction optional, not a correctness need.** Verified. |
| FEE-3 | ⚪ | Base-in-catalog inversion is sound: removes legacy's "must never re-apply" footgun at the cost of scattering the multiply; guarded by fail-fast assertions. |

## 11. Rate limiting

Legacy mechanism: **ALL** limiters advisory (non-atomic GET+SET, legacy/lib/rate-limit.ts:57) — including secret-guessing surfaces. New: secret-guessing = atomic `reserveAttempt`; abuse throttles = advisory (per CODE-RULES classes).

| Limiter | Legacy | New | Class | Verdict |
|---|---|---|---|---|
| login user | 5/900 advisory | 5/900 (keys.ts:100) | **atomic**, cleared on success | ✅ upgraded |
| login IP | 20/900 | 20/900 | advisory edge | ✅ |
| register email / IP | 3/3600 · 10/3600 | same | advisory | ✅ |
| 2FA verify | 10/900 | 10/900 | **atomic** | ✅ upgraded |
| recovery reset user / IP | 3/3600 · 10/3600 | same (never cleared — enum-safe) | **atomic** / advisory | ✅ upgraded |
| recovery get-key user / IP | 3/3600 · 10/3600 | same | **atomic** / advisory | ✅ upgraded |
| verify-token / verify IP | 10/3600 · 30/3600 | same | advisory | ✅ |
| resend-verify email / IP | 1/60 · 5/60 | same | advisory | ✅ |
| delete-account step-up | 3/1h + 24h lock | 3/**24h** unified (keys.ts:217) | **atomic** | ⚠️ window changed (RL-2) |
| chat send user | 30/60 advisory | 30/60 | **atomic** | ✅ upgraded |
| trial burst IP | 20/60 | 20/60 | **atomic** | ✅ upgraded |
| **trial daily quota** | **5/day token+IP atomic** | **RETAINED** (session+IP `Math.max`, trial-quota.ts:68) + burst 20/60s (rate-limit.ts:23) + **NEW** $50/day global pool | — | ✅ corrected RL-1 |
| media download | 60/60 caller | same | advisory | ✅ |
| share read public IP | 30/60 | same (key renamed) | advisory | ✅ |
| share create user | 20/60 | same | advisory | ✅ |
| roadmap IP | 30/60 | same | advisory | ✅ |
| media share presign IP / re-mint per-shareId | — | 30/60 · 30/60 atomic | ➕ new | |
| newsletter / feedback / admin reads / stats | — | various | advisory | ➕ new |
| speculative reservations | Redis TTL 180s | admission holds (Lua, atomic) | ⚠️ intentional redesign | |

All limiters fail closed on Redis outage (503). Verified.

| # | sev | finding |
|---|---|---|
| RL-1 | 🟠→**CORRECTED** | **The original "quota removed" claim was WRONG** (it even contradicted §2.A line 504, which had it right — an internal inconsistency missed on first pass). Hard-confirmed this session: the per-identity **5/day quota is fully live** — `consumeTrialQuota` enforces `Math.max(sessionCount, ipCount) <= TRIAL_MESSAGE_LIMIT(=5)` (trial-quota.ts:68-83, dual session+IP anti-evasion), called at chat/routes.ts:1112 → 429 `TRIAL_LIMIT_REACHED`; the per-IP **20/60s burst is also live** (consumeTrialBurst routes.ts:1091; TRIAL_BURST_RATE_LIMIT rate-limit.ts:23). The **global $50/day pool** (trial-spend.ts:61) is **purely additive**, not a replacement. Nothing was dropped; the trial defense is strictly stronger than legacy. Verified. |
| RL-2 | 🟡 | delete-account window 3/1h+24h-lock → 3-in-24h (documented keys.ts:213); fat-fingered user locked a full day. Product sign-off. Verified. |
| RL-3 | ⚪ | Secret-guessing surfaces all upgraded advisory→atomic (security improvement, no regression). Key-name changes noted for dashboards; 2fa/recovery lockout key strings deliberately preserved. Verified. |

## 9. Sentry & error-reporting

### 9.1 System map (Verified)
- **Telemetry port** `lib/telemetry/port.ts` — best-effort, `TelemetryErrorChannel = never`, `LiteralMsg` compile-time literals, `captureError` typed to closed `FingerprintCode` union (24 codes, all with exactly one live call site).
- **Fan-out** `fan-out.ts` — Sentry (only captureError sink) + WAE (only emitMetric sink) + Console (only sanctioned console.*), each individually try-guarded.
- **Sentry adapter** locked down: no data collection, no integrations/breadcrumbs, `beforeSend: scrubSentryEvent` — **allowlist rebuild**, drops messages wholesale, re-derives from cause chain (max 5), fail-closed stack parsing; fingerprint `['{{default}}', errorCode]`. DSN-less dev = inert. Flush via waitUntil.
- **Routes:** Result → `respondDomainError` → `createErrorResponse({code})`, no wire message; domain errors logged code-only. Exceptions → single `.onError` in app.ts:590-594 (INTERNAL 500 + captureError), arch-enforced as the only onError.
- **Console patched at entry** (entry.ts:35,41, production-only, content-free suppression marker).

### 9.2 De-facto policy (answer to "should code + Sentry always be a pair?")
**No — they are orthogonal by design, and the codebase is consistent about it:**
- **Expected domain failure** → wire `{code}` + optional code-only log. Never Sentry. (Overwhelming default; all 20+ `no-silent-catch` disables verified to be expected-failure translations, none swallow defects.)
- **Defect** (exception at a boundary) → captureError + generic INTERNAL — never a specific code.
- **Invariant break / financial alarm / fail-closed catalog exclusion** (cron, no HTTP) → telemetry.error + captureError, because Sentry is the only paging channel.
- A specific `{code}` and captureError are essentially never paired on the request path — by design. Recommended policy statement (adoptable): expected→code only · defect→Sentry+generic · invariant→Sentry-as-page rate-bounded · recurring expected ops conditions→WAE metric+digest, NOT Sentry.

All 14 captureError sites categorized: defects (app.ts:592; interpreter.ts:559/981/1037; jobs pass.ts:137-257; admin engine.ts:509/544; cron entries; gc.ts:169) · invariant pages (ledger conservation, snapshot drift, access-log audit, jobs stuck) · expected-but-paged (catalog exclusions refresh.ts:109-154; trial $50 cap trial.ts:162 — deliberate one-per-day).

### 9.3 Enforcement — what exists / what's missing
**Exists:** `catch-swallow/no-silent-catch` (catch must throw/captureError/err()) · `no-raw-console` · `logger-msg-literal` (bans interpolation into fingerprints) · `no-sensitive-log-argument` (advisory heuristic) · SafeLogFields closed 18-key type · FingerprintCode closed union · `onerror-handler-only-in-app` arch rule.

| # | sev | gap |
|---|---|---|
| SE-1 | 🔴 | **No rule confines `@sentry/*` imports to lib/telemetry/adapters** — a direct `Sentry.captureException` bypasses scrubSentryEvent entirely, defeating the content-scrub guarantee. Clone `no-external-cockatiel.mjs` → `no-external-sentry`. Highest-value missing rule. Verified. |
| SE-2 | 🟠 | **Confirmed: all 4 shipped WAE metrics are watcher-less** — written, never read back. `realtime_ws_upgrade_failure` (realtime-room-bindings.ts:128) + `realtime_billable_generation` (:131): the WAE auditor is explicitly deferred until an Analytics Engine SQL client exists (scheduled.ts:46-49). `jobs_queue_depth` (jobs-health-entry.ts:67): its comment claims an ops dashboard watches it, but no dashboard code queries WAE — the actual stuck-work signal is the separate Sentry page (jobs-health-entry.ts:~80). `jobs_oldest_pending_age_seconds` (:69 — the emitted name carries `_seconds`): same, no reader. `realtime_ws_upgrade_failure` has NO alternative alarm — doctrine says every metric has a named watcher or doesn't ship. Founder decision: build the WAE watcher now or accept the deferral. Verified. |
| SE-3 | 🟠 | Recurring expected catalog conditions ride the Sentry defect channel hourly (refresh.ts:109/120/131/154 — per model×resolution, every refresh, indefinitely). Route to WAE metric + digest threshold. Verified. |
| SE-4 | 🟠 | `no-silent-catch` accepts any handling — a genuine defect can be downgraded to `err()` and pass lint; nothing forces captureError for defects. No violations today, but unenforced. Verified. |
| SE-5 | 🟠 | No METRIC_NAMES registry / watcher-existence arch test — "named watcher" is comment convention only. Verified. |
| SE-6 | 🟡 | Raw-error captures rely wholly on port scrub; no regression test guards the scrub allowlist. No lint bans adding a client-side error SDK (absence is dependency-enforced only — verified apps/web/admin/marketing have none). |
| SE-7 | ⚪ | Doctrine otherwise followed well; `AllBranchesFailedError` routing and one-per-day trial alarm are exemplary. |

### 2.D Media / storage

| Feature | Legacy | Status | New | Note |
|---|---|---|---|---|
| no client PUT presign (writes Worker-internal) | media-storage.ts header | ✅ | ports/storage.ts:11-13 | same stance both sides |
| upload size cap | MAX_MEDIA_OBJECT_BYTES at put (throw) | ✅ | storage-r2.ts:172-174 (Result) | same constant |
| **MIME validation at put** (founder-ruled) | upstream only (media-pipeline.ts:124-129) | ✅ hardened | storage-r2.ts:182-187 at the put seam | fix present |
| download presign member path + epoch-gated authz (blind 404) | routes/media.ts two-step JOIN | ✅ | presign-authz.ts:84-94 memberAllows | identical semantics |
| link-guest access (x-link-public-key) | resolveLinkGuestByKey | ✅ | caller.ts:16,40-45; half-auth sessions excluded | |
| **public share presign, unauthenticated** | inline in share GET (message-shares.ts:117-155) | ✅➕ | media/routes.ts:127-159 `public` class, bare shareId, shareAllows (presign-authz.ts:96-108) | **resolves IC-3 — endpoint exists and is correct** |
| storage keys uuid, never content-addressed | uuid media/ prefix | ✅ | storage-keys.ts:1-99 + assertUuid; new `inputs/` staging class w/ run binding | |
| orphan GC | flat 24h cutoff, parallel-50, 25s budget (r2-gc.ts) | ⚠️ | derived min-age = max deadline + 900s; sequential failure-isolated deletes (gc.ts:31,158-178) | safe, behaviorally different (🟡) |
| GC staging sweep | — | ➕ | inputs/ prefix @3600s TTL (gc.ts:90-94) | crashed-upload reclaim |
| account-deletion reclaim | inline sync, 900-delete cap | ✅⬆ | media.reclaimUser.v1 durable job, heartbeat chunks 25, bulk shard | improvement |
| TransformCompute port + pure transforms | — | ➕ | ports/transform-compute.ts; strip-image-metadata etc. | per design |
| download mint limit 60/60 | redis-registry.ts:159 | ✅ | rate-limit.ts:41-47 (values preserved) | |
| share presign limits | shareGet 30/60 IP | ✅➕ | 30/60 IP + new per-shareId re-mint 30/60 atomic | hardening |
| presign TTL ceiling | none | ➕ | MAX_PRESIGN_TTL_SECONDS=3600, oversized rejected | hardening |

### 2.E Emails — complete inventory

| Email | Legacy | New | Status |
|---|---|---|---|
| Verification (register + resend) | opaque-auth.ts:608,1387 | registration.ts:313; email-verification.ts:119 | ✅ subject preserved |
| Welcome | opaque-auth.ts:620 | registration.ts:295 | ✅ (+ dead 2nd path — EM-1) |
| Account-locked (login lockout) | opaque-auth.ts:111 | login.ts:145 | ✅ + lockoutMinutes param |
| 2FA enabled / disabled | :1146/:1284 | totp.ts:138; two-factor-disable.ts:144 | ✅ |
| Password changed | :1516 | credentials.ts:83 | ✅ |
| Password reset | :1624 (distinct subject "reset") | same port as "changed" (routes.ts:623,712) | ⚠️ EM-2 subject parity |
| Account deleted | delete-user.ts:142 | deletion.ts:317 | ✅ |
| Chargeback lock | — | payment-webhook.ts:273 | ➕ |
| Admin op notification / daily digest | — | engine.ts; admin-digest-entry.ts:74 | ➕ |
| Newsletter confirm / issue (RFC 8058 one-click unsub) | — | newsletter slice | ➕ |
| Low-balance | none | none | ✅ (absence parity) |

**All 8 legacy emails retained; 5 net-new; none dropped.** Verified.

### 2.F Push / device tokens
Registration upsert ✅ (path moved → /notifications/device-tokens — confirm mobile client, EM-4) · unregister ✅ (+{deleted} disambiguation) · FCM HTTP v1 both sides, no APNs either side ✅ · recipient rules identical (skip muted/sender/present; presence now via DO PresenceReader) ✅ · payload content-free ✅ · fire-and-forget preserved ✅ · badge/unread: absent both sides ✅ · invalid-token pruning absent both sides (⚠️ carried-forward gap, EM-5) · new per-send success/failure accounting ➕.

## 21. Duplication — email scaffolding (part 1)

**Verdict: single shared layer, no duplication (Verified).** ONE template/layout layer (`notifications/domain/templates/base.ts` + `builder.ts` — all 13 templates incl. newsletter use `defineEmailTemplate`), ONE Resend client (`email-resend.ts`, single+batch, zero other resend hits), ONE compose-and-send seam (`adapters/send-email.ts`). Per-email adapters are thin subject+template+link wrappers. Retry policy single-sourced in the Resend adapter; suppression single-sourced in newsletter slice.

| # | sev | finding |
|---|---|---|
| EM-1 | 🟠→resolved | `provisionUserBilling` (billing/domain/wallets.ts:86) **is dead — zero production callers** (barrel exports + own tests only); the live path is `provisionWalletsWithinTx` (no email, registration.ts:279) + exactly one welcome send via `dispatchRegistrationSideEffects` (registration.ts:295). No double-send is possible; delete the dead function. Verified. |
| EM-2 | 🟡 | **Confirmed copy regression:** recovery-reset binds the same port as change-password, whose subject is the hard-coded `PASSWORD_CHANGED_EMAIL_SUBJECT = 'Your password was changed'` (adapters/password-changed-email.ts:6,25); legacy recovery sent 'Your password was reset' (origin/main opaque-auth.ts:~1625). Cosmetic wording regression — founder copy decision. Verified. |
| EM-3 | 🟡 | GC semantics changed (derived min-age, sequential deletes) — safe, flag for awareness. Verified. |
| EM-4 | 🟡→resolved | Device-token route path changed. **Resolved in §2.J.3: the Capacitor client targets the new path — `client.notifications['device-tokens'].$post` (use-push-notifications.ts:28-45).** Verified both sides. |
| EM-5 | ⚪ | FCM stale-token pruning absent (both sides — pre-existing). |

## 7. Env vars

### 7.1 Existence-branching compliance sweep
Sanctioned machinery verified: single `createEnvUtilities` path (fail-fast on missing NODE_ENV, env.ts:39), raw `c.env` reads confined to bootstrap middleware per app-env.ts:22-28, per-mode `env.config.ts` with zero `??` fallbacks. The `env.X === undefined → throw` guards in factories are **fail-fast, not behavior branches** — sanctioned (push/email/payment factories, storage requireBinding, OPENROUTER key, pipeline-admin, SENTRY_DSN, etc.). WAE/CONVERSATION_ROOM checks are Worker **bindings**, not env vars — sanctioned.

Violations found:
| # | sev | site | pattern |
|---|---|---|---|
| ENV-1 | 🟡 | middleware/cors.ts:63-64 | existence-branch on FRONTEND_URL / FRONTEND_PREVIEW_URL (`=== undefined ? [] :`) — existence used as mode proxy; should branch on mode / fail-fast |
| ENV-2 | 🟡 | web payment-form.tsx:64-68 | non-prod return chosen by VITE_HELCIM_JS_TOKEN existence |
| ENV-3 | 🟡 | web sidebar-footer.tsx:104,112 | dev menu items rendered on VITE_DRIZZLE_STUDIO_URL/VITE_ADMIN_URL truthiness (inside DevOnly, still the banned pattern) |
| ENV-4 | 🟡 | packages/db/drizzle.config.ts:9 | `process.env[MIGRATION_DATABASE_URL] ?? DATABASE_URL` — direct read + `??` fallback (tooling, but rule is unconditional) |
| ENV-5 | 🟡 | admin admin-nav.tsx:51 | direct `import.meta.env` read with bare cast, no parse |
| ENV-6 | ⚪ | 3 factory comments claim "createEnvUtilities defaults missing NODE_ENV to development" — now false (it throws). Wrong comments, fix. |

Legacy tree has many direct reads — excluded from gates by convention, noted only.

### 7.2 New env vars / secrets (18 new, all justified)
| Var | Purpose | Verdict |
|---|---|---|
| OPENROUTER_API_KEY (+_RESTRICTED/_PRODUCTION mappings) | inference key, replaces gateway key | ✅ |
| TELEMETRY_SINKS / SENTRY_DSN | per-mode sink registry / Sentry sink | ✅ |
| ADMIN_URL / ADMIN_ACTOR_ALLOWLIST / ADMIN_SQL_PANEL_DATABASE_URL / CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD | admin plane (CSRF origin, in-Worker allowlist, SELECT-only SQL role, Access JWT verify) | ✅ |
| CF_ACCESS_DEV_PRIVATE_JWK | dev-only admin JWT mint, absent in prod, test-pinned | ✅ |
| CLOUDFLARE_ACCESS_LOG_API_TOKEN / CLOUDFLARE_ACCOUNT_ID | access-log audit cron | ✅ |
| APP_BUNDLE_CHECKSUM_{IOS,ANDROID,ANDROID_DIRECT} | OTA bundle sha256, minted at deploy, prod-only | ✅ |
| RESEND_WEBHOOK_SECRET | Resend webhook verification | ✅ |
| VITE_ADMIN_URL / VITE_CRAWLER_VIEW_URL / VITE_WEB_URL | dev links / admin→web link | ✅ |

**Removed:** AI_GATEWAY_API_KEY ✅. **Dead but still shipped:** PUBLIC_MODELS_URL (Vercel gateway URL, all modes incl. Production — cross-confirmed with §15 OR-2). SERVICE_NAMES.AI_GATEWAY dead. No orphan secrets outside the registry; all generated files derive from it.

### 7.3 Redis key registry — PASS, stronger than legacy
Mechanism `lib/redis/define-key.ts` (+ typed operations with schema-validated read AND write); **108 typed entries** across slice-local registries (legacy: one monolith ~81). **Zero raw key construction** in non-legacy code. Minor: SET ops (sadd/srem/smembers) lack a typed wrapper so 3 sites call the raw client on registry-built keys; trial-quota.ts:53 re-implements redisIncr logic (DRY). packages/realtime holds no keys (injected ports) — correct.

### 7.4 Error-code / friendlyErrorMessage parity
Backend: **PASS airtight** — uniform `createErrorResponse`, zero `c.json({error})`, zero wire `message` fields, `ERROR_MESSAGES satisfies Record<ErrorCode,string>` makes code-without-message a compile error, strict `errorResponseSchema`.

| # | sev | finding |
|---|---|---|
| ENV-7 | 🟠 | version-check.ts:69-76 spreads `currentVersion`/`updateUrl` as top-level siblings of `code` — violates strict `{code, details?}` contract (client re-validating with shared schema rejects it). Move into `details`. Verified. |
| ENV-8 | 🟠 | Frontend runs TWO error systems: new `friendlyErrorMessage` AND legacy `legacyFriendlyErrorMessage`/`ERROR_CODE_*`. Two code→copy homes violate SSOT. Migrate + delete legacy exports. **Refined by §2.G.8 (FE-4): within `apps/web` the residual is 6 files / ~8 `legacyFriendlyErrorMessage` sites + 1 `ERROR_CODE_*` consumer (the ~49 figure was repo-wide incl. packages/ui `use-async-action.ts`); modern helper adopted in only 2 files. Cross-ref §10+21 LEG-1: rename before Phase-6.** Verified. |
| ENV-9 | 🟡 | Wire-code taxonomy narrowed **128 legacy → 81 new** (counts corrected from the ~120→86 first estimate; 51 survive by name, 77 legacy codes dropped, 30 new-only). Payment/media/stream specifics collapse into the 8-kind `DomainError` map. **Correction: legacy never had granular payment-decline codes** — exactly one `PAYMENT_DECLINED` + free-text; the new design carries *more* signal (a preserved `declineReason` string). The genuine granularity losses with **already-written copy sitting unwired** are the media-modality errors (UNSUPPORTED_MODALITY defined at error-codes.ts:31 with zero emit sites; resolution/duration/config) and 3 streaming errors (CONTENT_POLICY, CONTEXT_LENGTH_EXCEEDED, NETWORK_ERROR). Founder Q5. Verified. |
| ENV-10 | ⚪ | CODE-RULES.md §Error Responses points at `schemas/api/error.ts` + `error-messages.ts` — stale; new home is `error-codes.ts`. Doc fix. |

## 13. Jobs / DO test fidelity

### 13.1 Implementation map (Verified)
Dispatcher DO shell `packages/realtime/src/job-dispatcher.ts` (ensureCore single-flight :44, alarm :72, /wake :64) · scheduling core `job-dispatcher-core.ts` (`resolveDispatcherShard` :43 — the ctx.id.name revival fix, persists shard to DO storage; arm-first 30s :79/:113; idle ladder 60s→30m :86, **in-memory idleStep** :91; wake=min-forward :96; wake-overwrite race :126) · pass `apps/api/src/lib/jobs/pass.ts` (sweep→dead-letter→claim→execute, drain-chained, raceLease :93, 250ms re-arm floor) · claim SQL `claim.ts` (FOR UPDATE SKIP LOCKED single statement :33-61, lease on DB clock, dead-letter at claim) · completion fence `complete.ts` (:38 id+running+claimedBy+claims; heartbeat :162; cancel-wins) · lossy wake `wake.ts` · read-only auditor `health.ts`.

### 13.2 Test inventory
| File | Exercises | Runtime | Does NOT prove |
|---|---|---|---|
| job-dispatcher-core.test.ts | arm-first, ladder, wake races, **30-seed property test** (alarm-always-armed + drains), shard-revival regression :327 | node, fake clock | real alarms/storage; idleStep loss |
| workers-validation/job-dispatcher.workers.test.ts | real `runDurableObjectAlarm`, re-arm, wake self-fire, **shard persist + nameless-revival regression** :94 | **workerd** | scripted fake executor — no real pass/PG |
| workers-validation/conversation-room.workers.test.ts | WS upgrade/reject metric, typing, auto-pong, **hibernation attachment round-trip**, **deadline alarm→stop→run-finished**, held-stream, eviction 1008 | **workerd** | fake claimRun/settlement; no evict-and-reconstruct; no replay under workerd |
| packages/db do-finalize.workers.test.ts | interactive txn + real row lock (55P03) **inside a DO** via neon-proxy | **workerd + neon-proxy** | bespoke txn-executor, not real pass/settle; NOWAIT not SKIP LOCKED |
| jobs/pass.integration.test.ts | real pass, 2-executor claim-once, crash-before-commit, fence-lost, dead-letter, drain | node + real PG | same-process concurrency; not workerd; no wall-clock lease |
| claim/complete/lifecycle/health .integration | eligibility, lease reclaim (pre-aged), fence writes, zombie loses, redrive/discard/prune, stuck probes | node + real PG | timing; auditor→wake loop |
| wake.test.ts | posts to shard DO, swallows failures | node fake namespace | real cross-DO delivery |
| settlement tests (workflows unit, chat integration, idempotency integration) | settle() invariants, ONE deterministic crash point, saved⟺billed, retry | node (unit in-memory / integration real PG) | randomized crash matrix; settle-inside-DO |

### 13.3 Not proven — ranked by prod risk
| # | risk | gap | close with |
|---|---|---|---|
| JD-1 | 🔴 HIGH | **Real `pass.ts`/`settle()` never runs inside a DO under workerd** — workerd tests use scripted fakes; do-finalize proves only a generic txn. Driver/waitUntil/connection behavior diffs invisible. | vitest-pool-workers test binding real executor + neon-proxy, full pass via runDurableObjectAlarm |
| JD-2 | 🔴 HIGH | **Promised randomized settlement crash-injection suite (§8: settle × retry-claim × cancel, crash between every statement pair) does not exist** (repo-wide grep). Only 1 deterministic crash point tested. | seeded fuzzer (reuse seeded-prng.ts) against real PG asserting exactly-once + saved⟺billed |
| JD-3 | 🟠 | Platform alarm semantics (delivery, retry-on-throw, max-cap vs 30-min idle target) never exercised — all tests force-fire | miniflare timer-advance; assert idle target ≤ platform cap |
| JD-4 | 🟠 | in-memory `idleStep` lost on eviction — reconstructed dispatcher re-decays from 60s; benign-but-unverified | workerd evict-mid-decay test |
| JD-5 | 🟡 | Real multi-isolate SKIP LOCKED contention (current test = one process, one pool) | two-isolate workerd race |
| JD-6 | 🟡 | neon-proxy ≠ real Neon (cold start, WS driver, latency); planned latency-injection mode (BACKEND-REDESIGN.md:2854) **not implemented** | implement latency injection + staging e2e |
| JD-7 | 🟡 | wake() cross-DO delivery from product worker (fake namespace only); mitigated by perpetual alarm | e2e enqueue→first-attempt latency assertion |
| JD-8 | 🟡 | wall-clock lease expiry/heartbeat (only pre-aged rows); auditor→wake remediation loop unwired in tests | short-lease real-sleep test |

### 13.4 ConversationRoom verdict
Platform glue well proven under workerd (upgrade, hibernation serialize, deadline alarm, eviction). The docs' "verify at implementation: DO-finalize vitest path" is **partially discharged** — platform capability proven, but the actual room running the actual `settle()` is never composed under workerd; replay/Last-Event-ID is node-only. The shard-identity revival bug has explicit regression tests in both runtimes ✅.

## 14. Admin plane

### 14.1 Ops registry (17 ops — plan §9 listed 11; feedback/banner/newsletter added later)
| Op | Inverse | Guardrail | Audit in-tx | exec | undo RT | preview-RB | caps | interleaving |
|---|---|---|---|---|---|---|---|---|
| wallet.credit / wallet.clawback | each other | $1k maxAmountNanoUsd | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ + conservation |
| user.lock / user.unlock | each other | — | ✅ (+session.revoke.v1 in-tx) | ✅ | ✅ | ✅ | n/a | ✅ |
| sessions.revokeAll | — (ephemeral) | — | ✅ | ✅ | n/a | ✅ | n/a | ephemeral-effect test |
| job.redrive | — (ephemeral) | — | ✅ | ✅ | n/a | ✅ | n/a | ✅ |
| job.discard / job.restore | each other | — | ✅ | ✅ | ✅ | ✅ | n/a | ✅ |
| model.disable / model.enable | each other | — | ✅ | ✅ | ✅ | ✅ | n/a | ✅ |
| share.revoke / share.unrevoke | each other | — | ✅ | ✅ | ✅ | ✅ | n/a | ✅ (+evict) |
| feedback.setStatus | self | — | ✅ | ✅ | ✅ | ✅ | n/a | ❌ AD-3 |
| banner.set | self | 20-msg Zod cap (not guardrail metadata) | ✅ | ✅ | ✅ | ✅ | n/a | ✅ |
| newsletter.schedule / cancel | each other | — | ✅ (+dispatch job in-tx) | ✅ | ✅ | ✅ | n/a | ❌ AD-3 |
| newsletter.testSend | — (ephemeral) | — | ✅ | ✅ | n/a | ✅ | n/a | ephemeral-effect test |

### 14.2 Structural laws — verification results (all Verified)
| Law | Verdict |
|---|---|
| (a) audit commits in same tx as effect | ✅ engine.ts:337 on engine-owned SettlementTx; injected-failure battery test proves atomicity; guardrail-refusal rows deliberately outside tx (no effect to be atomic with) |
| (b) preview = execute rolled back | ✅ shared `performOp` (engine.ts:308); PreviewRollback throw; no parallel impl; pinned by battery |
| (c) inverse enforced at registration | ✅ **construction-time**: contract constructor throws durable+null (contract.ts:144-151); registry boot throws if inverse not registered (registry.ts:156-169); branded registry type proves gate ran |
| (d) no external calls in op bodies | ✅ arch rule admin-op-purity (bans infra imports, /adapters/, fetch AST-walk); effects deferred post-commit; ⚠️ rule doesn't itself catch raw Date.now/Math.random (clock injected everywhere today — AD-5) |
| (e) allowlisted email claim + service-token fail-closed | ✅ pipeline-admin.ts:159-169; RS256/EdDSA pinned; uniform 401; common_name test at pipeline-admin.test.ts:234 |
| (f) dev-admin mint dev-only | ✅ throws without CF_ACCESS_DEV_PRIVATE_JWK (absent in prod registry); route dev-only-classed |
| (g) admin owns only admin_audit | ✅ AdminStores = getAuditForUndo + insertAudit only; append-only via UPDATE/DELETE/TRUNCATE triggers (migration 0050); undoes UNIQUE = exactly-once undo |
| SPA generic | ✅ single OpForm rendered from contract-derived descriptors; catalog from GET /admin/ops; no per-op form code |

### 14.3 Reversibility testing — the enforcement answer
Per-op `describeAdminOp` battery is strong (preview-nothing, preview≡execute, injected-failure atomicity, replay, undo round-trip + undoes threading, second-undo conflict, guardrails both modes, ephemeral post-commit-only). **But it is not structurally mandated:** the exhaustiveness tests check only static facts (inverse declared, impl exists) — nothing asserts `describeAdminOp` was invoked. The admin CLAUDE.md's claim that the exhaustiveness test fails builds without the battery is **false as built**. A new op can ship with zero reversibility test and green CI.

**Proposed enforcement (concrete):**
- **Tier 1 (immediate):** `describeAdminOp` pushes `contract.name` into a module-level `REGISTERED_BATTERIES` set; an aggregating test asserts it equals `ADMIN_OP_NAMES`. (Or an arch rule: every operations/<x>.ts must have a sibling integration test containing a `describeAdminOp(` call for that contract — mirrors idempotency-exemption-wrappers.rule.ts.)
- **Tier 2 (real enforcement):** registry-driven generic harness — `AdminOpFixtures[opName]` registry (seed target rows + validInput + projection, promoted from the existing hand-written batteries), then for every durable op: snapshot → execute → undo(inverseInput, undoes:auditId) → snapshot; assert projection equality (excluding append-only trails), auditCount=2, second undo → conflict. `REVERSIBILITY_EXCLUSIONS: Record<opName, reason>` — a durable op with neither fixture nor justified exclusion **fails the build**. Optionally fold interleaving via per-op seeded-actions defaulting to empty.

### 14.4 Admin e2e
21 tests across e2e/admin (op-lifecycle flagship incl. mid-flow preview-commits-nothing + doubly-linked audit thread; guardrails over-cap audited refusal; user-lock two-effect + lockReason restore; jobs conflicts; auth-boundary Single-Auth-Path live; SQL panel write-refusal + carve-outs; models kill-switch; palette/actor attribution). Access faked at the real JWKS seam via dev mint. **Correction (Verified against ci.yml this session): the e2e CI job is LIVE — no `if: false` exists anywhere in ci.yml; `e2e` (needs: gitleaks, e2e-build) runs the full matrix and deploy requires it (§17/§18 are correct; the earlier `if: false` claim was stale).**

### 14.5 Section findings
| # | sev | finding |
|---|---|---|
| AD-1 | 🟠 | Battery not mandatory — no enforcement that a registered op invokes `describeAdminOp`; CLAUDE.md claim aspirational. Tier-1 fix. Verified. |
| AD-2 | 🟠 | No generic registry-driven round-trip harness — inverse *existence* enforced by construction, inverse *correctness* by convention. Tier-2 fix. Verified. |
| AD-3 | 🟡 | feedback.setStatus, newsletter.schedule/cancel lack the interleaving property test; exclusion defensible but undocumented. Verified. |
| AD-4 | 🟡 | `maxTargets` guardrail field defined in contract type but unimplemented in engine (only maxAmountNanoUsd checked, engine.ts:208-227); banner cap is Zod validation not audited guardrail. Latent for multi-target ops. Verified. |
| AD-5 | ⚪ | admin-op-purity rule doesn't catch raw Date.now/Math.random (no live violation); engine composes byKey primitives rather than literal `idempotent.byKey` (documented, CLAUDE.md wording stale). Verified. |

## 12. API & browser security

(Rate limiting, OPAQUE, session-revocation pipeline, admin Access JWT covered in §5/§11/§14.)

| Area | Legacy | New | Verdict |
|---|---|---|---|
| CSRF | per-prefix Origin check (legacy/app.ts:63-96) | **global** `root.use('*', csrfProtection())` + ADMIN_URL origin + explicit webhook/token-login exemptions (csrf.ts:43-83) | ➕ strict improvement |
| CORS | `/api/public/*` → `origin:'*'` all methods | wildcard only for non-allowlisted **AND** route-class `public`, credential-free, `Vary: Origin`, fail-closed on 500 (cors.ts:53-73) | ➕ tighter |
| CSP (API) | frame-ancestors none, script-src self | identical + applied in `finally` (500s/404s carry it) | ✅ |
| HSTS / Permissions-Policy (API) | **absent** | added (security-headers.ts:25,34-43) | ➕ |
| CSP (web/marketing) | — | per-route hashed CSP + trailing-slash dual-emit (generate-headers.ts:343) — **the mailing-list CSP-route fix; coverage correct** | ➕ |
| CSP (admin SPA) | — | **none — assets Worker has no _headers, no meta CSP** | ❌ SEC-2 |
| Cookies | hushbox_session, httpOnly, Secure(prod), SameSite none/lax, 30d | byte-for-byte parity + zod-validated claims (principal.ts:17-28) | ✅ |
| WS security | SSE (CORS-governed) | handler resolves caller + authorizes membership before DO proxy; DO trusts only worker-set params (DO not client-reachable); link-guest via header or `?linkPublicKey=` re-checked | ✅ but SEC-1 |
| Input validation | — | effectively complete; un-schema'd reads are registry-gated / authz-scoped / HMAC-verified | ✅ |
| Body limit | — | 40 MiB edge bodyLimit, 413 uniform (body-limit.ts) | ✅ |
| Path traversal / storage keys | — | UUID-regex validated all segments, traversal structurally impossible | ✅ |
| SSRF (roadmap/presign/webhooks) | — | fixed Linear URL; server-derived presign keys; inbound-only webhooks | ✅ |
| Timing-safe compares | — | HMAC via constantTimeCompare; tokens are high-entropy UUIDs via DB lookup; billing token SHA-256 hashed | ✅ |
| IP keying | — | cf-connecting-ip first (unspoofable behind CF); XFF fallback dev-only | ✅ |

| # | sev | finding |
|---|---|---|
| SEC-1 | 🟠 | **No Origin validation on the WS upgrade** (public GET, CSRF-exempt, CORS doesn't gate WS) + `SameSite=None` cookie = cross-site WebSocket-hijacking surface: a malicious page can open an authenticated socket as the victim (bounded by per-conversation membership + broadcast-time liveness). New-architecture surface (legacy was SSE/CORS-governed). Add an allowlist Origin check on the upgrade handler mirroring csrfProtection's set. Verified code; the cross-site-open exploit path follows directly from the verified mechanics (public GET + SameSite=None) but was not exercised live — escalated as founder question Q4. |
| SEC-2 | 🟡 | **Admin SPA served with zero security headers** (no CSP, X-Frame-Options, HSTS at the document level — assets-only Worker, no _headers). API responses carry headers but the admin document doesn't. Mitigated by Access gating the hostname, but the authed admin UI is framable/XSS-unconstrained at the shell. Add a _headers generator like the web app's. Verified. |
| SEC-3 | 🟡 | ADMIN_URL in CSRF allowlist but not CORS allowlist (asymmetry; not breaking — admin API is same-origin). No `__Host-`/`__Secure-` cookie prefix (Secure+HttpOnly present; prefix incompatible with cutover unseal). Verified. |
| SEC-4 | ⚪ | Positives to log: global CSRF, HSTS+Permissions-Policy added, class-driven CORS wildcard, fail-closed CORS on 500. No `Access-Control-Max-Age` (perf only). |

## 17. Cassettes & CI real-API

| Aspect | Legacy | New | Verdict |
|---|---|---|---|
| On-disk store / hash algo / body canonicalization | `.ai-cassettes/{v}/{hash}.json`, sha256→16hex, canonicalJson | identical (cassette-store.ts, canonical-request.ts:124) | same |
| **Header allowlist** | 4 headers incl. ai-model-id | **content-type+accept only** (canonical-request.ts:44), no version bump | ⚠️ CAS-1 |
| record/replay policy | hit→replay; miss<400→record; ≥400→no-cache | identical | same |
| committed? / CI persistence | gitignored / actions/cache | gitignored / actions/cache per-run key + prefix restore | same; repeat runs charge once ✅ |
| verify:evidence | asserts service rows | `--require=openrouter` (test job), `--require=helcim`/`hookdeck` (e2e) | ✅ still asserts real paths ran |
| request capture | no | new optional `request` field (assert ZDR without re-issue) | ➕ |

CI real-API coverage: **OpenRouter** real via cassette record-on-miss in the test job (OPENROUTER_API_KEY_RESTRICTED), asserted; **Linear** read real, asserted; **Helcim sandbox + Hookdeck** real on e2e chromium only; **Resend + FCM** have evidence adapters but are **mocked/unasserted** in CI (CAS-3). The **e2e job is re-lit (NOT `if: false`)** — full 7-project matrix, hard dep of deploy.

| # | sev | finding |
|---|---|---|
| CAS-1 | 🟠 | Header-allowlist narrowed without bumping `AI_RECORDING_VERSION` (stays 'v1') — violates the store's own rule #2; legacy v1 cassettes become unreplayable (one-time re-record charge at cutover), "shared store" claim half-true. Bump the version for a clean dir. Verified. |
| CAS-2 | 🟡 | Stale `--require=ai-gateway` in verify-evidence.ts:9,35 usage docs (CI uses openrouter). Verified. |
| CAS-3 | 🟡 | Resend + FCM integration paths not real-exercised or asserted in CI (no sandbox, no evidence require) — gaps if "assert every integration ran" is the intent. Verified. |

## 18. Rule enforcement in CI

**All 16 vendored ESLint rules + 6 ts-morph arch rules run in CI (lint job + arch:check) and pre-push.** Coverage gate (per-file 95, `perFile:true`) is **live in CI** (every package `test` runs `--coverage`; the "pending flip" is done). jscpd/knip/gitleaks/migration-drift all hard CI gates. **No `continue-on-error`, no `if: false` in ci.yml**; deploy requires all of [lint,typecheck,duplication,unused,test,build,e2e,mobile-test].

| # | sev | finding |
|---|---|---|
| CI-1 | 🟠 | **Prettier enforced nowhere automatically** — `format:check` exists but no CI job, absent from pre-push AND pre-commit (hook runs only generators). `docs/DEVELOPMENT.md:43` falsely claims "pre-commit runs Prettier and basic lint". Formatting drift can land on main. Verified. |
| CI-2 | 🟠 | **turbo cache masks the coverage/test gate on pre-push** — only the CI test job sets `TURBO_FORCE:true` (ci.yml:184); `pnpm test` at pre-push replays warm cache and can skip the coverage gate locally (CI protected). Add TURBO_FORCE to pre-push TEST_TASK. Verified (matches known turbo-cache-masks issue). |
| CI-3 | 🟡 | migration-drift is CI-only (not in pre-push); stryker mutation testing is schedule-only, not a PR gate. Verified. |
| CI-4 | ⚪ | Positives: coverage centralized in shared root vitest config (heap flag, no one-offs); workers-pool isolate:false correctly package-scoped; robust custom-rule suite. |

## 19. Infra changes

- **turbo.json:** `test` caches `coverage/**` on test-file inputs — the cache-masking surface (CI-2). Otherwise sound; dev/test:ui correctly `cache:false`. Minor: `test` task doesn't list the shared `@hushbox/config/vitest` as an explicit input the way lint/typecheck list their shared configs.
- **vitest:** memory tuning (pool:forks, 50% workers, 8GB heap) centralized in `packages/config/vitest.config.ts` — repo-wide, no one-offs (positive). api uses `projects` + static coverage-include globs + perFile to force never-imported files to 0%. Workers pools (`isolate:false`, `fileParallelism:false`) correctly scoped to db/realtime `test:workers` only. The api coverage-timing DB-isolation flake relies on global `retry:1`, no one-off mitigation.
- **wrangler.toml:** new JOB_DISPATCHER DO (migration v2), crons expanded to 4 entries, WAE_METRICS dataset, admin.hushbox.ai/api/* route, ADMIN_URL/TELEMETRY_SINKS vars, secret churn (AI_GATEWAY_API_KEY→OPENROUTER_API_KEY, +RESEND_WEBHOOK_SECRET/SENTRY_DSN/CF Access). `[observability] enabled=false` is deliberate (avoids logging /admin/sql?query=…) — a monitoring tradeoff to note.
- **INF-1** 🟡→resolved — **Verified: `scheduled.test.ts:57-73` reads wrangler.toml, extracts the crons array, and asserts ordered length-exact equality with the four schedule constants** (`JOBS_HEALTH_CRON`, `ACCESS_LOG_CRON`, `HOURLY_MAINTENANCE_CRON`, `DAILY_RETENTION_CRON` — scheduled.ts:52-57; wrangler.toml:38). A fifth, missing, or reordered cron fails the test.

## 20. E2E suite

**Verdict: unusually mature, doctrine largely lint-enforced** (`eslint.config.js:527-710` — zero manual violations of waitForTimeout/.only/networkidle/serial/inline-timeout/literal-testid/db-import/raw-page.request). ~240 non-admin tests + ~28 admin across 7 browser/persona projects. `fixtures.ts` is a standout (per-page console+API-error auto-fail, strict network allowlist, HAR-on-failure, request-retry). Signal architecture contract-tested (contracts/signals.spec.ts).

Confirmations from memory items: message-queue **hold-stream knob implemented** (no longer blocked); feedback e2e **fully wired, not run-blocked**.

Coverage gaps: 2FA recovery/backup codes ❌ · user media **upload** ❌ (only AI generation) · explicit stop-active-stream ⚠️ · marketing landing/pricing/blog render ❌ · Capacitor native shell ❌ · usage transaction-ledger detail ⚠️ · accessibility-pref toggles ⚠️.

| # | sev | finding |
|---|---|---|
| E2E-1 | 🟠 | Harness-bypassing specs (demo, marketing-leaderboard, marketing-roadmap, ui/personas, api/health) import `test` from raw `@playwright/test` → no console/API-error auto-fail, no network allowlist; demo runs the whole app shell so a live third-party leak/console error passes silently. Route through fixtures.js + add a lint rule banning raw `@playwright/test` import in specs. Verified. |
| E2E-2 | 🟠 | Coverage holes on near-ship surfaces: 2FA recovery codes, user media upload, stop-active-stream, marketing pages, Capacitor shell. Verified (absence). |
| E2E-3 | 🟡 | Conditional assertions that can silently no-op: auth-member-access.spec.ts:52-55,138; group-chat-admin.spec.ts:548-554; multi-model.spec.ts:82-96; chat.spec.ts:211-214. Empty `test.fixme` stub account-deletion.spec.ts:489 reads as coverage that doesn't exist. Verified. |
| E2E-4 | 🟡 | 11 serial describes exist only because chat/auth specs share one seeded persona — per-worker isolated users would unlock fullyParallel (biggest speed/determinism win). Brittle demo positional tile selectors + marketing UI-copy matchers. Verified. |
| E2E-5 | ⚪ | Default retries CI:2/local:1 (retries=0 is opt-in via e2e:fast/stress) — consistent with doctrine. |

### 2.H Workflow engine, settlement & idempotency compliance

**Scope:** `apps/api/src/slices/workflows` (engine/compile/builder), `chat/domain/settlement.ts`, `billing/domain` (admission, charge, money), `lib/idempotency/*`, `packages/shared/src/type-tag.ts`, `packages/config/{arch,eslint-extensions}`. Every claim below is **Verified** against read source (file:line); design gaps are called out as founder questions.

#### 2.H.1 Node registry — closed set, versioned, statically closed

`engine/node-registry.ts:35-57` — `hasNode(type, version)` is an **exhaustive `switch` over `NodeType` with no `default`** (TS enforces totality; a new node type fails to compile). There is **no dynamic registration API** — the registry is a pure function of `NodeRegistryDeps`, minted once in the composition root. Versions are pinned constants: `MODEL_CALL_IMPL_VERSION`, `SMART_MODEL_IMPL_VERSION` (`live-execution-registry.ts`), and `CONTROL_FLOW_IMPL_VERSION = 1` for `fanOut/fanIn/branch/loop` (`node-registry.ts:21`). `transform`/`subWorkflow` defer their `(name, version)` pin to `resolveValuePorts` (media compute registry / catalog).

| Node | Implemented? | Versioned pin | Evidence |
|---|---|---|---|
| `modelCall` | ✅ | `MODEL_CALL_IMPL_VERSION` | node-registry.ts:37-38, 90-92 |
| `smartModel` | ✅ (7th type beyond the documented set) | `SMART_MODEL_IMPL_VERSION` | node-registry.ts:40-41, 59-83 |
| `transform` | ✅ via media compute registry | `(name,version)` in `resolvePorts` | node-registry.ts:96-98 |
| `fanOut` / `fanIn` / `branch` / `loop` | ✅ interpreted inline | `CONTROL_FLOW_IMPL_VERSION=1` | node-registry.ts:43-48 |
| `subWorkflow` | ❌ **deferred — always fails closed** | resolver returns `undefined` → `node_config_unresolved` | node-registry.ts:99-104 |

Two divergences from the architecture doc's node list: (a) `smartModel` is a **seventh** node type not in the documented set; (b) `subWorkflow` is registered in the type gate but **has no implementation** — `resolveValuePorts` unconditionally returns `undefined`, so any definition using it fails to compile. Closed-set and fail-closed both hold; the deferral is documented in-code.

#### 2.H.2 TypeTag algebra — 4-rule laws, `zodFor`, edge checks

`packages/shared/src/type-tag.ts` is a clean, closed algebra. The four rules are Verified exactly as designed:
- **Exact equality, never bare json:** `JsonTag` carries a mandatory `schemaName`; `jsonTag('')` throws (`type-tag.ts:84-89`); L2 compares `from.schemaName === to.schemaName` on the **registered name**, never the resolved schema (`:139`). The runtime grammar (`TypeTagSchema`) has no bare-json variant (`:67`).
- **Media subset:** `isMediaAssignable` requires `from.modality === to.modality` (L3) **and** `from.mimeTypes ⊆ to.mimeTypes` (L4) (`:150-155`).
- **`optional<T>`:** L6 introduction + L7 covariance + L8 never-erases in `isAssignable` (`:123-130`).
- **`list<T>`:** L9 invariant-wrap covariance, no implicit wrap/unwrap (`:144-146`).

`zodFor(tag, registry)` is the **single source of node runtime typing** (`:171-196`); `deriveNodeSchemas` builds the node input schema as `z.tuple(...)` (**tuple-typed reducers/inputs**, `:213-222`). A bare `json` is `throw` at `zodFor` (`:178-181`).

**Edge-check checkpoints — only TWO of three exist.** `isAssignable` is called at compile in `compile-definition.ts:500` (fed-port types, all nodes incl. branch), `:524` (loop-predicate input), `:534` (loop body→state). `compileDefinition` runs at **build** (`builder/build-workflow.ts:37`) and again at **runtime** (`engine/interpreter.ts:335`, inside `ingest()` before admission), and runtime additionally re-validates every input **value** through `zodFor(...).safeParse` (`interpreter.ts:327`). The type-tag doc-comment claims edges are "Checked at build(), at save, and re-validated at runtime" (`type-tag.ts:118`), but **there is no `save` checkpoint** — no workflow-definition DB table exists (no `workflow` schema in `packages/db/src/schema`); definitions are code-authored (`chat/domain/turn-definition.ts`), never persisted, so "save" is vacuous. Two real checkpoints, not three. → **WF-2**.

#### 2.H.3 ValueStore — ≤20 MB byte-metering, 3× multiplier

`engine/value-store.ts:18` — `VALUE_STORE_BYTE_BUDGET_BYTES = 20 * 1024 * 1024`, documented as assuming a **≥3× real-memory multiplier** over counted bytes (`:13-18`). `store()` rejects **before** counting (`used + attempted > budget` → `err`, value not admitted, `:96-100`). Metering is UTF-16 for text (`×2`), real `byteLength` for bytes, declared `byteLength` for media refs (`:42-54, 74-84`). Over-budget surfaces at `ingest()` as `byte-budget-exceeded → inputs-invalid` (`interpreter.ts:331`) and again on every mid-flow `store()`. Caveat: rejection for "large video" fires at **run-start ingest / node-produce**, not at a pre-admission declared-size gate (no compile-time size check exists) — acceptable since media refs are metered by declared `byteLength`, but the reservation ceiling and the byte budget are independent knobs.

#### 2.H.4 Engine determinism — lint-enforced, not convention

`packages/config/eslint-extensions/rules/engine-node-purity.mjs` is a **vendored ESLint rule** (not convention) scoping `apps/api/src/slices/workflows/(engine|nodes)/`: bans `Date.now`, `Math.random` (bare and `globalThis/window/self`-rooted), `fetch`, and — in `nodes/` — runtime imports of `@hushbox/db` or cross-slice barrels (`:59-84`). Engine uses `ctx.clock.now()` / `ctx.rng.random()` (`interpreter.ts:244, 407`; deadline + boundary use the injected clock). Enforcement is real; the only gap is scope-by-directory (code outside `engine/`|`nodes/` is unchecked, by design).

#### 2.H.5 `settle()` — the critical path (chat turn settlement)

Entry: `createFencedSettlementHook` → `runSettlement(db, …)` = **one interactive `db.transaction`** (`idempotency/settlement.ts:12-14`; hook at `engine/settlement.ts:52-59`). Body order: `commit(tx, request)` → `complete(tx, fence)` (fenced `succeeded` flip) → throw `SettlementFenceLost` if lost → rollback. **Atomicity Verified:** saved ⟺ billed ⟺ key-row flipped, all-or-nothing.

**Lock order — Verified matches doctrine (content → wallet → period budget → conversations → key-row):**
1. **Content:** `persistTurnContent` runs first (`chat/settlement.ts:1028`), which inside it does the epoch re-read (below), then persists user + assistant messages/content_items.
2. **Wallet:** `chargeWithinTx` → `lockWalletWithinTx` = `SELECT … FOR UPDATE` (`charge.ts:77`; adapter `stores.ts:197`), then usage record, dimension row, **zero-sum ledger leg pair**, `updateWalletBalanceWithinTx`.
3. **Period budget row:** free-wallet `addSpendingWithinTx({scope:'allowance', day})` (`charge.ts:125-131`).
4. **Conversations/member rows:** durable `member` + `conversation` cumulative spend upserts (`charge.ts:132-152`); `stampRunConversationWithinTx` last (`settlement.ts:1046`).
5. **Idempotency-key row:** `succeedKeyRow` fenced flip is the **final write** in the tx (`engine/settlement.ts:56`).

**No external/Redis calls inside the settlement tx — Verified definitively** by walking the whole call graph of `createChatSettlementCommit` (`settlement.ts:1020-1052`): `withStorageFees` (pure bigint), `persistTurnContent` (tx writes + `readEpochPublicKey` tx read + `assertWrapEpochByMemberWithinTx` tx `FOR SHARE`), `resolveMemberBudgetAttribution` (tx `.get`), `createChargingCommit`→`chargeWithinTx` (tx writes only), `stampRunConversationWithinTx` (tx write). `ownerFunded` is a `ResultAsync` **resolved once OUTSIDE the fence and threaded in** (`ChatSettlementDeps.ownerFunded`, `:162-171`) — no second connection mid-tx. Redis `releaseHold` / `writeThroughSnapshot` / `refreshWalletSnapshot` are **post-commit, best-effort**, in the DO terminal sink, never inside `runSettlement`. No `fetch` reachable.

**Rounding half-even, exactly once:** `applyMarkup` = `roundHalfEvenDiv(base × (BASIS+1500), BASIS)` (`money.ts:89-94`), documented "callers must never re-round." Storage fee is additive bigint, **never** marked up (`charge.ts:76`; `money.ts:46-47`). Applied once in `chargeWithinTx` (`charge.ts:76`) and mirrored — via the **same** `applyMarkup` — into the display `content_items.cost` aggregate (`settlement.ts:436-460`, `aggregateDisplayCostByKey`). Both fed one `withStorageFees` value (`settlement.ts:1026-1027`).

**`currentEpoch` re-read FOR SHARE + assert against wrap target:** `resolveWrapKey` → `assertWrapEpochByMemberWithinTx` re-reads epoch **`SELECT … FOR SHARE`** inside the tx and asserts send-time epoch is still current **and** the sender's server-resolved public key is in the authoritative `epoch_members` wrap-set, before wrapping (`settlement.ts:278-324`; `conversations/ports/stores.ts:155` documents the FOR SHARE). Any mismatch throws → rollback.

**Double-entry zero-sum — BOTH DB trigger AND code construction:** code writes an exactly-balanced signed leg pair sharing `transactionId` (`charge.ts:105-123`: `-chargedNanoUsd` user, `+chargedNanoUsd` house), AND a hand-written **`DEFERRABLE INITIALLY DEFERRED CONSTRAINT TRIGGER`** `ledger_entries_zero_sum` runs at COMMIT and aborts the tx if any `transaction_id`'s legs ≠ 0 (`drizzle/0039_ledger-zero-sum-trigger.sql:17-52`, `search_path` pinned). DB is authoritative; code is the happy path. ✅

**Idempotency-key claim/heartbeat/fence — Verified (`key-row.ts`):** unique-insert IS the claim (`:144-164`, race-free); `succeeded` → replay stored response (`:120-121`); live `claimed` + `kind='run'` → **attach** to live stream (`:138-140`); `failed` or **lease-expired** `claimed` → one atomic CAS on `claims` re-execution (`reclaim`, `:188-218`); every terminal/heartbeat write passes `fenceCondition` (id + status='claimed' + claimedBy + claims) so a zombie flips **zero rows** (`:220-281`). Heartbeat interval: `HEARTBEAT_INTERVAL` in `config.ts` (lease math is all SQL `now()`, never process clock). Reused key + different body → `bodyMismatchError` = **409** via canonical-JSON `bodyHash` (`by-key.ts:56`, `key-row.ts:119`, `canonical-json.ts`).

#### 2.H.6 Admission Lua — single atomic script, fail-closed

`billing/domain/admission-scripts.ts:30-76` `ADMISSION_SCRIPT` is one atomic EVALSHA (repo file is the pin, EVAL fallback on NOSCRIPT). In one pass it: lazily prunes expired holds, checks **concurrent-run cap** (`heldCount >= cap` → `run-cap`, `:58`), **balance snapshot − Σ active holds ≥ estimate** (`:59`, skipped only for `type='free'`; missing type fails **toward** checking, `:59` + doc `:20-23`), each **budget scope** `remaining − scopeSum ≥ estimate` (`:60-64`), then writes the TTL hold to wallet **and every scope hash only after all checks pass** (`:66-74`) — N racers cannot jointly over-admit. Snapshot **write-through CAS on ledger seq** in a separate atomic script `SNAPSHOT_CAS_SCRIPT` (`:113-120`; regress-guard `stored.ledgerSeq >= new` → no-op). **Redis-down ⇒ fail closed:** every Redis call maps to `unavailableError` via `redisFailure` (`admission.ts:77-79`), documented "There is no degraded mode" (`admission.ts:20-23`); a `no-snapshot` bootstraps once then re-runs, and a second miss returns `unavailable` (`admission.ts:174-183`) — no unguarded admit path exists. ✅ Note: Lua doubles are exact only to 2^53 ≈ $9.007M nano-USD; documented as safe for user wallets, ledger is durable truth (`:5-11`).

#### 2.H.7 Cost circuit — K=5, level/branch/node boundaries; **a trip does NOT settle partial**

`billing/domain/constants.ts:15` `COST_CIRCUIT_MULTIPLIER = 5n`; limit precomputed at admission as `estimate × K` (`admission.ts:160`) and published on the `HoldReadout`. Engine consumes it into `limitNanoUsd` (`interpreter.ts:309`). Trip test `accruedNanoUsd > limitNanoUsd` fires in `boundary()` at **each level boundary** (`walk` calls `boundaryOutcome` before every executable level and after the walk, `:424,430`) and **mid-node** via `ctx.accrue` setting `circuitTripped` (`applyValueResult:576-580`). Documented exposure bound `hold×K + width×max-step-cost` under bounded concurrency (`:394-404`).

**What "kill" settles — a real asymmetry (Verified):** a circuit trip returns `finalizeFailed({kind:'cost-circuit-tripped'})` (`:486`, `:579`), and `finalizeFailed` **settles nothing** (`:1009-1016`) — the already-accrued provider spend in `this.charges` is **discarded, never billed**; the hold TTLs out and the key-row lease lapses. By contrast a **deadline** routes through `stop('deadline')` → `finalizeStopped`, which **does** settle the billable partial (`:1000-1007`). So deadline bills partial work; the cost circuit eats it as platform loss. This is arguably user-safe (no bill for a runaway) but is an undocumented divergence between the two kill paths and can absorb up to `~hold×5` of unbilled provider cost per tripped run. → **WF-1**.

#### 2.H.8 Operation patterns A–D + idempotency wrappers — compliance

Five wrappers are the **sole** producers of `Idempotent<T>` (`idempotent.ts:12-18`, "there is no sixth"): `byKey` (client key, canonical-hash, fenced tx flip — `by-key.ts`), `byUpsert`, `byTransition`, `byEventId`, `byExternalPreClaim` (durable pre-claim → external → finalize; the one wrapper whose external call sits **outside** the DB tx by construction — `by-external-pre-claim.ts:22-37`). `runMutation` accepts only `Idempotent<T>`; casting to the brand is **lint-banned** (`no-idempotency-brand-cast.mjs`, `no-idempotency-brand-import.mjs`).

Enforcement is **two-layer**: (a) runtime middleware `idempotencyKeyStage` demands `Idempotency-Key` on every `POST/PUT/PATCH/DELETE` unless the route declares one of six closed exemption classes (`middleware.ts:45-141`); (b) the ts-morph arch rule `idempotency-exemption-wrappers.rule.ts` requires every exempt route to **lexically show** its class's wrapper (or `runAdminOp` for `admin-engine`) in the terminal same-file handler (`:62-71, 209-235`), flags cross-file handlers, subtree-`.use` overlaps, and `.route()` mounts that would hide exemptions (`:246-297`).

**Escape hatch — Verified, worth flagging:** the arch rule only proves that **exempt** routes carry a visible wrapper. It does **not** prove that a **non-exempt** mutating route actually calls `runMutation`/`idempotent.*` — that path is guarded only by (i) the runtime header demand and (ii) the type of `runMutation`. A handler that reads the header but performs a raw non-idempotent DB write without `runMutation` would satisfy both the middleware (header present) and the arch rule (no exemption declared, so not inspected). No static rule closes this. External-call-inside-plain-tx (pattern-D violation) is likewise not statically enforced — only `byExternalPreClaim`'s shape encourages the correct ordering. → **WF-3** (spot-check across chat/billing/conversations found mutations consistently routed through `runMutation`/`runSettlement`; the *gap is enforcement completeness*, not an observed live violation).

#### 2.H.9 FEE-1 resolution — float `applyFees` vs bigint `applyMarkup`; charge vs mirror

Both encode the **same 15%** (`TOTAL_FEE_RATE=0.15` ↔ `MARKUP_BASIS_POINTS=1500`), cross-checked at module init by `assertMarkupMatchesSharedRate` which throws on drift (`money.ts:22-33`). They differ in domain: `applyFees(base) = base*(1+0.15)` is **IEEE-754 float in USD/cents** used only for pre-send **display/estimates/budget reservation** (`pricing.ts:56-58`); `applyMarkup` is **exact half-even bigint at nano-USD scale** and is the **only** primitive that touches the ledger. Max divergence between the two is inherent float error: bounded by half-even's ≤0.5 nano-USD quantization plus ~1e-16 relative float error — i.e. **sub-nano-USD per generation** for realistic (<$1) charges; it is a display-vs-estimate cosmetic gap, never a ledger gap, because the charge path never calls `applyFees`.

**Charge vs `content_items` mirror are GUARANTEED-EQUAL (Verified):** `settlement.ts` computes the display `content_items.cost` via `aggregateDisplayCostByKey` using `applyMarkup(base)+storageFee` (`:436-460`), and `chargeWithinTx` debits `applyMarkup(base)+storageFee` (`charge.ts:76`) — **same primitive, same additive storage fee, same single `withStorageFees` input** (`settlement.ts:1026-1027`). Construction guarantees `Σ content_items.cost == Σ usage_records.cost` per run; they cannot drift. **FEE-1 and FEE-2 are hereby resolved: no rounding-parity assertion needed on the charge path.**

#### 2.H.10 Section findings

| # | sev | finding |
|---|---|---|
| WF-1 | 🟠 | Cost-circuit trip routes through `finalizeFailed`, which settles **nothing** — already-incurred provider spend (up to ~`hold×5`) is discarded/unbilled, whereas a **deadline** stop settles its billable partial (interpreter.ts:486, 579, 1000-1016). Undocumented asymmetry between the two kill paths; either intended (user-safe, platform absorbs runaway) or a billing-leak. Founder Q. Verified. |
| WF-2 | 🟡 | Typed-edge checks exist at **build** and **runtime** only; the `type-tag.ts:118` doc claim of a **"save"** checkpoint is vacuous — no workflow-definition table exists (definitions are code-authored). Fix the doc (or implement when definitions persist). Verified. |
| WF-3 | 🟡 | Idempotency arch rule enforces wrappers only on **declared-exempt** routes; nothing statically proves a non-exempt mutating handler actually calls `runMutation`/`idempotent.*`, nor bans an external call inside a plain DB tx (pattern-D). Enforcement completeness gap (no live violation observed; idempotency-exemption-wrappers.rule.ts:299-328, middleware.ts:126-141). Verified. |
| WF-4 | ⚪ | `subWorkflow` is in the closed type gate but **unimplemented** — `resolveValuePorts` always returns `undefined` (fails closed to `node_config_unresolved`). Deferred by design; track. Verified. |
| WF-5 | ⚪ | `smartModel` is a **7th** node type beyond ARCHITECTURE.md's documented closed set; fully implemented + versioned, fail-closed port resolution. Update the canonical node-set list in docs. Verified. |
| WF-6 | ⚪ | Admission Lua relies on Lua-5.1 double exactness (≤2^53 ≈ $9.007M nano-USD); safe for user wallets today, but a hard invariant not asserted anywhere in code. Operational bound to note. Verified. |
| WF-7 | ⚪ | **FEE-1/FEE-2 resolved:** `applyMarkup` (bigint half-even) is the sole ledger primitive; `content_items.cost` mirror equals `usage_records.cost` **by construction** (same primitive + storage fee + single input). Float `applyFees` divergence confined to display/estimate, sub-nano-USD, never touches settlement. Verified. |

**Verified-clean (no finding):** single-transaction settlement atomicity; exact lock order content→wallet→period→conversations→key-row; zero Redis/external calls inside the settlement tx (full call-graph walk); half-even applied exactly once; `currentEpoch` FOR SHARE re-read + member-keyed wrap-set assert; zero-sum enforced by both code construction and a deferred COMMIT-time constraint trigger; key-row claim/heartbeat/fence + attach/replay/409-canonical-hash semantics; admission single-atomic-script balance−Σholds + budgets + run-cap + CAS snapshot + fail-closed; K=5 at level/mid-node boundaries; determinism lint-enforced; the five-wrapper closed set with brand-cast lint ban + runtime header stage.

### 2.G apps/web frontend

**Scope:** React 19 SPA (`apps/web/src`, 693 files). Typed API surface `src/lib/api-client.ts` (`hc<AppType>()` + `fetchJson`), TanStack Query + Router, Zustand, a bespoke WS client. All claims **Verified** against files read (file:line inline).

#### 2.G.1 Single typed client & raw-`fetch` bypass sweep

`api-client.ts` exports `client = hc<AppType>(getApiUrl(), { init:{credentials:'include'}, fetch: customFetch })`; `customFetch` injects `X-HushBox-Platform`, `X-App-Version`, and (for link-guests) `X-Link-Public-Key`, and handles 426 VERSION_MISMATCH centrally (`api-client.ts:18-38,80-84`). Every raw request-issuing call site in non-test `apps/web`:

| # | Site | Verdict |
|---|---|---|
| a | `lib/api-client.ts:26,28` — the `customFetch` definition itself | ✅ the sanctioned wrapper |
| b | `hooks/crypto/use-decrypt-blob.ts:154` `await fetch(downloadUrl)` | ✅ justified — presigned R2 GET; must be credential-less cross-origin |
| c | `lib/auth.ts:184,233,252,311,341,391,428,465,488,516,554,582` (12 sites) — OPAQUE login/register/change-password/recovery/2fa-disable | ⚠️ **bypass** — typed-client-covered identity routes |
| d | `components/auth/two-factor-setup.tsx:114,135` — `/auth/2fa/setup`, `/auth/2fa/verify` | ⚠️ **bypass** |
| e | `lib/ws-client.ts:233` `new WebSocket(...)` | ✅ the one sanctioned WS client |

No axios / XMLHttpRequest / EventSource anywhere (Verified — grep clean). The **14 raw `fetch()` in (c)+(d)** hit endpoints the typed client covers *and* set only `Content-Type` — they **skip `customFetch`'s `X-App-Version` / `X-HushBox-Platform` injection**, so OPAQUE auth + 2FA-setup traffic carries no version header and cannot receive the 426 upgrade-gate (`auth.ts:184-190`, `two-factor-setup.tsx:114-140`). The byte-array OPAQUE exchange is a reason not to use the typed JSON `.json()` unwrap, but not a reason to drop the header shim — they could still route through a shared header-injecting fetch. → **FE-2**.

#### 2.G.2 The bare-`Response` → vacuous `AppType` gap (quantified)

Every slice's route handler funnels its terminal return through a uniform tail whose **declared return type is bare `Response`**, not `TypedResponse<Body,200>`: `respond200<S>(c, result): Response` and `respondOutcome<S>(…): Response` (`conversations/routes.ts:182-205`), and the twin `respondDomainError(c, error): Response` present **once per slice** (`conversations:171`, `account:42`, `media:55`, `identity:153`, `billing:115`, `models:21`, `announcements:43`, `chat:244`, `admin:72`, `feedback:45`, `newsletter:61`).

Because Hono infers a route's output schema from the handler's return type, a handler returning `Response` contributes **nothing** to `AppType` — `hc<AppType>` yields a `ClientResponse` whose `.json()` is untyped. **Counts (Verified):**

| Metric | Value |
|---|---|
| HTTP route handlers across all slices | **119** (conversations 36, identity 23, admin 16, billing 13, chat 8, account/newsletter 6 each, announcements 3, media/notifications 2 each, models/feedback 1 each) |
| Handlers whose terminal return is a bare-`Response` helper | **81** direct hits; the remainder return `c.json(...)` **inside** helpers also typed `: Response` |
| Route handlers contributing a **usable typed 200 body** to `hc<AppType>` | **effectively 0** — no handler's inferred return is `TypedResponse<_,200>` |
| Client compensation: `fetchJson<T>(…)` call sites supplying `T` **by hand** | **69** (non-test) |

The RPC response-body inference is **vacuous app-wide**. The web app compensates by re-asserting shapes manually, mostly from `@hushbox/shared` contract types — a *manual* SSOT — but a few `T`s are locally redeclared with **no link to the server type**: `MeResponse` (`lib/auth-client.ts:119-132`), `KeyChainResponse` (`lib/epoch-key-cache`). **Request-side typing survives** (path/param/query/`json` input still typed from `zValidator`); only the **response body** is severed. Worst-affected high-traffic reads with zero compile-time response typing: `billing.balance` (`billing.ts:25`), `billing.transactions` (`:69`), `billing.usage.*` (`usage.ts:45-74`), `models` (`models.ts:26`), `auth.me` (`auth-queries.ts:19`), the per-conversation keychain (`crypto/keys.ts:19`). The `Extract`+status-200 fix pattern is **not applied anywhere**. → **FE-1**.

#### 2.G.3 TanStack Query discipline

- **All server reads via `useQuery` wrapping the typed client** (Verified; the two non-`useQuery` reads — `restoreSession` `auth-client.ts:145` and the trial socket — use `queryClient.fetchQuery`/WS). Global config sane: 5-min `staleTime`, 30-min `gcTime`, shared retry policy, `refetchOnWindowFocus:false` (`providers/query-provider.tsx:8-26`).
- **Query-key hygiene:** **13 `*Keys` factory objects** per the documented per-hook-file pattern; **6 ad-hoc inline keys** remain (`auth-queries.ts:18`, `use-user-search.ts:12`, `chat.ts:259`, `use-banner.ts:18`, `use-shared-message.ts:139`, `dev.emails.tsx:30`). → **FE-6**.
- **Invalidation after mutations:** effectively complete — members (9 mutations, all invalidate), links (3, all via shared `invalidateLinkAndBudget`, `use-conversation-links.ts:76,94,112`), billing invalidates balance+transactions. The two non-invalidating mutations are justified (`use-message-share.ts:41` no cached list; feedback fire-and-forget).
- **Optimistic updates:** exactly one — `useUpdateNewsletterSettings` — and it is safe (cancel + snapshot in `onMutate`, rollback in `onError`, fresh write in `onSuccess`; `use-newsletter-settings.ts:43-59`).

#### 2.G.4 Zustand stores

19 stores + `auth`. All hold client/UI/ephemeral state — no server-state leakage — with one boundary case: `trial-chat.ts:22` holds `messages: TrialMessage[]`. Defensible: the anonymous trial has no server-persisted history, so the client is legitimately the session's source of truth. → **FE-8** (info).

#### 2.G.5 TanStack Router

Route tree generated (`routeTree.gen.ts`, `@ts-nocheck` — generated, exempt). Params/search typed via `Route.useParams()`/`Route.useSearch()`. **`validateSearch` present on 3 routes** (`chat.$id.tsx:28`, `billing-portal.tsx:15`, `dev.personas.tsx:18`) but **hand-rolled `typeof` guards, not zod** — invalid values silently coerce to `undefined` rather than schema-rejecting; no zod SSOT for search shapes. → **FE-7**.

#### 2.G.6 Client 401 / session-revocation — not centralized

401/403 handling exists in exactly two places: bootstrap `restoreSession` (clears stored auth only on definitive 401/403, `auth-client.ts:143-154`) and ad-hoc per hook (`use-group-chat.ts:33,76`). **No global interceptor** — the `QueryClient` has no `QueryCache({ onError })`; `customFetch`/`fetchJson` only throw `ApiError` (`api-client.ts:84`). A session revoked mid-session surfaces as an `ApiError(401)` in whichever query fires next; nothing globally clears auth or redirects to login — recovery relies on the next full reload. → **FE-3**.

#### 2.G.7 WS client consumption (`lib/ws-client.ts`)

Verified against `@hushbox/realtime` protocol types:

| Concern | Status |
|---|---|
| Reconnect / backoff | ✅ exponential 1s→30s cap, resets on open (`:377-385,241`); network-aware pause/resume (`:461-469`) — **but no jitter** (deterministic ×2), unlike the jittered HTTP retry (`retry.ts:87`) → **FE-5** |
| Resume / Last-Event-ID | ✅ per-stream cursor map → `resume` frame first on open, bounded `MAX_RESUME_STREAMS=32` (`:112,354-361`); replay-overlap dedupe (`:323-328`) |
| `stream-gone` | ✅ drops stream from cursor map (`:332-335`); `run-finished` clears cursors (`:337-338`); fetch-after-settlement fallback in consumer (`use-chat-stream.ts:224`) |
| Half-open detection | ✅ heartbeat ping + pong-timeout force-close → reconnect (`:407-425`) |
| One-run-per-conversation | ✅ run ownership tracked (`lib/run-ownership.ts`); composer disabled while streaming (`message-input.tsx:45`) |

#### 2.G.8 Error-code handling — migration incomplete

Modern `friendlyErrorMessage` used in only **2 files** (`lib/auth.ts:52-53,211,279,291`; `lib/leave-conversation.ts:76,80`). `legacyFriendlyErrorMessage` still live in **6 files / ~8 sites** + 1 `ERROR_CODE_*` consumer: `delete-account-modal.tsx:57,72,413` · `payment-form.tsx:77` · `media-preview.tsx:36` (+`ERROR_CODE_STORAGE_READ_FAILED`) · `trial-chat-page.tsx:100` · `message-item.tsx:529` · `error-boundary.tsx:62`. **Refines ENV-8**: the ~49 figure was repo-wide; within `apps/web` the residual is 6 files. → **FE-4**.

#### 2.G.9 Hygiene sweep (non-test)

| Signal | Count | Notes |
|---|---|---|
| `@ts-ignore` / `@ts-expect-error` | **0** | only `@ts-nocheck` in generated `routeTree.gen.ts` |
| Explicit `any` in product code | **0** | `as any` confined to generated route tree; 2 test-only disables |
| `console.log` | **0** | 17 `console.error`/`warn`, all genuine failure logging |
| TODO/FIXME/HACK | **0** | sole grep hit is base64 fixture data |
| `eslint-disable` (non-test) | **66** | all rule-scoped + justified; only 2 `jsx-a11y` disables, both sound |

#### 2.G.10 Semantic-HTML / a11y

Raw `<img>`: only dev asset preview + native-asset PNG generators, all with commented exemptions — no product UI hit ✅. Raw `requestAnimationFrame`: all hits carry "paint-timing, not animation" disables (`ws-client.ts:26-30`, `use-keyboard-offset.ts:40`, `prompt-input.tsx:678`); product motion uses `useAnimationFrame` ✅. No unguarded div-with-onClick ✅. The lint wall is doing its job.

#### 2.G.11 Section findings

| # | sev | finding |
|---|---|---|
| FE-1 | 🟠 | `hc<AppType>` response-body inference **vacuous app-wide**: all 119 handlers return bare `Response` via `respond200`/`respondDomainError` tails, so the client re-asserts every body by hand through 69 `fetchJson<T>` sites; `MeResponse`/`KeyChainResponse` locally redeclared with no server link (drift risk). Fix = `TypedResponse` tails or client `Extract`+200 narrowing. Verified. |
| FE-2 | 🟠 | 14 raw `fetch()` in OPAQUE auth + 2FA-setup bypass the typed client **and its header shim** — no `X-App-Version`/`X-HushBox-Platform`, so these routes can't receive the 426 version-gate. (`auth.ts` ×12; `two-factor-setup.tsx` ×2). Verified. |
| FE-3 | 🟠 | No centralized mid-session 401/revocation handler — 401 handled only at bootstrap + ad-hoc hooks; mid-session revoke yields an unhandled `ApiError(401)` with no global logout/redirect. Verified. |
| FE-4 | 🟠 | `friendlyErrorMessage` migration incomplete in web: modern helper in 2 files; `legacyFriendlyErrorMessage` in 6 files + 1 `ERROR_CODE_*`. Refines ENV-8. Verified. |
| FE-5 | 🟡 | WS reconnect backoff has no jitter (deterministic ×2) unlike jittered HTTP retry — synchronized-reconnect risk after a shared blip (`ws-client.ts:377-385` vs `retry.ts:87`). Verified. |
| FE-6 | 🟡 | 6 ad-hoc inline query keys outside the per-hook factory pattern. Verified. |
| FE-7 | 🟡 | `validateSearch` is hand-rolled `typeof` guards, not zod — invalid search silently coerces; no schema SSOT. Verified. |
| FE-8 | ⚪ | `trial-chat` store holds `messages[]` (server-adjacent) but trial has no persisted history — legitimate client SSOT. No other store leaks server state; the single optimistic mutation rolls back correctly. Verified. |

**Folds into §10 (SSOT):** response-type SSOT is manual not enforced (FE-1; locally redeclared `MeResponse`/`KeyChainResponse` are genuine dual-definition drift risks) · error-copy SSOT split inside one app (FE-4) · retry/backoff single-sourced for HTTP but WS re-implements an un-jittered schedule (FE-5).

**Folds into §22 (quality):** 0 `@ts-ignore`, 0 product `any`, 0 `console.log`, 0 TODO — exemplary hygiene that nonetheless masks the structural FE-1 gap (numbers look perfect because bodies are typed by hand). 66 justified rule-scoped disables. Query discipline strong (13 factories, complete invalidation, one safe optimistic write).

**Q7 partial resolution (Verified):** no `GET /payments/:id` poll call site exists in `apps/web`; web already consumes the webhook-authoritative `GetBalanceResponse` shape (`billing.ts:25`). Mobile/Capacitor client confirmation rides §2.J.


### 2.K Group-chat member budgets & premium-model gating

**Scope.** How a group-chat turn is funded (whose wallet is charged), how a member's spendable headroom is computed, and when a member may select a premium model — new system vs legacy. All claims Verified at the cited file:line.

#### 2.K.1 Who pays — the single funding decision

The funding decision is made **once** at route time in `resolvePayerWallet` (`chat/domain/turn-context.ts:311-360`) and frozen into the run's `walletId`; admission-hold and settlement both draw that one wallet in lockstep (`turn-context.ts:371-422`).

- **Solo turn** (sender is the owner): short-circuits to `senderPayerWallet(owner)` — the owner pays their own wallet (`:317-319`).
- **Any non-solo sender** (member ≠ owner, or link guest): computes **group headroom** = `groupEffectiveRemainingNanoUsd(memberRemaining, conversationRemaining, ownerBalance)` (`:330-334`). Headroom `> 0` → **owner-funded**: the owner's *purchased* wallet is charged and the spendable ceiling is the group MIN itself (`:335-348`). Headroom `≤ 0` → a **link guest is denied** (holds no wallet, `:353-356`); a **signed-in member falls through to self-funding** on their own wallet (`:358`).

`isOwnerFundedTurn` is a pure function of wallet ownership — true iff the frozen payer wallet is not one of the sender's own (`:274-283`). Spend attribution: user turns attribute to the sender (byte-identical to legacy, including owner-funded ones); guest turns attribute `payerUserId` to the owner (`:417`). Self-funding picks purchased-while-positive, else the free daily allowance (`:232-259`).

#### 2.K.2 The effective-budget formula

`groupEffectiveRemainingNanoUsd` (`billing/domain/group-budget.ts:22-34`):

```
min( clamp(memberRemaining), clamp(conversationRemaining), clamp(ownerBalance) )   where clamp(x) = x > 0 ? x : 0
```

Each dimension floors at 0 *before* the min — an overspent or absent dimension reads as zero headroom and cannot be masked by a larger sibling. Inputs (`turn-context.ts:325-329`): `memberRemaining = memberRow === null ? 0n : budgetNanoUsd − spentNanoUsd` (**absent row = 0 cap, not unlimited**; spend is cumulative, no period — legacy parity `legacy/services/billing/budgets.ts:174-186`); `conversationRemaining = conversationBudgetNanoUsd − conversationSpent`; `ownerBalance` = owner purchased wallet balance.

**Caps:** per-member cap is set by **admin+** (`conversations/domain/budgets.ts:94-111`); per-conversation cap by **owner only** (`:139-158`) — legacy privilege parity (`legacy/routes/budgets.ts:23,84,104`). **Enforced at admission AND display through the same helper**: `getConversationBudgets` renders `effectiveRemainingNanoUsd` via the same `groupEffectiveRemainingNanoUsd` (`budgets.ts:207-213`), so the shown remaining equals the gate.

#### 2.K.3 The pool

Owner funding always draws the **owner's purchased wallet** — never the owner's free allowance (`ownerBalance` is purchased-only; the effective>0 branch requires it, `turn-context.ts:335-348`). When headroom is exhausted: signed-in members fall back to their own wallet (purchased-then-free); link guests are refused.

#### 2.K.4 Premium vs non-premium

**Definition (new server + `/models`):** a text model is premium exactly when the trial gate refuses it as `premium` — top price quartile OR recency window OR minimal-exchange unaffordability OR un-priceable (fail-closed). One predicate shared by the chat tier-gate (`models/domain/tier-gate.ts:16-38`) and the `premiumModelIds` the web client consumes (`models/domain/list-models.ts:205-219,268`) — client display and server enforcement classify identically. (The *shared/legacy* `isPremiumModel` — 75th-percentile price OR ≤182-day recency, `premium-check.ts:14,33-38` — is used by legacy + shared `resolveBilling`, **not** by the new server.)

**Gating** — `tierGateRejection` (`chat/routes.ts:483-505`, wired `:817`): fires only on the **direct-billing** path (payer wallet is the caller's own, `:498`); owner-funded group turns are **exempt** (`:499`); `canAccessPremium = own purchased balance > 0` (`:494`); a direct-billing caller without it selecting a premium model gets **`MODEL_TIER_LOCKED` 403** (`:504`). Media/Smart-Model sends are exempt (`:465-469`). Net: **owner-funded member → any premium model, owner pays; self-funding member → premium only with own positive purchased balance.**

#### 2.K.5 Funding-scenario map

| Scenario | Wallet charged | Budget rows checked | Premium allowed? | Enforced (file:line) |
|---|---|---|---|---|
| Owner solo | own purchased (>0) else own free allowance | none (solo short-circuit) | iff own purchased > 0, else `MODEL_TIER_LOCKED` | turn-context.ts:317-319; routes.ts:483-504 |
| Member, headroom > 0 | **owner's purchased** | min(member cap−spent, conv cap−spent, owner balance) | **yes — owner pays** (gate exempt) | turn-context.ts:330-348; routes.ts:498-499 |
| Member, headroom ≤ 0 | member's own purchased (>0) else own free | same MIN → ≤0 → fall-through | only with own purchased > 0, else 403 | turn-context.ts:349-358; routes.ts:494-504 |
| Member, no budget row | member's own wallet (row = 0 cap) | memberRemaining = 0 | as self-funded above | turn-context.ts:327-328,349-358 |
| Link guest, headroom > 0 | **owner's purchased**; attributed to owner | same MIN | yes — owner pays (exempt) | turn-context.ts:330-348,417; routes.ts:498-499 |
| Link guest, headroom ≤ 0 | **refused** (no wallet) | same MIN | n/a (run denied) | turn-context.ts:353-356 |
| Trial (solo) | `trial_fixed` ≤ trial message cap | n/a | never (unaffordable/premium pre-filtered) | resolve-billing.ts:146-150; list-models.ts:205-219 |
| Free-allowance user (purchased = 0) | own free wallet allowance | n/a | **no** — premium requires positive purchased | turn-context.ts:243-257; routes.ts:494; tiers.ts:78-83 |

#### 2.K.6 Legacy comparison & client parity

Legacy `computeGroupRemaining` took the same three-dimension min (with Redis reservations subtracted, `legacy/services/billing/budgets.ts:198-217`); absent row → zero cap via LEFT-JOIN miss (`:96-97`) — same semantics. Legacy who-pays lived in shared `resolveBilling` (`resolve-billing.ts:98-151`), which pays the owner iff `effectiveCents > 0` AND `canUseModel(owner)` (`:68-83`); the legacy tier gate fired only on owner-solo (`legacy/routes/chat.ts:763-770`). Budget display: legacy exposed every member's cap+spend to any reader (`legacy/routes/budgets.ts:23`); new narrows non-owner viewers to their own row (`budgets.ts:251-255,298-301`) — founder-approved privacy improvement (documented `budgets.ts:244-250`).

Client: `use-prompt-budget` consumes the endpoint's `effectiveCents` + `/models` `premiumIds` (`use-prompt-budget.ts:341,364,378`) and feeds shared `resolveBilling` — premium classification and headroom numbers match the server, but the funding-source/premium decision logic is a **separate client implementation** (shared `resolveBilling`) vs the server's native turn-context + tier-gate. → GB-1.

#### 2.K.7 Section findings

| # | sev | finding |
|---|---|---|
| GB-1 | 🟠 | **Two divergent implementations of the "single source of truth":** `resolve-billing.ts:1-27` claims "both frontend and backend call" it, but the new server never does (zero hits in slices) — who-pays and premium gating are re-implemented natively (turn-context.ts:311-360; tier-gate.ts; routes.ts:483-505) while web + legacy use shared `resolveBilling`. Equivalent today; nothing keeps them in sync. Founder Q17. Verified. |
| GB-2 | 🟡 | **Direct-billing scope widened vs legacy:** legacy gated premium only on owner-solo (`isDirectBilling`, legacy/chat.ts:765); new gates any self-funding caller (routes.ts:498), so a fallen-through member now gets `MODEL_TIER_LOCKED` where legacy surfaced `PREMIUM_REQUIRES_BALANCE`. Same intent, different error code — verify client copy for both. Verified. |
| GB-3 | 🟡 | **No owner-tier re-check on the owner-funded path:** new exempts owner-funded turns entirely (routes.ts:499), relying on "owner-funded ⇒ owner purchased > 0"; legacy checked `canUseModel(owner)` explicitly (resolve-billing.ts:79). Founder Q18. Verified. |
| GB-4 | ⚪ | Absent member-budget row = "pay yourself" (not unlimited, not blocked) — matches legacy. Founder Q19 confirms the default. Verified. |
| GB-5 | ⚪ | Budget-display peer exposure narrowed to own-row for non-owners — founder-approved improvement; logged for the divergence ledger. Verified. |

## 10+21 (part 2). Repo-wide SSOT, duplication & dead code

*Scope: `packages/*` + `apps/*` NEW code; `apps/api/src/legacy/**` and `packages/db/src/legacy_*` inspected only for deletion-readiness. Every row read this session.*

### 10+21.A Logic-duplication hunt (canonical home vs re-implementation sites)

| Concern | Canonical home | Duplicate / re-impl sites | Verdict |
|---|---|---|---|
| **NanoUSD format/parse (str↔bigint)** | `packages/shared/src/nano-usd.ts` — `NanoUSD` zod (:15), `serialize/parseNanoUSD` (:30/:35), `NANO_USD_PER_DOLLAR=1_000_000_000n` (:43), `nanoUsdToFullDollarString` (:53) | `billing/adapters/payment-helcim.ts:20` `NANO_PER_USD` literal; `platform/dev/personas.ts:10` same literal; `platform/dev/reads.ts:69` `nanoUsdToDecimalString` re-derives the 9-digit split; `billing/domain/public-usage-stats.ts:183-186` `nanoUsdToUsdString` re-splits on `1_000_000_000n` | 🟡 DUP-3 — formatting + literal re-implemented ≥4× |
| **Budget / remaining computation** | server `billing/domain/budget-resolution.ts` + shared `resolveBilling` | web `use-resolve-billing.ts` / `use-prompt-budget.ts` import the shared function | ⚪ OK — reused, not re-implemented |
| **zod schemas shared↔slices** | `packages/shared/src/schemas/api/*` | `memberPrivilegeSchema` (legacy `enums.ts:63`) AND `MemberPrivilege` (`member-privilege.ts:12`) — two zod enums for the identical `['read','write','admin','owner']`, **both live-imported by new code** | 🟠 DUP-1 |
| **UTC-day period keying** | `packages/shared/src/utils/date.ts:53` `utcDayKey` | inline `toISOString().slice(0,10)` in `jobs/admin-digest-entry.ts:30` and `public-usage-stats.ts:191` (`isoDateOfUtcMs`) | 🟡 DUP-5 |
| **Privilege ladder / canX** | `packages/shared/src/utils/privileges.ts:4` (`PRIVILEGE_LEVEL` + `canAddMembers`/`canRemoveMember`/`canManageLinks`/`canChangePrivilege`) — all server sites use it (`members.ts:139,142,370`, `budgets.ts:105`, `shares.ts:130`) | web `components/chat/member/member-privilege.ts:1` `PRIVILEGE_ORDER` — a 4th, reversed ordering of the same enum for display grouping | 🟡 DUP-2 |
| **Epoch math / visibleFromEpoch** | conversations slice (single writer) | none outside slice | ⚪ OK |
| **Cursor encode/decode** | single impl in conversations slice | none | ⚪ OK |
| **MIME allowlists** | — (no single home) | `workflows/engine/model-ports.ts:45` `MEDIA_MIME_ALLOWLIST` and `chat/domain/turn-definition.ts:358` `MEDIA_TURN_MIME_TYPES` are **byte-identical** image/video maps — `turn-definition.ts:356` comment admits "the same default allowlist the engine derives"; plus distinct-purpose `message-shares.ts:26` and `strip-image-metadata.ts:19` | 🟠 DUP-4 — extract one shared const |
| **Modality dispatch** | `packages/shared/src/modality.ts:8` `MODALITIES` | none | ⚪ OK |
| **uuid validation** | Drizzle/zod `.uuid()` at boundaries | no hand-rolled regex in new code | ⚪ OK |
| **retry / backoff math** | `shared/retry.ts:64` `backoffCeilingMs` (HTTP) vs `lib/jobs/backoff.ts:13` `failures⁴s ±10%` (jobs) | helcim adapter own delays (`payment-helcim.ts:30`) | ⚪ OK — intentionally different curves per domain |
| **provider display-name map** | `shared/models/provider-map.ts` `PROVIDER_MAP` | none | ⚪ OK |
| **canonical-JSON hashing** | idempotency/jobs + cassette paths, distinct purposes | no shared-logic clash | ⚪ OK |

### 10+21.B Constants declared twice

| Constant / meaning | Sites | Verdict |
|---|---|---|
| `MEMBER_PRIVILEGES = ['read','write','admin','owner']` | `member-privilege.ts:9` AND `enums.ts:60` (+ two parallel zod schemas :12/:63), both barrel-exported, both live-imported | 🟠 DUP-1 |
| `1_000_000_000n` nano-per-USD | `nano-usd.ts:43` canonical vs 4 inline literals (above) | 🟡 DUP-3 |
| `10_000_000n` | `nano-usd.ts:40` `NANO_USD_PER_CENT` vs `trial-eligibility.ts:39` `TRIAL_MESSAGE_COST_CAP_NANO_USD` — coincidental value, distinct meaning | ⚪ not a dup |
| TTL/size caps (`MEMBERSHIP_CACHE_TTL_SECONDS`, `MEDIA_DOWNLOAD_URL_TTL_SECONDS`, `MAX_CONVERSATION_MEMBERS`, `MAX_MEDIA_OBJECT_BYTES`, etc.) | each declared once, imported everywhere | ✅ clean |

### 10+21.C Structural duplication (jscpd-by-reading)

Per-slice route scaffolding (`defineSliceManifest` → `routeClass()` → `zValidator()` → handler) is healthy framework repetition — do **not** extract. Repeated `z.enum(MEMBER_PRIVILEGES)` off a shared const is acceptable. Genuine copy-paste worth extracting: the nano→dollar divmod render (DUP-3) and the media MIME maps (DUP-4).

### 10+21.D Phase-6 legacy-deletion inventory

**Lint rule verified:** `no-legacy-imports` (packages/config/eslint-extensions, aggregated via `loadEslintExtensions`, `eslint.config.js:25,249`; asserted by `boundaries.test.mjs:172`) bans importing `legacy_*`/`legacy-*`/`legacy/` **paths** and holds. **Gap:** it does not catch barrel exports merely *named* `legacy*` — those are ordinary `@hushbox/shared` exports.

| Item | Location | Status | Phase-6 deletable? |
|---|---|---|---|
| `apps/api/src/legacy/**` corpus | whole tree | dormant, lint-isolated (only 3 comments reference it) | ✅ yes |
| `packages/db/src/legacy_*` + `legacy-zod/` | db | dormant reference corpus | ✅ yes |
| `PUBLIC_MODELS_URL` env entry | `env.config.ts:313` (Vercel gateway URL) | read only by dead `fetch.ts::fetchModels` | ✅ dead — delete |
| `fetchModels`/`toRawModel`/`clearModelCache` | `shared/models/fetch.ts:201/160/20` | no new prod importer (admin has its own local `fetchModels`) | 🟠 mostly dead — delete the 3 fns + env entry; `publicModelEntrySchema` in same file is used by test-infra `live-catalog-fetch.ts` — keep/relocate |
| `IMAGEN_SAMPLE_SIZE_BY_MODEL` + `getImagenSampleSize` | `capabilities.ts:77,121` | zero importers | ✅ dead — delete |
| `VEO_CAPABILITY`/`getVideoCapability`/`getSupportedVideo*` | `capabilities.ts:42,101-115` | **LIVE** — `getSupportedVideo*` consumed by `apps/web/src/stores/model.ts` + mock-provider | ❌ NOT deletable — **corrects §15 OR-1** (only the Imagen pair is dead) |
| `PAYMENT_STATUSES`/`LEDGER_ENTRY_TYPES`/`DEDUCTION_SOURCES` (+schemas) | `enums.ts:21,36,51` | zero new importers (vocab lives in db pgEnums) | ✅ dead — delete members |
| `memberPrivilegeSchema`/`paymentStatusSchema`/`MEMBER_PRIVILEGES`/`MESSAGE_ROLES` in `enums.ts` | `enums.ts:60,63,30` | **LIVE** (shares.ts, schemas/api/conversations.ts, schemas/api/billing.ts, shared/constants.ts) | ❌ NOT deletable yet — migrate consumers first; `enums.ts` self-describes as "deleted after Phase-4" but is load-bearing |
| `legacyFriendlyErrorMessage`/`LegacyErrorCode` | `error-messages.ts:191,179` | **LIVE in new code** (web trial-chat-page.tsx:3, error-boundary.tsx:3, ui use-async-action.ts:3) | ❌ NOT deletable — rename (naming smell, not dead) |
| `LegacyModality` type | `models/index.ts:1` → `web/stores/model.ts:13` | **LIVE** | ❌ rename only |

### 10+21.E Dead code in NEW code

`IMAGEN_SAMPLE_SIZE_BY_MODEL`/`getImagenSampleSize` (0 importers) · `fetchModels`/`toRawModel`/`clearModelCache` (test/legacy only) · `PUBLIC_MODELS_URL` env entry · `enums.ts` payment/ledger/deduction exports (0 new importers) · `models/live-catalog-fetch.ts` is self-declared test infra (not prod-dead).

### 10+21.F Section findings

| # | sev | finding |
|---|---|---|
| DUP-1 | 🟠 | `MEMBER_PRIVILEGES` + its zod enum defined twice (`member-privilege.ts:9/12` vs legacy-slated `enums.ts:60/63`); both live-imported by new code — new code straddles a canonical and a to-be-deleted source for the same vocabulary. Verified. |
| DUP-4 | 🟠 | Media default MIME allowlist copy-pasted byte-identically in `model-ports.ts:45` and `turn-definition.ts:358`; in-code comment admits they must match. Extract one shared const. Verified. |
| DUP-3 | 🟡 | Nano→dollar-string render + `1_000_000_000n` literal re-implemented ×4 (`payment-helcim.ts:20`, `dev/personas.ts:10`, `dev/reads.ts:69`, `public-usage-stats.ts:183`) instead of `nano-usd.ts` exports. Verified. |
| DUP-5 | 🟡 | `utcDayKey` bypassed by inline `toISOString().slice(0,10)` in `admin-digest-entry.ts:30` and `public-usage-stats.ts:191`. Verified. |
| DUP-2 | 🟡 | Web keeps a parallel privilege ordering `PRIVILEGE_ORDER` (`web/.../member-privilege.ts:1`) instead of deriving from shared `MEMBER_PRIVILEGES`; server ladder is clean SSOT. Verified. |
| DEAD-1 | 🟠 | `PUBLIC_MODELS_URL` (Vercel-gateway URL) + `fetchModels`/`toRawModel`/`clearModelCache` dead in prod (legacy/test only) — cross-confirms OR-2/§7. Verified. |
| DEAD-2 | 🟡 | `IMAGEN_SAMPLE_SIZE_BY_MODEL`+`getImagenSampleSize` and `enums.ts` PAYMENT_STATUSES/LEDGER_ENTRY_TYPES/DEDUCTION_SOURCES have zero importers. Verified. |
| LEG-1 | 🟡 | `legacyFriendlyErrorMessage`/`LegacyErrorCode`/`LegacyModality` are `legacy`-named barrel exports **live-imported by new web/ui code** — invisible to the path-based no-legacy-imports rule. Rename; NOT Phase-6-deletable. Verified. |
| LEG-2 | ⚪ | **Correction to §15 OR-1:** `capabilities.ts` VEO helpers (`getSupportedVideo*`) are live in `web/stores/model.ts`; only the Imagen pair is dead. Verified. |
| OK-1 | ⚪ | Verified clean single-source: `MODALITIES`, `PROVIDER_MAP`, cursor codec, all TTL/size caps, and the intentional two-domain backoff split. |

**Net:** SSOT discipline is strong overall; real violations concentrate in (1) the still-live `enums.ts`/`member-privilege.ts` split, (2) duplicated media MIME maps, (3) scattered nano/UTC-day formatting re-impls. Phase-6 blockers: `enums.ts` live schemas + three `legacy*`-named shared exports must be migrated/renamed first; the `legacy_` path corpus itself is fully dormant and safe to drop.

### 2.I packages/ui & accessibility

Scope: `packages/ui` shared library + the cross-app accessibility system. All claims Verified from files read at the cited lines.

#### 2.I.1 Library surface (inventory)

`packages/ui/src` is a flat shadcn/Radix component library plus a self-contained accessibility subsystem. `index.ts` (138 lines) is the single public barrel.

| Layer | Members (`packages/ui/src/components/`) |
|---|---|
| Radix-wrapped primitives | dialog, sheet, dropdown-menu, select, tabs, tooltip, avatar, scroll-area, checkbox, switch, slider, radio-group, toggle-group, label, separator, sonner |
| Styled leaf primitives | button, icon-button, input, textarea, card, badge, alert |
| a11y wrappers | img, logo; hooks use-animation-frame, use-reduced-motion |
| Composites | overlay family (overlay-dialog/bottom-sheet/content/header/nav-buttons/router), modal-actions, sidebar-panel, settings-layout, theme-toggle, animated-height, character-count-textarea, inline-form-error, chart, cipher-wall, crawler-eye, banner, marketing (accordion/fee-breakdown/cost-pie-chart) |
| Accessibility subsystem | `accessibility/` — provider, widget, panel, controls, sections (visual/typography/motion/audio/pointer-focus/reading-aids/profiles/meta), lib (apply-settings, font-loader, motion-provider, media-pauser, mute, reduced-motion-broadcaster, colorblind-matrices, TTS engine/worker/feeders), store, styles (contrast/typography/motion/pointer/colorblind css) |
| Hooks | use-visual-viewport-height, use-is-touch-device, use-is-mobile, use-animation-frame, use-async-action, use-reduced-motion, touch-device-override-context |

**Duplication check — clean.** Zero direct `@radix-ui/react*` imports in `apps/{web,admin}/src`; no local re-implementations of Button/DialogContent/Card. `apps/marketing/src/components/ui/*` are bespoke marketing components importing `cn` from `@hushbox/ui` (`callout.tsx:2`) — not copy-pasted shadcn.

#### 2.I.2 a11y wrappers — behave as documented

| Wrapper | Verified behaviour | Evidence |
|---|---|---|
| `Img` | `alt: string` required (TS-enforced), defaults `loading='lazy'`, `data-no-invert` only when `decorative` | img.tsx:5-28 |
| `Logo` | `data-no-invert` wrapper, Vite/Astro src resolution, fixed alt | logo.tsx:15-44 |
| `useAnimationFrame` | pauses on merged reduced-motion, live subscription, `respectMotion`/`paused` opts | use-animation-frame.ts:19-68 |
| `useReducedMotion` | OR-merge of OS `prefers-reduced-motion` + store `stopAnimations` + `VITE_E2E`; `shouldReduceMotion`/`subscribeReducedMotion` for non-React callers | use-reduced-motion.ts:28-91 |
| `MotionProvider` | sets both `reducedMotion="always"` AND `skipAnimations` (documented: `reducedMotion` alone leaves opacity/color animating) | motion-provider.tsx:23-30 |

#### 2.I.3 ESLint a11y wall — present and near-complete

`packages/config/eslint.config.js`: raw-`<img>` ban (:393, :427), inline color/font/fill/stroke ban (:388, :422), bare `requestAnimationFrame` global ban (:213), member-form `window|globalThis.(request|cancel)AnimationFrame` ban (:435, `src/**/*.tsx` only), `no-restricted-imports` for gsap/animejs/motion-one (:225-241).

| App | Composes reactConfig? | a11y wall applies? |
|---|---|---|
| apps/web | yes | ✅ full |
| apps/admin | yes (`apps/admin/eslint.config.js:6`) | ✅ full parity with web |
| apps/marketing | yes + astroConfig | ✅ for `.tsx`; ❌ for `.astro` (UI-4) |
| packages/ui | yes | ✅ |

Every raw-`<img>`/inline-style escape hatch in the repo is a justified scoped disable (img.tsx:21, logo.tsx:37, chart.tsx:135/265 Recharts series colors, markdown-renderer.tsx:133 CSS var, native-assets PNG generators, dev.assets.tsx dev-only). Sweep found **zero un-disabled** violations across apps/{web,admin,marketing} + packages/ui.

#### 2.I.4 Overlay-primitive overflow hardening

`DialogContent` caps its own height and scrolls internally: `max-h-[calc(100dvh-2rem)] … overflow-y-auto` with rationale comment (dialog.tsx:58-63; committed in `e93e73ad`). The same class across the other overlays:

| Primitive | max-height / internal scroll | Verdict |
|---|---|---|
| DialogContent | ✅ dialog.tsx:63 | hardened |
| SelectContent | ✅ Radix available-height var (select.tsx:59) | ok |
| DropdownMenuContent | ✅ (dropdown-menu.tsx:36) | ok |
| SheetContent | ❌ no max-height / overflow (sheet.tsx:56-66) | **UI-2** |
| OverlayDialog (desktop) + OverlayContent | ❌ fixed+translate centered, no max-h/overflow (overlay-dialog.tsx:62; overlay-content.tsx:29) | **UI-1** |
| OverlayBottomSheet (mobile) | ✅ `max-h-[90dvh]` + min-h-0 flex (overlay-bottom-sheet.tsx:94,114) | ok |

`Drawer`/`Popover`/`AlertDialog` primitives do not exist in packages/ui — nothing to harden.

#### 2.I.5 Accessibility widget / override system

Lives in `packages/ui/src/components/accessibility/`; schema of record `packages/shared/src/schemas/accessibility-preferences.ts` (Zod, versioned, per-field reconcile :58). Toggles (:7-41): contrast tiers, saturation, colorblind simulation (5 modes), fontSize 88–141%, letter/line/paragraph spacing, fontFamily (system/atkinson/open-dyslexic/lexend), magnifier, readingGuide, TTS (+streamChatAloud), muteSounds, stopAnimations, cursorSize/Color, focusWidth/Color/Halo. Application (`apply-settings.ts:48-57`): `a11y-*` classes on `documentElement` + CSS vars; overrides land in `@layer accessibility` redefining design tokens with `!important` (contrast.css:1-39 — pure token redefinition, no per-component colors); saturation on `body` not `html` to keep `position:fixed` portals working (contrast.css:41). Exactly the CODE-RULES doctrine. `data-chrome` tagged in every app shell (app-shell.tsx, page-header.tsx, chat-layout.tsx:405, admin-nav.tsx:39, admin-topbar.tsx:12, crawler-view dashboard.tsx:145, sidebar-panel.tsx:145,157).

#### 2.I.6 WCAG floor

Focus management: dialogs/menus are Radix (trap/restore free); custom `OverlayDialog` uses `DialogPrimitive.Content` (overlay-dialog.tsx:55) so the trap is intact; `overlay-bottom-sheet-focus.test.tsx` asserts focus; widget uses Radix Sheet with `sr-only` title/description (accessibility-widget.tsx:38-41). No custom component hand-rolls a focus trap. `IconButton` **requires** `'aria-label': string` at the type level (icon-button.tsx:6-7). Skip link: web ships "Skip to content" → `<main id="main" tabIndex={-1}>` (app-shell.tsx:22,32); **admin has `<main>` but no skip link** (admin `__root.tsx:27`, UI-7). Contrast is token-based and widget-overridable (contrast-tiers.test.ts).

#### 2.I.7 Hygiene

`any` in packages/ui non-test source: effectively 1 hit, benign. 7 eslint-disables, each with a specific justification. Component test coverage dense — nearly every `.tsx` has a sibling `.test.tsx`.

#### 2.I.8 Section findings

| # | sev | finding |
|---|---|---|
| UI-1 | 🟠 | **Custom desktop Overlay has the same tall-content overflow bug DialogContent was hardened against.** `OverlayDialog` is fixed+translate-centered with no max-height/overflow (overlay-dialog.tsx:62; overlay-content.tsx:29) — content taller than the viewport pushes actions off-screen on desktop; the mobile bottom-sheet variant is fine. Verified. |
| UI-2 | 🟠 | **`SheetContent` lacks overflow hardening** — no max-height/overflow-y-auto (sheet.tsx:56-66); every consumer must remember scroll (the a11y widget does; a naive consumer clips). Same bug class as the Dialog fix, un-fixed centrally. Verified. |
| UI-3 | 🟡 | **`decorative`/`data-no-invert` is a dead mechanism** — no invert-colors toggle in the schema, no `[data-no-invert]` CSS selector, no `invert()` filter anywhere; the attribute guards a feature that doesn't exist (img.tsx:8,25; logo.tsx:34). Founder Q: build the invert feature or delete the scaffolding. Verified. |
| UI-4 | 🟡 | **`.astro` files sit outside the a11y lint wall** — img/inline-style bans glob `*.{jsx,tsx}` only; astroConfig adds no jsx-a11y (eslint.config.js:339,415,482-493). No current violations, but marketing `.astro` templates are unchecked. Verified. |
| UI-5 | 🟡 | **apps/admin has no user-facing accessibility controls** — mounts A11yProvider+MotionProvider and applies persisted settings, but renders neither the widget nor a panel route (admin `__root.tsx:3,15-37`). Founder Q: intended for an internal tool? Verified. |
| UI-6 | 🟡 | **Member-form rAF ban is `.tsx`-only** — `globalThis.requestAnimationFrame` in `.ts` hooks/lib escapes both bans (eslint.config.js:415,435). Hole in the "always via useAnimationFrame" guarantee. Verified. |
| UI-7 | 🟡 | **Admin `<main>` has no skip link** (web does: app-shell.tsx:22,32). Verified. |
| UI-8 | ⚪ | Chart series colors bypass contrast overrides by design (chart.tsx:135,266 — justified disables); chart swatches are immune to the contrast/saturation layer. Accepted trade-off, flagged. Verified. |

### 2.J Marketing site, crawler-view & Capacitor shell

**Scope:** `apps/marketing` (Astro SSG), `apps/crawler-view` (dev-only crawler simulator), and the Capacitor native shell in `apps/web/src/capacitor/**` + `apps/web/capacitor.config.ts`. Every claim Verified at the cited file:line.

#### 2.J.1 apps/marketing — Astro static site

| Concern | Finding | Evidence |
|---|---|---|
| Build model | Pure SSG (`astro build`), `format:'directory'`, merged into `apps/web/dist` for one Pages deploy; no SSR adapter | astro.config.mjs:75-78; scripts/merge-marketing-into-web.ts (ci.yml:236) |
| Content collection | One `blog` collection, glob MDX, zod schema (title, description ≤160, author, date, tags, optional image, draft) — 4 posts, none draft | content.config.ts:4-18 |
| Blog pipeline | `getPublishedPosts` filters `!draft`, sorts desc; reading-time/tags/related in blog-utilities.ts; MDX + React islands | src/lib/blog.ts:14-17 |
| RSS | `/rss.xml` via @astrojs/rss with full item fields; site fallback `https://hushbox.ai` | src/pages/rss.xml.ts:5-21 |
| Sitemap | @astrojs/sitemap → sitemap-index.xml, referenced by robots.txt; `site` set | astro.config.mjs:26-27 |
| SEO / meta | Canonical + OG + Twitter in both layouts; blog adds `article:*` OG, RSS alternate, JSON-LD Article. Landing layout has no Organization structured data (minor) | LandingLayout.astro:17-40; BlogLayout.astro:20-75 |
| MARKETING_ROUTES parity | SSOT = 7 routes; **all 7 have Astro pages**; newsletter sub-pages + `/blog/[slug]` covered because `findMarketingPages` reads prefix dirs **recursively** per built `index.html` | routes.ts:48-56; generate-headers.ts:402-419, 343-346 |
| CSP dual-emit | `/*` SPA block first, `/demo` relaxed, then per-path blocks that unset-then-set every header; inline scripts SHA-256'd from built HTML; connect-src templated from VITE_API_URL | generate-headers.ts:324-347, 108-146, 427-441 |
| Client fetches | Exactly two: AnnouncementBanner runtime fetch (fail-closed, shared @hushbox/ui banner controller) and welcome.astro build-time models fetch (try/catch → empty). Both fail-fast on missing VITE_API_URL. **No analytics scripts anywhere** | AnnouncementBanner.astro:15-44; welcome.astro:34-49 |
| Accessibility shell | Both layouts inject shared A11Y_INIT_SCRIPT pre-paint + mount A11yProvider/AccessibilityWidget islands; Lucide icons aria-hidden | LandingLayout.astro:44,49-50; welcome.astro:67 |
| 404 | **No 404.astro** — unknown paths fall through to the SPA notFoundComponent (web `__root.tsx:74`) | MK-4 |

#### 2.J.2 apps/crawler-view — previously un-inspected

A **crawler/answer-bot simulator** ("what a no-JavaScript crawler sees"): fetches an operator-supplied URL as a bot (stable Accept, custom UA, manual redirects, timeout) and scores cloaking/robots/sitemap/OG/persona verdicts (dashboard.tsx:148-149; engine/fetch-page.ts:39-76).

- **Dev-only, never deployed:** no `build` script (package.json:6-12); API (`/api/crawl`, `/api/sitemap`) registered via Vite `configureServer` only (crawler-api-plugin.ts:23-42); port fail-fast on missing `HB_CRAWLER_VIEW_PORT` (vite.config.ts:10-16); `noindex,nofollow` meta (index.html:6).
- **Exposes no HushBox data:** analyzes arbitrary public URLs typed by the operator; no auth, no DB, no shared messages — no auth-bypass surface. `fetchRaw` will GET any http(s) URL (SSRF-capable, handlers.ts:7-17 validates scheme only) but is bound to a developer's localhost dev server, never shipped; handlers return opaque JSON errors (handlers.ts:53-60).
- **No SSOT violation:** its robots/sitemap code *parses remote targets for analysis*, not generation; shares @hushbox/ui + shared a11y init (index.html:15-19).
- **Quality:** dense engine/component/handler unit tests (25+ files), 95% perFile coverage gate (vitest.config.ts:8-10,29); in CI lint/typecheck/test fan-out (root package.json:17,21-22; ci.yml:47,58,182); not in any deploy path.

#### 2.J.3 Capacitor native shell

| Concern | Finding | Evidence |
|---|---|---|
| Platform branching | Build-time `VITE_PLATFORM` (zod-parsed enum, throws on invalid) via `isNative()` — not runtime `isNativePlatform()`; every hook self-guards, so `CapacitorProvider` is a no-op on web. Statically-strippable discipline | capacitor/platform.ts:8-24; provider.tsx:65-74 |
| Push registration (**EM-4 resolved**) | `usePushNotifications` → `PushNotifications.register()` → POST to the **new** `client.notifications['device-tokens'].$post({json:{token,platform}})` | use-push-notifications.ts:28-45; provider.tsx:42-49 |
| OTA / checksum | `applyUpdate` prefers server-supplied `updateUrl` from the 426 store; fetches `/updates/current` → `{url,version,checksum}` to `CapacitorUpdater.download` (Capgo rejects tampered bytes); checksum absent ⇒ documented pre-checksum fallback; failure flips upgrade-required modal | live-update.ts:59-91, 98-128 |
| Version-check 426 | api-client extracts `{currentVersion,updateUrl}` from 426 → `setUpgradeRequired`; `otaInProgress` suppresses modal flash during Capgo reload; `X-HushBox-Platform` + `X-App-Version` on every request | api-client.ts:41-81,20-25; use-live-update.ts |
| Payment-poll (**Q7-mobile resolved**) | No `GET /payments/:id` call site anywhere in native/web — only `client.billing.payments.$post` (billing.ts:109). Mobile is on the webhook-authoritative flow | grep clean |
| Deep links | `useDeepLinks` allowlists `/chat`,`/share/m`,`/share/c`,`/settings`,`/usage`,`/billing`,`/accessibility`, deliberately excluding token-sensitive `/verify`,`/login`,`/signup`; malformed → `/`; push taps UUID-validate conversationId | use-deep-links.ts:16-51; provider.tsx:21,55-63 |
| Capacitor config | No `server.url`, no `allowNavigation`, no cleartext flag; `androidScheme:'http'` (documented dev cookie rationale); CapacitorHttp disabled (browser fetch for CSP/cookie parity); CapacitorCookies enabled; `autoUpdate:false` (manual OTA) | capacitor.config.ts:6-31 |
| Plugins | 8, **all used** (app, browser, network, push-notifications, splash-screen, status-bar, core, @capgo/capacitor-updater) — no dead plugin deps | package.json:22-31; capacitor/hooks/* |
| Asset generators | Icons/splash/social banners are React components rendered to images, each with tests; sync via `pnpm asset:sync` | components/native-assets/ (18 files) |

#### 2.J.4 Cross-cutting

CI gates: marketing + crawler-view both get lint/typecheck/test-with-coverage via turbo (95% perFile each); `astro check` runs in CI (ci.yml:45). Env-var discipline: no banned existence-branching — platform/banner/models/CrawlerEye all **fail-fast (throw)** on a missing var; CrawlerEye gates on build-time `import.meta.env.DEV && !VITE_E2E` (strippable); the single `??` is a dev-tooling port default in astro.config.mjs:8 (benign, noted).

#### 2.J.5 Section findings

| # | sev | finding |
|---|---|---|
| MK-1 | 🟠 | **Deep-link association files ship literal placeholders** — AASA `appIDs:["TEAMID.ai.hushbox.app"]`, assetlinks `sha256_cert_fingerprints:["PLACEHOLDER_SHA256_FINGERPRINT"]`; no build-time substitution exists. iOS Universal Links + Android App Links verification will fail in production as-is (`apps/marketing/public/.well-known/*`). Founder Q: deliberate pre-signing deferral? Verified. |
| MK-2 | 🟠 | **`webContentsDebuggingEnabled: true` baked into built Android config** (capacitor.config.ts:14 + generated capacitor.config.json) — WebView remote debugging on in release builds. Gate to dev or set false for release. Founder Q if intentional for beta. Verified. |
| MK-3 | 🟡 | AASA↔deep-link allowlist mismatch: AASA registers `/login`,`/signup` as universal-link targets but the client allowlist excludes them → link opens app then bounces to `/`. Fails safe; UX dead-end. Align the lists. Verified. |
| MK-4 | 🟡 | No static marketing 404 (`404.astro` absent) — crawlers hitting a dead URL get the SPA shell, not a 404. Verified. |
| MK-5 | 🟡 | robots.txt explicitly Allows `/chat`,`/login`,`/signup` (empty SPA shells) and has no `Disallow: /demo` — SEO noise. Verified. |
| MK-6 | ⚪ | Marketing/crawler-view coverage gates at 95% (repo norm) but marketing excludes `src/pages/**` + blog.ts from unit coverage (run only under Astro build/e2e) — accept or extract endpoint logic into tested helpers. Verified. |
| MK-7 | ⚪ | **Resolutions:** EM-4 resolved (mobile push targets new `/notifications/device-tokens`); Q7-mobile resolved (no payment poll anywhere); crawler-view confirmed dev-only with no data-exposure surface. Verified. |

## 22. Codebase quality metrics

All numbers Verified this audit (counted from files read; no checks executed — repo reported green by founder).

| Category | Metric | Value | Assessment |
|---|---|---|---|
| **Scale** | DB tables (new) | 36 (legacy 21 + projects) | — |
| | HTTP route handlers across slices | 119 | — |
| | Typed Redis key registry entries | 108 (legacy monolith ~81) | zero raw key construction in new code |
| | Wire error codes | **81 (legacy 128** — 51 survive, 77 dropped, 30 new-only; Q5) | compile-enforced code⟷message pairing |
| | E2E tests | ~240 non-admin + ~28 admin, 7 projects | doctrine lint-enforced |
| **Enforcement** | Vendored ESLint rules | 16, all run in CI + pre-push | §18 |
| | ts-morph arch rules | 6, in CI (`arch:check`) | §18 |
| | Coverage gate | 95% per-file, live in CI for every package (incl. marketing, crawler-view) | the "pending flip" is done |
| | CI hard gates | lint · arch · typecheck · migration-drift · jscpd · knip · gitleaks · test · build · e2e · mobile-test — no `continue-on-error`, no `if: false` | deploy needs all |
| | Gaps | Prettier enforced nowhere (CI-1); pre-push turbo cache can mask the test gate (CI-2) | both 🟠 |
| **Type safety** | `@ts-ignore`/`@ts-expect-error` in apps/web product code | 0 | exemplary |
| | Product `any` in apps/web | 0 (generated route tree only) | exemplary |
| | Structural gap | RPC response inference vacuous on all 119 handlers (FE-1) | the one big hole the zeros mask |
| **Hygiene** | `console.log` / TODO / FIXME in apps/web | 0 / 0 / 0 | 17 justified console.error/warn |
| | eslint-disables (web non-test) | 66, every one rule-scoped + justified | packages/ui: 7, all justified |
| **SSOT** | Verified single-source | privilege ladder, modality, provider map, TTL/size caps, nano-USD core, token ratios, email scaffolding, Redis keys, error codes | strong |
| | Violations | 5 DUP findings (2 🟠: MEMBER_PRIVILEGES dual-home, media MIME copy-paste) + TE-1 + FE-1 manual response types | concentrated, fixable |
| **Duplication** | jscpd-style copy-paste worth extracting | 2 (nano→dollar render, MIME maps) | per-slice scaffolding repetition is healthy, not debt |
| **Dead code** | Dead exports/registry entries found | PUBLIC_MODELS_URL, fetchModels trio, Imagen pair, 3 enums.ts export groups, provisionUserBilling | all safe deletes |
| **Testing fidelity** | Jobs/DO: platform glue proven under workerd; **real `settle()` never composed inside a DO under workerd; promised settlement crash-fuzz suite absent** | JD-1/JD-2 🔴 | the two most valuable missing tests in the repo |
| | Admin ops: per-op battery strong but not structurally mandated | AD-1/AD-2 🟠 | Tier-1/Tier-2 fixes specified in §14.3 |
| **Security** | Highest-value open items | WS-upgrade Origin check (SEC-1/Q4), Sentry import confinement (SE-1), admin SPA headers (SEC-2) | everything else clean or improved vs legacy |
| **Crypto** | Segregation | 100% of key material inside packages/crypto; OPAQUE byte-identical to legacy; AAD strictly stronger | hybrid v0x01/v0x02 stack is deliberate (§3) |
| **Money** | Settlement core | lock order, atomicity, zero-sum trigger, fences, admission Lua, K=5 circuit — all Verified clean (§2.H) | one founder Q: WF-1 kill-path billing asymmetry |

## 23. Net-new areas (no legacy counterpart)

Discovered and audited surfaces that did not exist in the legacy monolith:

| Area | What it is | Audit home |
|---|---|---|
| Jobs system (JobDispatcher DO + jobs table) | the only must-happen async mechanism; leases, dead-letter rows, read-only auditor | §13 |
| Workflow engine | Zod-validated DAG over a closed node registry, in-DO interpreter, TypeTag algebra, ValueStore | §2.H |
| Admin plane | 17 registered ops, Reversibility Iron Law, preview/execute/undo, Access+YubiKey single auth path | §14 |
| Accessibility subsystem | full widget (contrast/colorblind/typography/motion/TTS/pointer), token-layer overrides, lint wall | §2.I |
| Newsletter slice | double opt-in, batch dispatch, RFC 8058 one-click unsub, Resend webhooks, suppression | §2.E |
| Disputes/chargebacks | clawback legs + auto-lock + session revocation (legacy had none) | §2.C |
| Feedback slice + admin inbox | in-app feedback with admin ops | §14 |
| Announcements/banner | admin-managed banner + per-user dismissals | §14, §6 |
| Public leaderboard | anonymized usage stats + JSON snapshots | §2.C |
| Queue-while-streaming | client-side message queue drained at terminal settle | §2.B |
| OTA live-update | Capgo checksum-verified bundles + 426 version gate | §2.J |
| apps/crawler-view | dev-only crawler simulator (never deployed, no product data) | §2.J |
| Trial global spend cap | $50/day pool **added on top of** the retained 5/day dual-identity quota + 20/60s burst (additive, NOT a replacement — RL-1 corrected) | §11 |

## 24. Consolidated findings register

Every finding in this audit, by ID. Status: **open** (action recommended) · **resolved** (verified safe / already fixed this audit) · **founder-Q** (design decision, see §26).

| ID | Sev | One-liner | Status |
|---|---|---|---|
| SE-1 | 🔴 | No lint confines `@sentry/*` imports to the telemetry adapter — scrub bypassable | open |
| JD-1 | 🔴 | Real `pass.ts`/`settle()` never runs inside a DO under workerd | open |
| JD-2 | 🔴 | Promised randomized settlement crash-injection suite does not exist | open |
| SEC-1 | 🟠 | No Origin check on WS upgrade (CSWSH surface) | founder-Q (Q4) |
| SEC-2 | 🟡 | Admin SPA document ships zero security headers | open |
| SEC-3 | 🟡 | ADMIN_URL CSRF/CORS asymmetry; no __Host- prefix (cutover-bound) | open (minor) |
| SE-2 | 🟠 | All 4 WAE metrics watcher-less; ws-upgrade-failure has no alarm at all | founder-Q (Q10) |
| SE-3 | 🟠 | Expected catalog conditions ride the Sentry defect channel hourly | open |
| SE-4 | 🟠 | no-silent-catch can't force captureError for defects | open |
| SE-5 | 🟠 | No METRIC_NAMES registry / watcher-existence arch test | open |
| SE-6 | 🟡 | No regression test on the Sentry scrub allowlist; no lint against client error SDKs | open |
| RL-1 | ⚪ corrected | **Not removed** — 5/day dual-identity quota + 20/60s burst both live; $50/day pool additive. Original claim was a hard-confirm-caught audit error. | resolved |
| RL-2 | 🟡 | delete-account lockout window 3/1h+24h → 3-in-24h | founder-Q (Q3) |
| CR-3 | 🟠 | Keyed epoch confirmation exists but dead; live path uses bare sha256 | founder-Q (Q2) |
| CR-4 | 🟡 | (same as RL-2) | founder-Q (Q3) |
| CR-5 | 🟡 | FCM RS256 signing outside packages/crypto | open |
| CR-6 | ⚪ | 5 keyless SHA-256 uses via crypto.subtle (consistency) | open (info) |
| DB-1…DB-6 | — | all six schema soft-spots | resolved |
| DB-7 | ⚪ | benign column swaps | resolved |
| IC-1 / IC-3 | — | user-search gate / public share presign | resolved |
| IC-2 | 🟡 | add-member can no longer grant ≥ granter (legacy admin could mint admin) — tightening | open (sign-off) |
| CH-1 | ⚪ | transport/stop/one-run divergences — founder-ruled | resolved |
| CH-2 | ⚪ | legacy chat input was text-only — parity | resolved |
| BL-1 | ⚪ corrected | (same as RL-1 — trial quota retained, not removed) | resolved |
| BL-3 | — | payment-poll removal + balance shape: clients confirmed updated | resolved |
| FEE-1 / FEE-2 | — | markup primitives / charge-mirror equality | resolved (§2.H.9) |
| FEE-3 | ⚪ | base-in-catalog inversion sound | resolved |
| TE-1 | 🟡 | trial/classifier token estimates re-implement ceil(chars/ratio) | open |
| ENV-1…ENV-5 | 🟡 | 5 env existence-branching violations (cors.ts, payment-form, sidebar-footer, drizzle.config, admin-nav) | open |
| ENV-6 | ⚪ | 3 stale factory comments | open (info) |
| ENV-7 | 🟠 | version-check spreads fields outside {code, details} contract | open |
| ENV-8 | 🟠 | Two error-copy systems live (refined by FE-4) | open |
| ENV-9 | 🟡 | Wire-code taxonomy narrowed **128→81**; high-value restores = media-modality + 3 streaming errors (copy already written, unwired); payment-decline granularity is net-new not a restore | founder-Q (Q5) |
| ENV-10 | ⚪ | CODE-RULES stale error-schema paths | open (doc) |
| OR-1 | 🟠 | Hard-coded VEO/Imagen constants in shared barrel (VEO half is LIVE — see LEG-2) | open |
| OR-2 | 🟠 | Vercel gateway env/config still shipped incl. Production | open |
| OR-3 | 🟡 | language-adapter ZDR check absence — defense-in-depth only | resolved |
| OR-4 | 🟡 | PROVIDER_MAP + non-chat exclusions are hand-maintained data | open (aware) |
| OR-5 | ⚪ | negative-pricing sentinel delta; stale docstrings | open (info) |
| CAS-1 | 🟠 | Cassette header-allowlist changed without version bump | founder-Q (Q6) |
| CAS-2 | 🟡 | Stale --require=ai-gateway usage docs | open |
| CAS-3 | 🟡 | Resend + FCM not real-exercised/asserted in CI | open |
| CI-1 | 🟠 | Prettier enforced nowhere automatically; DEVELOPMENT.md claim false | open |
| CI-2 | 🟠 | Pre-push turbo cache can mask the coverage/test gate | open |
| CI-3 | 🟡 | migration-drift CI-only; stryker schedule-only | open (aware) |
| JD-3 | 🟠 | Platform alarm semantics never exercised (all tests force-fire) | open |
| JD-4 | 🟠 | in-memory idleStep loss on eviction unverified | open |
| JD-5…JD-8 | 🟡 | multi-isolate contention / neon-proxy latency / wake delivery / wall-clock lease | open |
| AD-1 | 🟠 | Reversibility battery not structurally mandated | open (Tier-1 fix specified) |
| AD-2 | 🟠 | No generic registry-driven undo round-trip harness | open (Tier-2 fix specified) |
| AD-3 | 🟡 | 3 ops lack the interleaving property test | open |
| AD-4 | 🟡 | maxTargets guardrail defined but unimplemented | open |
| AD-5 | ⚪ | purity-rule Date.now gap; stale CLAUDE.md wording | open (info) |
| E2E-1 | 🟠 | Harness-bypassing specs import raw @playwright/test | open |
| E2E-2 | 🟠 | Coverage holes: 2FA recovery codes, media upload, stop-stream, marketing, Capacitor | open |
| E2E-3 | 🟡 | Conditional assertions that can silently no-op; empty fixme stub | open |
| E2E-4 | 🟡 | 11 serial describes from shared personas; brittle selectors | open |
| EM-1 | — | provisionUserBilling dead (delete it) | resolved |
| EM-2 | 🟡 | Password-reset ships "changed" subject (legacy: "reset") | founder-Q (Q11) |
| EM-3 | 🟡 | GC semantics changed (safe, flagged) | resolved (aware) |
| EM-4 | — | device-token path — mobile client confirmed on new route | resolved |
| EM-5 | ⚪ | FCM stale-token pruning absent both sides | open (info) |
| FE-1 | 🟠 | RPC response typing vacuous app-wide (119 handlers / 69 manual casts) | open |
| FE-2 | 🟠 | 14 raw fetch() in OPAQUE/2FA bypass version-header shim | open |
| FE-3 | 🟠 | No centralized mid-session 401/revocation handling | open |
| FE-4 | 🟠 | friendlyErrorMessage migration incomplete (6 files legacy) | open |
| FE-5…FE-7 | 🟡 | WS backoff jitter / ad-hoc query keys / non-zod validateSearch | open |
| FE-8 | ⚪ | trial-chat store exception documented | resolved |
| WF-1 | 🟠 | Cost-circuit trip discards accrued provider spend unbilled (deadline settles partial) | founder-Q (Q9) |
| WF-2 | 🟡 | "save" edge-check checkpoint is vacuous (doc fix) | open |
| WF-3 | 🟡 | Idempotency arch rule doesn't cover non-exempt handlers | open |
| WF-4…WF-7 | ⚪ | subWorkflow deferred / smartModel 7th node / Lua 2^53 bound / FEE resolution | resolved (aware) |
| UI-1 | 🟠 | OverlayDialog lacks the tall-content overflow hardening | open (Q16 policy) |
| UI-2 | 🟠 | SheetContent lacks overflow hardening | open (Q16 policy) |
| UI-3 | 🟡 | data-no-invert guards a nonexistent invert feature | founder-Q (Q12) |
| UI-4 | 🟡 | .astro files outside the a11y lint wall | open |
| UI-5 | 🟡 | Admin has no user-facing a11y controls | founder-Q (Q13) |
| UI-6 | 🟡 | rAF member-form ban is .tsx-only | open |
| UI-7 | 🟡 | Admin main has no skip link | open |
| UI-8 | ⚪ | chart colors bypass contrast layer by design | resolved (aware) |
| MK-1 | 🟠 | AASA/assetlinks ship literal placeholders — store links will fail | founder-Q (Q14) |
| MK-2 | 🟠 | Android WebView remote debugging enabled in release config | founder-Q (Q15) |
| MK-3…MK-5 | 🟡 | AASA↔allowlist mismatch / no 404.astro / robots.txt noise | open |
| MK-6 / MK-7 | ⚪ | coverage exclusions / resolutions log | resolved (aware) |
| DUP-1 | 🟠 | MEMBER_PRIVILEGES + zod enum dual-homed, both live | open |
| DUP-4 | 🟠 | Media MIME allowlist copy-pasted byte-identically ×2 | open |
| DUP-2 / DUP-3 / DUP-5 | 🟡 | privilege ordering / nano-render / utcDayKey re-impls | open |
| DEAD-1 | 🟠 | PUBLIC_MODELS_URL + fetchModels trio dead in prod | open (delete) |
| DEAD-2 | 🟡 | Imagen pair + enums.ts dead export groups | open (delete) |
| LEG-1 | 🟡 | legacy*-named shared exports live-imported by new code (rename) | open |
| LEG-2 | ⚪ | correction: VEO helpers are live | resolved |
| INF-1 / m4 / CR-1 / CR-2 / SE-7 / RL-3 / SEC-4 / CI-4 / E2E-5 / OK-1 | — | verifications, positives, corrections | resolved |
| GB-1 | 🟠 | New server never calls shared `resolveBilling` — client/server funding+premium logic are parallel implementations | open (Q17) |
| GB-2 | 🟡 | Self-funding member premium refusal now `MODEL_TIER_LOCKED` (legacy: `PREMIUM_REQUIRES_BALANCE`) — verify client renders both | open |
| GB-3 | 🟡 | Owner-funded path never re-checks owner tier for premium (legacy checked `canUseModel(owner)`) | founder-Q (Q18) |
| GB-4 | ⚪ | Absent member-budget row ⇒ member self-funds (matches legacy) | founder-Q (Q19) |
| GB-5 | ⚪ | Budget display narrowed to own row for non-owners — founder-approved privacy improvement | resolved |

**Counts:** 3 🔴 · 29 🟠 (13 open-actionable, 8 founder-Q, 8 already-specified fixes) · ~35 🟡 · rest ⚪/resolved. Zero unresolved soft assertions remain — every claim in this report is Verified or explicitly a founder question.

## 25. Open founder questions

Design decisions only the founder can settle. Everything else in this report is either verified-resolved or has a concrete recommended fix.

| # | Question | Source |
|---|---|---|
| Q1 | **Trial abuse model** (premise CORRECTED): the 5/day dual-identity quota (trial-quota.ts:68) + 20/60s per-IP burst (rate-limit.ts:23) are **both retained**; the $50/day global pool is additive. The one real design property left to confirm: pool exhaustion refuses ALL trial users for the rest of the UTC day (shared fate). Accept, or bound the pool per-identity/per-window? | RL-1 / BL-1 |
| Q2 | **Keyed epoch confirmation**: stronger HKDF `computeEpochConfirmation` exists with 0 usages; live path still uses bare `sha256(epochPriv)`. Wire in the keyed version, or delete it and accept the bare hash? | CR-3 |
| Q3 | **delete-account lockout window** changed from 3-attempts/1h (+separate 24h lock) to 3-attempts-in-24h — a fat-fingered user now locks deletion for a full day. Intended? | RL-2 / CR-4 |
| Q4 | **WebSocket CSWSH surface**: no Origin check on WS upgrade + `SameSite=None` cookie ⇒ a cross-site page can open an authed socket (bounded by membership). Accept, or add the allowlist Origin check on upgrade? (Recommended: add — small change, mirrors csrfProtection.) | SEC-1 |
| Q5 | **Wire error-code taxonomy narrowed 128→81** (counts corrected). Founder chose to restore granularity. Verified targets: **restore media-modality errors** (UNSUPPORTED_MODALITY + resolution/duration/config — copy exists, unwired) and **3 streaming errors** (CONTENT_POLICY, CONTEXT_LENGTH_EXCEEDED, NETWORK_ERROR — copy exists, only STREAM_ERROR/CHAT_STREAM_FAILED minted today); payment-decline granularity is **net-new** (legacy had one code) worth building from the captured `declineReason`. Keep payment-lifecycle/storage/not-found flattened. | ENV-9 |
| Q6 | **Cassette `AI_RECORDING_VERSION`**: header allowlist changed without a version bump, so legacy v1 cassettes are unreplayable (one-time re-record charge). Bump to v2 for a clean directory? | CAS-1 |
| Q7 | ~~Payment-poll/balance clients updated?~~ **Closed — Verified**: no poll call site remains in web or Capacitor; clients consume the new balance shape. | resolved |
| Q8 | ~~Legacy multimodal image input?~~ **Closed — Verified**: legacy chat input was text-only; new text-only ports are exact parity. | resolved |
| Q9 | **Cost-circuit kill-path billing**: a circuit trip settles NOTHING — accrued provider spend (up to ~hold×5) is platform loss — while a deadline stop settles the billable partial. Intended user-safe posture, or should a trip settle like a deadline? | WF-1 |
| Q10 | **WAE watcher**: all 4 shipped metrics are watcher-less; `realtime_ws_upgrade_failure` (the day-one WS-fallback re-entry signal) has no alarm at all. Build the Analytics Engine SQL watcher now, or formally accept the deferral? | SE-2 |
| Q11 | **Password-reset email copy**: recovery reset now ships subject "Your password was changed" (legacy: "Your password was reset"). Keep the shared port, or add a distinct reset subject? | EM-2 |
| Q12 | **Invert-colors scaffolding**: `data-no-invert` plumbing exists but no invert toggle/CSS does. Build the feature or delete the scaffolding? | UI-3 |
| Q13 | **Admin accessibility controls**: admin applies persisted a11y settings but offers no in-app way to open the panel. Intended for an internal tool? | UI-5 |
| Q14 | **Store deep-link files**: AASA/assetlinks ship literal placeholders (`TEAMID`, `PLACEHOLDER_SHA256_FINGERPRINT`) with no substitution step — Universal/App Links will fail in production. Deliberate pre-signing deferral with a documented fill-before-submit step? | MK-1 |
| Q15 | **Android WebView remote debugging** is enabled in the built release config (`webContentsDebuggingEnabled: true`). Intentional for the beta phase, or gate to dev? | MK-2 |
| Q17 | **Billing logic dual-home**: `resolve-billing.ts` documents itself as the one function "both frontend and backend call," but the new server re-implements who-pays + premium gating natively (turn-context.ts, tier-gate.ts) and never calls it — client and server can drift. Route the server through shared `resolveBilling`, or retract the docstring and pin parity with a contract test? | GB-1 |
| Q18 | **Owner-funded premium rule**: the new server exempts owner-funded turns from the tier gate entirely — any owner with positive purchased balance funds any premium model for any member; legacy explicitly checked `canUseModel(owner)`. Confirm the unconditional rule is intended. | GB-3 |
| Q19 | **Default member cap**: a member with no `member_budgets` row silently self-funds (zero group headroom) rather than being blocked or unlimited — matches legacy. Confirm owners must explicitly grant a positive cap for members to spend owner funds. | GB-4 |
| Q16 | **Overlay hardening policy**: should the Dialog-style `max-h`/`overflow` guarantee be pushed into `SheetContent` + `OverlayDialog` as a primitive-level contract, or stay per-consumer opt-in? (Recommended: primitive-level — the Dialog fix precedent.) | UI-1 / UI-2 |

<!-- ============ WAVE-3 EXPLORATION (pending adversarial verification) ============ -->

## 26. Deploy pipeline & release flow

> Status: **pending hard-confirm pass** — findings below will enter §24/§25 only after independent verification.

**Scope note (Verified):** no `.github/workflows/deploy.yml` exists — backend deploy is the **`deploy` job inside `ci.yml`** (`ci.yml:673-898`); `release.yml` is mobile-store/APK binaries only (workflow_dispatch, gated on existing `vX.Y.Z` tags); `backup.yml` excluded by founder ruling.

### 26.1 Deploy gating & trigger

Trigger: push to `main` only (`ci.yml:678`), GitHub `environment: production` (`:679`), GitHub-hosted runner (`:673-675`). **Full CI suite gates deploy:** `needs: [lint, typecheck, duplication, unused, test, build, e2e, mobile-test, version]` (`ci.yml:677`).

### 26.2 Deploy step ordering (load-bearing)

| # | Step | ci.yml |
|---|---|---|
| 1-2 | checkout + setup; verify version non-empty | 717-729 |
| 3 | download `web-dist` + `admin-dist` artifacts (built in `build` job) | 731-741 |
| 4 | **24× `wrangler secret put`** on product worker — incl. `APP_VERSION` = NEW version (:758) | 743-771 |
| 5 | verify secrets (presence-only `secret list` grep) | 776-788 |
| 6-7 | resolve + run **pre-deploy** ops scripts (PR labels) | 801-818 |
| 8 | **`db:migrate` against production Neon** (`DATABASE_URL` secret) | 820-823 |
| 9 | **deploy API Worker** (`wrangler deploy`) | 825-830 |
| 10 | **deploy Web → Pages** (`pages deploy dist --project-name=hushbox`) | 832-837 |
| 11 | **deploy Admin assets Worker** | 839-844 |
| 12 | run **post-deploy** ops scripts | 846-855 |
| 13 | health smoke: `sleep 10; curl -f …workers.dev/health` | 857-860 |
| 14 | download `mobile-dist`; **upload OTA bundles to R2 + mint `APP_BUNDLE_CHECKSUM_*` secrets** (sha256 per platform) | 862-890 |
| 15 | `git tag vX.Y.Z && push` (last, no `if: always()`) | 892-897 |

### 26.3 Wrangler specifics

Product `hushbox-api`: DO migrations declarative (`[[migrations]]` v1 ConversationRoom, v2 JobDispatcher — `api/wrangler.toml:25-31`); routes `api.hushbox.ai` (dashboard custom domain) + explicit `admin.hushbox.ai/api/*` (`:45-52`); observability deliberately off to avoid logging admin SQL query URLs (`:11-15`); **still ships dead `PUBLIC_MODELS_URL` Vercel var** (`:58`; deploy ops-env re-exports it, `ci.yml:701`) — cross-ref OR-2/DEAD-1 (DP-7). Admin `hushbox-admin`: assets-only, SPA fallback, `admin.hushbox.ai/*`, no secrets.

### 26.4 OTA minting & version-gate coherence

Per-platform bundles (`ios android android-direct`, distinct `VITE_PLATFORM`, same `VITE_APP_VERSION`) built in `build` (`ci.yml:259-284`); deploy step 14 zips each → `wrangler r2 object put hushbox-app-builds/builds/$platform/$VERSION.zip` → `sha256sum` → `wrangler secret put APP_BUNDLE_CHECKSUM_{IOS,ANDROID,ANDROID_DIRECT}` (`ci.yml:868-890`). Serving: `GET /updates/current` → `{version: APP_VERSION, checksum by X-HushBox-Platform}`, no-store, absent binding ⇒ checksum omitted (skip-integrity by design) (`platform/updates/routes.ts:104-111,44-71`); `GET /updates/download/:platform/:version` streams R2, 404 `BUILD_NOT_FOUND` if missing (`:113-137`); `/updates` prefix is version-check-exempt (`version-check.ts:22-27`).

**Coherence:** client `VITE_APP_VERSION` and server `APP_VERSION` both derive from the one `version` job output in the same run (`ci.yml:232,267,274,697,758`) — single-sourced. **But the gate is strict equality** (`version-check.ts:64`); **no `MIN_SUPPORTED_APP_VERSION` exists anywhere** (grep) — every deploy hard-426s all prior-version clients until OTA/reload (DP-4).

### 26.5 Secrets & leakage (clean)

Prod secrets only via `secret put`; gitleaks full-history in CI; **VITE_* leakage clean** — the only secret-sourced `VITE_*` is `VITE_HELCIM_JS_TOKEN`, registry-destined `[Destination.Frontend]` (publishable client token — `env.config.ts:472-475`, `env.config.test.ts:308`). `verify:env --mode=production` gates deploy transitively via the `build` job (`ci.yml:222-223`).

### 26.6 Migrations & rollback

`db:migrate` (drizzle-kit) runs on the deploy runner with the full-privilege production `DATABASE_URL` **before** worker deploy — correct for additive; nothing enforces expand/contract, and a multi-file set is non-atomic (per-file transactions; partial apply on mid-set failure). **No rollback exists**: no `wrangler rollback`/versions/gradual deployment; health-check failure aborts mid-pipeline leaving migrations applied + workers deployed, untagged, OTA-less. No deploy runbook exists in docs (DP-9).

### 26.7 Section findings (pending verification)

| # | sev | finding |
|---|---|---|
| DP-1 | 🟠 | **OTA advertise-before-publish race:** `APP_VERSION` flips at step 4 and the API worker goes live at step 9, but R2 bundles + `APP_BUNDLE_CHECKSUM_*` mint at step 14 — in the gap `/updates/current` advertises the NEW version with the OLD checksum (checksum not keyed by version, routes.ts:64-71,110) and `/updates/download/<platform>/NEW` 404s; mobile auto-update fails or fails integrity. |
| DP-2 | 🟠 | **No rollback + non-atomic partial deploys:** failure at any step (esp. the health smoke) leaves migrations committed and some surfaces deployed, untagged, OTA-less; no automated recovery. |
| DP-3 | 🟠 | **Destructive-migration window unfenced:** migrate-before-deploy is safe only for additive changes; a drop/rename breaks the still-live old worker during the gap; no expand/contract discipline enforced. |
| DP-4 | 🟡 | **Version gate is strict equality, no floor:** no MIN_SUPPORTED_APP_VERSION; every deploy hard-426s all prior-version clients (no grace band / staged rollout). |
| DP-5 | 🟡 | **Health check shallow + wrong host:** `workers.dev/health` after `sleep 10` — never the custom domain, admin route, DB, or version; failure just aborts. |
| DP-6 | 🟡 | **Secrets re-pushed every deploy; verification presence-only** — orphaned/renamed worker secrets and value freshness undetected (ci.yml:743-788). |
| DP-7 | ⚪ | Dead Vercel `PUBLIC_MODELS_URL` still deployed as worker var (cross-ref OR-2/DEAD-1). |
| DP-8 | ⚪ | `deploy.yml` is a phantom — deploy lives in ci.yml; release.yml is mobile-binary-only. |
| DP-9 | ⚪ | No deploy runbook documented (ordering/rollback/OTA/gate semantics). |
| DP-10 | ⚪ | Absent checksum ⇒ integrity silently skipped by design (first-run/new-platform bundles unverified). |

**Founder questions (deploy):** (a) DP-4 — strict-equality gate intended, or add a supported-version floor? (b) DP-1 — reorder OTA publish before APP_VERSION flip, or key checksum by version? (c) DP-2/3 — accept no-rollback + unfenced migrations as a deliberate limit (and document it), or fence? (d) DP-5 — point health at `api.hushbox.ai` + deepen probe?

## 28. Realtime room-core (ConversationRoom DO)

> Status: **pending hard-confirm pass.**

Scope: `packages/realtime` implementation (tests were §13). Thin-shell DO = `conversation-room.ts`; behavior = `room-core.ts` + helpers; worker wiring = `conversations/adapters/realtime-room-bindings.ts` + `membership*.ts`.

### 28.1 Doctrine conformance — all Verified

| Doctrine | Implementation | Evidence |
|---|---|---|
| Hibernatable WS sole transport | `ctx.acceptWebSocket` + hibernation handlers | conversation-room.ts:335, 216-234 |
| Disconnect never cancels | close → untrack + presence only, RunControl untouched | room-core.ts:312-315 |
| Reconnect replays per-stream from Last-Event-ID | `resume` → `buffer.resume(streamId, lastEventId)` | room-core.ts:369-388; replay-buffer.ts:85-91 |
| Explicit stop = HTTP, settles partial | `POST /run/stop` → `runControl.stop('user-stop')` | conversation-room.ts:277-283; run-control.ts:64-71 |
| Membership revalidated at broadcast | `deliverEach` → `verifier.verify` per principal per frame | room-core.ts:790-792; revocation.ts:70-89 |
| Redis down ⇒ pause past last-known-good | `fallback()` returns `pause` past `lastKnownGoodMs` | liveness.ts:57-65 |
| Eviction on membership change/rotation/revocation | prompt fan-out (`evictUserFromRooms`) + broadcast-time backstop | room-core.ts:807-827; user-rooms.ts:49-69 |
| Nothing commits mid-run | money duties only at one terminal sink | room-core.ts:679-744 |

### 28.2 Hibernation state map

`SocketAttachment` survives via `serializeAttachment`; ping/pong auto-response re-armed each wake (conversation-room.ts:177-179). In-memory-only: ReplayBuffer, RunControl, liveness memos, dev held-stream release. **Key correctness point (Verified):** the replay buffer exists only during an active run (created room-core.ts:505, dropped :523/:686), and a live run's in-flight executor work keeps the isolate resident — so "memory-only buffer lost on hibernate" never bites; after a true eviction, `buffer` is null → every resume gets `stream-gone` → client falls back to fetch-after-settlement (room-core.ts:371-375). Matches doctrine.

### 28.3 Replay buffer

Per-stream **byte** cap `REALTIME_MAX_STREAM_BYTES = 2 MiB` (realtime-room-bindings.ts:61), measured on serialized frame UTF-8 (replay-buffer.ts:68-75); overflow drops the whole stream's replay permanently with explicit `gone` (never a silent gap, :76-80); cursors strictly-increasing from 1, violation throws (:58-62); resume filters `cursor > lastEventId` — dedupe inherent (:90); `MAX_RESUME_STREAMS = 32` (protocol.ts:20-32); one buffer per run, dropped at terminal.

### 28.4 Membership + session revalidation windows

Membership: Redis TTL 30 s (eager delete on revocation; TTL only bounds a missed delete), in-mem memo freshness 2 s, last-known-good 15 s → then **pause** (membership.ts:27-29; liveness.ts:61-70). Session: freshness 2 s, last-known-good 15 s, Redis is the source (realtime-room-bindings.ts:250-251). A `dead`/`revoked` decision never un-revokes on failure (liveness.ts:58-60). Trial-room self-access carved out without DB hit (protocol.ts:180-182).

### 28.5 Run coordination

In-memory `RunControl.claim` (different runKey → 409 CONCURRENT_RUN; same key → referee attach) + durable fenced `claimRun` referee; in-mem claim released on every non-execute branch (run-control.ts:32-41; room-core.ts:441-494). Heartbeat `setInterval` 30 s ("under half the 90 s lease"); `'lost'` → stop the zombie (room-core.ts:185,567-585). Deadline `setAlarm` at start, `onAlarm → stop('deadline')`, deleted at terminal (:504,604-612,685). **Stop is HTTP-only — no WS stop frame** (protocol.ts:40-44; matches ARCHITECTURE's "HTTP path", RT-7). Admission awaited in `startRun` so refusal is an HTTP 409 (:542-549).

### 28.6 Flow-executor integration

Injected `FlowExecutor`; ValueStore in-memory per-run (20 MiB budget in a ~128 MB isolate). DO eviction mid-run = fast-fail (lease lapses ~90 s, `failRun` fence frees the key for one serialized retry). **No `ctx.waitUntil` anywhere in packages/realtime** (grep) — run continuation + terminal best-effort duties (`releaseHold`/`failRun`/`notify`) ride bare `void` promises on the event loop (RT-4).

### 28.7 Presence/typing/telemetry — content-leak clean

Typing userId overwritten with authenticated `attachment.principalId` (room-core.ts:391-401); presence = ids/displayName only (presence.ts:18-28); telemetry is a closed id-only event set (telemetry.ts:7-32); push side-band carries ids only (room-core.ts:77-82,707-722); zero `console.*` in the package. No free-form logging surface exists by construction.

### 28.8 Memory safety

`WeakMap<WebSocket, RoomSocket>` (GC-safe); single-slot run state. Gaps: replay-buffer stream **count** uncapped (RT-3); liveness memo Maps never evict for DO lifetime (RT-5); **no send backpressure** — `sendQuietly` never inspects `bufferedAmount` (RT-2, room-core.ts:878-888).

### 28.9 Hygiene & error boundary

Zero `any`/ts-ignore; 2 justified eslint-disables (ambient shims). Control routes don't wrap `request.json()` — malformed JSON → 500 not 400 (RT-1, conversation-room.ts:241,249,257,278); client WS messages parse-guarded (room-core.ts:642-651); `done` rejection contained as `{failed, INTERNAL}` so claim+alarm always release (:587-598); executor sync-throw does full rollback (:520-528). Close codes: 1008 evicted/revoked, 1011 invalid-attachment/send-failed; deadline/stop never close sockets. **`legacy_conversation-room.ts` (889 LOC) is shipped dead code** — referenced only by its own test (RT-6).

### 28.10 Section findings (pending verification)

| # | sev | finding |
|---|---|---|
| RT-1 | 🟡 | DO control routes 500 on malformed JSON (`request.json()` unwrapped; safeParse guards schema only). Trusted internal callers — low blast radius, inconsistent discipline. |
| RT-2 | 🟡 | No WS send backpressure: a present-but-slow consumer on a long token stream grows the runtime send buffer unbounded (`bufferedAmount` never checked). |
| RT-3 | 🟡 | Replay buffer caps per-stream bytes (2 MiB) but not stream count — total = 2 MiB × #streamIds. Non-issue if the executor's streamId set is bounded (it is per declared fan-out width) — needs the one-line invariant comment. |
| RT-4 | ⚪ | No `ctx.waitUntil` in the DO: terminal best-effort duties ride bare `void`; if the isolate is reclaimed post-response with no live work, `releaseHold`/`failRun` fall to their TTL/lease backstops (slower recovery, not money loss). Founder confirm intended. |
| RT-5 | ⚪ | Liveness memo Maps never evict (bounded by distinct principals/sessions over a long-lived room). |
| RT-6 | ⚪ | `legacy_conversation-room.ts` (889 LOC) shipped-but-dead — bundle with the LEG-1 cleanup. |
| RT-7 | ⚪ | Stop is HTTP-only (no WS stop frame) — matches doctrine; flagged only as an expectation gap vs the audit brief. |

**Founder questions (realtime):** (a) RT-4 — is the no-waitUntil posture deliberate (TTL/lease backstops accepted as the recovery)? (b) RT-2 — should `sendQuietly` drop-and-`stream-gone` sockets past a `bufferedAmount` threshold? (c) RT-3 — confirm streamIds per run are bounded by the declared fan-out width and add the invariant comment. (d) RT-1 — tighten DO control routes to 400 on malformed JSON, or accept? (e) RT-6 — confirm deletion.

## 29. Admin SPA application code

> Status: **pending hard-confirm pass.**

**Scope:** `apps/admin/src` (66 non-test source files, 68 test files), §2.G rubric applied. **Headline: materially cleaner than apps/web on every axis §2.G flagged** — the shared FE-1 root cause exists but admin never hand-casts; FE-2/FE-4 have no analog here.

### 29.1 API client & typed-response gap

One `hc<AppType>` client + one `adminFetch = createDevAuthFetch(...)` wrapper (api-client.ts:30-42); **zero unsanctioned raw fetch** (grep clean; `prefillOp` rides the wrapper, op-run.ts:47). Prod auth: Cloudflare Access edge-injects the JWT, wrapper attaches nothing; dev/E2E lazily mints a dev Access JWT from `/api/dev/admin-token`, in-memory only, re-mints once on 401 (dev-auth.ts:32-67). Op invocation: generic form → `client.admin.ops[':name'].preview|execute.$post` — no per-op endpoints (op-run.ts:14-80). Response typing: same vacuous-`AppType` root cause (16 of the 119 bare-`Response` handlers), **but all 16 `fetchJson<T>` sites use `fetchJson<unknown>` + shared-Zod re-validation — 0 hand-casts, 0 locally-redeclared types, 0 drift risk** (AS-4; contrast web's 69 casts).

### 29.2 Registry-driven form generator — total

One generic `<OpForm>` renders entirely from contract-derived descriptors (op-form.tsx:299-367); `describeField` is **total over the schema grammar** (unwraps Optional/Nullable/Default/Readonly; enum/number/boolean/group; else text fallback — op-fields.ts:32-80,126-136); unknown ops fall back to required-text from the wire catalog. Groups = arrays of flat scalars with reorder/prepend/delete + error-key remapping (op-form.tsx:129-291). `reason` forced last in every form and required (op-fields.ts:116-135; contract rejects mutation input lacking reason — contract.test.ts:48-71); prefill strips `reason` so the operator always types it (op-run.ts:59). Adding an op is zero-code in the SPA.

### 29.3 Preview → execute → undo

Step machine form→preview→result; **Execute renders only in preview step and only when `preview.data` exists** (op-modal.tsx:92-100) — a guardrail-blocked preview shows `friendlyErrorMessage(code)` + raw code with Execute suppressed. **Verified funnel: every mutation rides the OpModal** (grep — the sql-panel mutation is SELECT-only; newsletter render is a pure preview). `Idempotency-Key` minted once per form submission, reused across retries (op-modal.tsx:195; op-run.ts:76). Undo surfaced in the result step when `contract.inverse` exists, runs through the same modal carrying `undoes: auditId` (op-modal.tsx:132-142).

### 29.4 Query/Router · 29.5 State

8 hooks, **every key rooted `['admin', …]`** (zero ad-hoc keys); execute-success invalidates the `['admin']` root (deliberate — ops compose arbitrary slice effects; covers Undo) (op-modal.tsx:210-218); `retryUnlessClientError`, no focus refetch (query-provider.tsx:12-29). `validateSearch` on 3 routes is hand-rolled `typeof`, not zod (AS-3 — FE-7 analog). **No Zustand/stores at all; zero server-state leakage** (grep clean).

### 29.6 Error handling

**Fully migrated to modern `friendlyErrorMessage`; zero legacy-map usage** (contrast FE-4). 429s render a countdown notice from `details.retryAfterSeconds` (rate-limited.ts:1-32). Gaps: **no centralized 401 handling** and — worse — **production Access-cookie expiry yields a 302→login HTML page that `fetchJson` JSON-parses into a raw `SyntaxError`** shown as a generic load failure; the dev-only re-mint is disabled in prod; recovery requires a manual reload (AS-1). **No app-level error boundary or router `defaultErrorComponent`** — a shell/provider throw blanks the SPA (AS-2, router.tsx:10-13; __root.tsx:13-43).

### 29.7 Hygiene · 29.8 Customer-360

0 `any`, 0 ts-ignore, 0 eslint-disable, 0 console, 0 TODO (generated route tree only); 68 test files / 66 source; **95% perFile coverage gate live** with a merged-config assertion (vitest.config.ts:7-10,54-59). Customer-360: per-panel `Panel<T>` render-or-inline-error (one broken panel never blanks the page); audited reads fire only on explicit action (feedback row-expand `enabled:id!==undefined`; subscriber list behind an explicit "Load subscribers (audited)" button); volume caps server-enforced with client truncation notices only; ciphertext boundary respected (no content, no token values — customer-360-screen.tsx:221,265).

### 29.9 Section findings (pending verification)

| # | sev | finding |
|---|---|---|
| AS-1 | 🟠 | **Prod Access-expiry mid-session has no clean UX:** no re-mint in prod; expired cookie → 302→login-HTML → `res.json()` throws raw SyntaxError (not ApiError) → generic "Failed to load"; no interceptor/reload. FE-3 analog, degraded by the HTML-not-401 shape (api-client.ts:59-81; dev-auth.ts:45-47). |
| AS-2 | 🟠 | **No app-level error boundary / `defaultErrorComponent`** — a render throw outside a query blanks the SPA (router.tsx:10-13; __root.tsx:13-43). |
| AS-3 | 🟡 | `validateSearch` hand-rolled `typeof` guards on all 3 search routes; no zod SSOT (FE-7 analog). |
| AS-4 | 🟡 | `AppType` response inference vacuous for admin's 16 handlers (FE-1 root cause) — mitigated in practice by `fetchJson<unknown>` + shared-Zod re-validation; latent-only. |
| AS-5 | ⚪ | Admin traffic carries no `X-App-Version`/platform headers — exempt from the 426 gate, almost certainly intentional; confirm. |
| AS-6 | ⚪ | Cross-ref SEC-2: authed admin document still ships no security headers (backlog item 20). |

**Net positives vs web (for the parity map):** 0 raw-fetch bypasses (vs 14) · 0 hand-typed casts/redeclared types (vs 69+2) · modern error copy fully adopted · no stores · consistent key factories · total schema-driven forms · clean hygiene · 95% perFile gate.

**Founder questions (admin SPA):** (a) AS-1 — reload-on-401/HTML-parse-failure to re-trigger Access? (b) AS-2 — add root error boundary + defaultErrorComponent? (c) AS-3 — adopt zod validateSearch (same decision as web FE-7)? (d) AS-5 — confirm admin's 426 exemption is intentional.

## 32. Notifications & account slices; GB-2 client copy

> Status: **pending hard-confirm pass.**

### 32.A Notifications slice

**FCM HTTP v1 push** (adapters/push-fcm.ts): OAuth2 JWT-bearer mint with in-isolate token cache refreshed 5 min early (:11-13,111-139); RS256 via `crypto.subtle.importKey('pkcs8')` (:79-108); fail-fast on missing service-account fields (:40-55,162); per-token `Promise.allSettled` — one bad token never fails the send (:169-211); error strings carry HTTP status only, never token values (:189); evidence row recorded on success (:204-209). **Stale-token handling ABSENT:** the adapter discards the FCM response body — never parses `UNREGISTERED`, never learns which token failed, never calls the existing `deleteByToken` (device-token-store-db.ts:37-45) — dead tokens accumulate indefinitely (NA-1). Legacy had no pruning either (EM-5 parity — this quantifies it as a live adapter gap, not just parity).

**Resend email adapter** (adapters/email-resend.ts): single send has **no idempotency key by explicit design** (timeout-only, no retry — double-delivery avoidance, :20-25,111-116); batch send carries caller-supplied `Idempotency-Key` + positional-integrity check `data.length === messages.length` (:118-141); secret/content hygiene clean. **No suppression/bounce/complaint gate exists before any send** (grep 0 hits; newsletter unsubscribe tokens are a separate surface) (NA-2).

**Device tokens:** `POST` = `byUpsert` `ON CONFLICT (token) DO UPDATE` (token re-homes to caller); `DELETE` = `byTransition` scoped `(userId, token)` zero-rows-no-op; both `session`-class with correct exempt-wrapper pairing (routes.ts:42-80; device-token-store-db.ts:16-45). Single-writer holds.

**Push triggers & filtering:** new-message is the **sole** trigger (no mention pushes — legacy parity); recipients exclude muted, sender, and present users (push-recipients.ts:15-23); payload is `{conversationId}` + fixed generic title/body — **content never enters the push** (notify-message.ts:26,58-63); failure degrades as `push.delivery.degraded`, never crashes the request. Legacy parity table: trigger/mute/sender/presence all ✅; new hard-codes generic copy where legacy allowed caller copy — an improvement (removes a content-leak vector).

### 32.B Account slice

**custom_instructions: ciphertext-only** — `encrypted_instructions bytea`, ECIES-wrapped to the account public key; API base64-decodes → size-caps (32 KiB) → stores opaque bytes; no decrypt/plaintext branch anywhere (schema/custom-instructions.ts:7,16; instructions.ts:17-54) ✅ matches the privacy posture. **preferences.accessibility: plaintext jsonb** with Last-Writer-Wins upsert (`lte(updatedAt, incoming)`; equal-timestamp wins so replays converge; stale write returns authoritative state; read-back miss → conflict) (preferences.ts:57-80; stores.ts:95-117). Deliberate encrypted/plaintext asymmetry → NA-4 confirm. All 6 routes session-class; both PUTs `byUpsert`, DELETE `byTransition`, exempt-wrapper pairing correct; single-writer holds (slice owns custom_instructions + preferences). No export/import surfaces exist in the slice.

### 32.C GB-2 resolution — MODEL_TIER_LOCKED client copy

**Definitive: the fallen-through self-funding member sees sensible copy, not a raw code.** `MODEL_TIER_LOCKED` is mapped in **both** systems — new `friendlyErrorMessage`: "This premium model needs credits. Add funds to your balance to use it." (error-codes.ts:79,188); legacy map: "This model is only available for paid accounts…" (error-messages.ts:105-106). The live chat refusal path maps through the **new** system (`use-authenticated-chat.ts:303` via `ChatRequestError.code`), renders terminal (correctly excluded from retryable refusal codes, :292-294). The client also pre-gates: `useModelValidation` computes `canAccessPremium = purchased > 0n` and drops inaccessible premium selections; the model list shows a lock overlay ("Top up to unlock" / "Sign up to access") routing to billing/signup (use-model-validation.ts:27-58; model-list-item.tsx:20-51,389-404) — the server 403 is only the race/stale-catalog backstop. `PREMIUM_REQUIRES_BALANCE` is dead on the new backend (legacy-only emitter); its legacy-map entry is orphaned copy (NA-7). **GB-2 closed.**

### 32.D Section findings (pending verification)

| # | sev | finding |
|---|---|---|
| NA-1 | 🟠 | **No stale/unregistered FCM token pruning:** adapter never reads per-token error bodies nor calls the existing `deleteByToken` — `device_tokens` grows monotonically with dead tokens; `failureCount` recorded, never acted on (push-fcm.ts:188-211). Supersedes EM-5's "parity" framing with the concrete adapter gap. |
| NA-2 | 🟡 | No suppression/bounce/complaint gate before transactional sends — every send hits Resend unconditionally (email-resend.ts:110-145). |
| NA-3 | ⚪ | Single-send deliberately keyless (no retry, timeout-only) — caller-level retry of a transactional email can duplicate; documented in-code. |
| NA-4 | ⚪ | accessibility preferences plaintext jsonb vs E2E-encrypted custom instructions — deliberate asymmetry, founder confirm. |
| NA-5 | ⚪ | Settings-sync PUTs rely on natural convergence (upsert/LWW) — verified sound. |
| NA-6 | 🟡 | The two copy maps disagree on `MODEL_TIER_LOCKED` wording and only the legacy map knows `PREMIUM_REQUIRES_BALANCE` — the localized ENV-8/FE-4 hazard; retire the legacy map after FE-4 migration. |
| NA-7 | ⚪ | `PREMIUM_REQUIRES_BALANCE` entry in the legacy map is orphaned (no non-legacy emitter). |

**Founder questions (notifications/account):** (a) NA-1 — parse FCM per-token errors and prune via `deleteByToken`, or accept unbounded growth? (b) NA-2 — is Resend-side suppression the intended (sole) gate? (c) NA-4 — confirm plaintext accessibility prefs. (d) NA-6 — which MODEL_TIER_LOCKED wording is canonical?

## 27. Dev tooling (scripts/)

> Status: **pending hard-confirm pass.**

### 27.1 with-env + ensure-stack — clean

`loadEnvironment` loads `.dev.vars` → `.env.development` → `.env.scripts` in fixed override order; `with-env` relays the child's exit code (`reject:false` is pass-through, not a swallow) (with-env.ts:8-44). `ensureStack` is a pure function over injected deps: heartbeat-first (beats the idle-daemon teardown race) → optional wipe → generateEnv → install-if-lockfile-changed → orphan cleanup → containers healthy (`docker compose ps` health probe; any failure falls through to `compose up -d --wait` which fails loud) → migrate-if-fingerprint-changed → provision `admin_sql_panel` LOGIN (**refuses non-loopback hosts in code**, ensure-stack-cli.ts:109-126) → idle daemon (ensure-stack.ts:138-169). Ports: per-worktree `base + (djb2Hash(name) % 199 + 1)` on 18 disjoint 200-wide windows; main = slot 0 (worktree.ts:78-91). CI short-circuits before touching env/DB. **Error hygiene clean**: zero `|| true` / `2>/dev/null` in scripts source; `.catch()` sites are justified probes; the one swallow-with-log is advisory docker cleanup.

### 27.2 generate-env / verify-env

Registry-driven off `env.config.ts`; missing secrets batch-thrown at the boundary; `escapeEnvValue` **refuses** ambiguous quoting rather than corrupting a dotenv line (generate-env.ts:79-90,198-230); no `??` fallbacks anywhere. `verify-env` supports **five** modes (`development·ciVitest·e2e·ciE2E·production` — e2e is a local convenience mode excluded from VERIFIED_MODES); drift detection catches dangling registry `ref()`s (verify-env.ts:29,387-433). **`verify:env` is wired into no composite or CI step — manual-only gate** (ST/founder Q).

### 27.3 Seed system & the committed crypto cache

`db:seed` (scripts/seed.ts, run in `pnpm dev`) is a full live seed (personas/wallets/conversations + a chargeback-locked admin-target persona), guarded by `assertLocalDatabaseUrl` fail-closed (seed.ts:120-143). It warms a fingerprint-keyed OPAQUE cache at `scripts/.cache/seed-crypto/`: key = sha256(cacheVersion ∥ cryptoFingerprint ∥ sha256(masterSecret) ∥ sha256(password) ∥ credentialIdentifier); **miss regenerates identical bytes via real OPAQUE and writes a new file** (seed-crypto-pool.ts:94-148). Facts: 244 files tracked; `.gitignore:104-106` re-includes the dir; the gitignore rationale ("nothing produces new files") is **factually false** — the live seed writes on every miss; current churn = 163 M / 81 D / 82 untracked. **Pure perf cache, not correctness-critical** → ST-1.

### 27.4 Inventory & dead scripts

~45 scripts inventoried, all wired via pnpm/CI except: **`legacy_seed.ts` (2105 ln) + `legacy_seed-cache.ts` (109 ln)** — dead (self+test refs only); **`generate-og-image.ts` (+test)** — dead (no pnpm script, no workflow, not imported) (ST-5). `verify-evidence.ts:9` usage doc still references `ai-gateway` (cross-ref OR-2/CAS-2, ST-7).

### 27.5 CODE-RULES compliance

Scripts generate the env files, so raw `process.env` reads are the necessary consistent pattern; runtime *branching* routes through `createEnvUtilities().isCI` (build-web-bundle.ts:44-49) with **one** raw `process.env['CI']` bootstrap branch (ensure-stack-cli.ts:287) — justified but unannotated (ST-4). execa consistent; typing high (pure orchestrator + injected deps); no `any` observed. Stale docstrings claim "no seed phase" contra the live seed; `TRACKED_TABLES=[]` disables re-seed dirty-tracking (ST-3).

### 27.6 Section findings (pending verification)

| # | sev | finding |
|---|---|---|
| ST-1 | 🟠 | 244-file committed seed-crypto cache churns for any dev whose master-secret/fingerprint/persona-set diverges; perf-only; gitignore rationale false. Fix: gitignore the dir OR pin the dev secret + freeze corpus + error on miss-writes. |
| ST-2 | 🟡 | `scripts/.cache/local/**` tracked despite `.gitignore:108` (gitignore can't untrack) → status churn. `git rm -r --cached`. |
| ST-3 | 🟡 | Stale docstrings ("no seed phase"; "db:seed fails fast") contra the live seed; `TRACKED_TABLES=[]` disables dirty-tracking — decide model. |
| ST-4 | ⚪ | Lone raw `process.env['CI']` bootstrap branch unannotated as a rule carve-out (ensure-stack-cli.ts:287). |
| ST-5 | 🟡 | Dead scripts shipped: legacy_seed.ts (2105), legacy_seed-cache.ts (109), generate-og-image.ts (+test). Delete. |
| ST-6 | ⚪ | Worktree slot hash has no collision detection — two names can silently share ports/compose project (worktree.ts:78-89). |
| ST-7 | ⚪ | verify-evidence usage doc references ai-gateway (cross-ref OR-2/CAS-2). |

**Founder questions (scripts):** (a) ST-1 — gitignore the seed-crypto cache, or pin+freeze? (b) ST-3 — restore TRACKED_TABLES dirty-tracking or keep idempotent-mint-always? (c) verify:env manual-only, or add to CI/pre-push? (d) ST-6 — fail-fast on worktree slot collision?

## 30. packages/db internals

> Status: **pending hard-confirm pass.**

### 30.1 Client construction

**One driver path only**: `Pool` from `@neondatabase/serverless` + `drizzle-orm/neon-serverless`, runtime-agnostic via global WebSocket (no node-postgres branch, no `ws` import) — same code in node-vitest, Worker, DOs (client.ts:1-11,86-107). `new Pool({max:1})` per `createRequestDb()` call; **no module-level singletons by design** (factories.ts:6-17). Local dev passes `LOCAL_NEON_DEV_CONFIG` (insecure ws → neon-proxy, client.ts:20-26); production never touches the mutated `neonConfig` globals (DBI-2 ⚪). Dev-only `injectLatencyMs` knob patches `PoolClient.query` to surface lock-hold growth (client.ts:44-84). **Isolation: pg-default READ COMMITTED, no 40001 retry anywhere** — settlement concurrency rests wholly on explicit `FOR UPDATE [NOWAIT]` locks + the deferred trigger (grep clean; founder Q-DBI-A). Pool never explicitly `.end()`ed on the hot path — relies on isolate teardown (DBI-1 🟡).

### 30.2 SettlementTx brand — unforgeable

Brand lives in apps/api (`brands.ts:21-37`): phantom `unique symbol` on `DbTransaction` (itself derived from `Database['transaction']` params — never duplicated); sole minter `brandSettlementTx` inside `runSettlement` (settlement.ts:13). **Dual lint closure**: `no-idempotency-brand-cast` bans `as SettlementTx` incl. `as unknown as` laundering (allowed only in brands.ts); `no-brand-import` confines the constructor import. Residual: a callback can stash the `tx` handle past close — inert under drizzle/pg, footgun not money bug (DBI-4 🟡).

### 30.3 Migrations

58 SQL files, journal contiguous and matching. Hand-written SQL (0005, 0037-0043) includes the 0039 zero-sum `CONSTRAINT TRIGGER` with `SET search_path = pg_catalog, public` pin ✅. CI drift gate = `db:generate` + `git diff --exit-code drizzle/` (ci.yml:63-66). **DBI-5 🟠: the drift gate protects only what drizzle-kit models — triggers/functions are invisible to it; editing or deleting the zero-sum trigger produces zero diff and passes CI** (its existence is asserted only by integration tests). Hand SQL is non-idempotent (bare CREATE, journal-safe only) and CI never runs `db:migrate` against a fresh DB (DBI-6 🟡).

### 30.4 Workerd validation — what it proves

`DbTxnRunnerDO` + platform-free `runLockValidation`: asserts read-your-writes-inside-tx, uncommitted-invisible, **`55P03` from `FOR UPDATE NOWAIT` through the real Neon driver under workerd**, post-commit visibility, relockability (txn-executor.ts:55-131; do-finalize.workers.test.ts:14-26). **DBI-7 🔴 (= JD-1): it's a generic lock-shaped scratch-table tx — never `runSettlement`/`chargeWithinTx`/the trigger.** And it runs against the local neon-proxy, not managed Neon (DBI-8 ⚪).

### 30.5 Exports, uuidv7, type safety

Barrel exports schema/client/evidence only — **query operators deliberately withheld** (index.ts:13-21); zero deep imports repo-wide; `legacy_*` factories exist but are not barrel-exported; `./schema` subpath is declared but unused (open door, DBI-9 ⚪). uuidv7: native PG18 default on every PK — **except `users.id`, minted app-side as v4 `crypto.randomUUID()` at OPAQUE `registerInit` (identity fixed pre-insert), forfeiting v7 time-ordering on the users table** (registration.ts:118-124; DBI-10 🟠); all other v4 sites are ephemeral non-PK values (DBI-11 ⚪). Injection surface closed: the single `sql.raw` is regex-gated to `[a-z][a-z0-9_]*` scratch-table names; all money columns uniformly `bigint mode:'bigint'`; factories cast-free off `$inferInsert`.

### 30.6 Section findings (pending verification)

| # | sev | finding |
|---|---|---|
| DBI-7 | 🔴 | workerd DO test proves a generic lock tx, not real `settle()` — restates JD-1 from the db side. |
| DBI-5 | 🟠 | Drift gate blind to hand-written trigger/function SQL — the zero-sum trigger can regress with zero CI diff. |
| DBI-10 | 🟠 | `users.id` is app-side v4 (OPAQUE pre-insert identity), overriding the schema's uuidv7 default. |
| DBI-1 | 🟡 | Per-request Pool never `.end()`ed on the hot path (isolate-teardown reliance). |
| DBI-4 | 🟡 | SettlementTx capturable past tx close (liveness footgun, not forgery). |
| DBI-6 | 🟡 | Hand SQL non-idempotent; CI never proves migrations apply to a fresh DB. |
| DBI-2/3/8/9/11 | ⚪ | dev-only neonConfig global mutation; latency knob; workerd test on local proxy; open ./schema subpath; ephemeral v4 sites. |

**Founder questions (db):** (a) Q-DBI-A — confirm READ COMMITTED + explicit-locks-no-retry is the intended settlement concurrency model. (b) Q-DBI-B — add a trigger/function golden-dump diff (or drift-job assertion) so the money trigger can't silently regress? (c) Q-DBI-C — accept v4 user ids, or mint v7 app-side and feed it to OPAQUE? (d) Q-DBI-D — run real settlement under vitest-pool-workers (managed Neon) per JD-1.

## 33. Demo surface & capture tooling

> Status: **pending hard-confirm pass.**

### 33.1 The /demo surface

`/demo` is the **real apps/web SPA booted in demo mode** — `main.tsx:33-35` gates on `isDemoPath` and lazy-imports `./demo/bootstrap` (no demo code in the main chunk); mounted on the real route tree under a **memory-history** router so the iframe URL stays `/demo` (bootstrap.tsx:20-25,90-101). Marketing `/welcome` embeds it as a lazy same-origin iframe revealed on `hb-demo-ready` postMessage (AppDemo.astro:81-140). **Production-reachable** (dedicated CSP blocks, generate-headers.ts:329-333). **Data fully mocked in-browser**: a global fetch shim answers every app API prefix from an in-memory `DemoBackendStore`; the only real-network egress is public `GET /models` + static assets (fetch-shim.ts:1-11,49-83).

### 33.2 CSP frame relaxation — verified sound

`buildDemoHeaders` relaxes exactly two directives to same-origin (`frame-ancestors 'self'`, XFO SAMEORIGIN) because the SPA-wide `frame-ancestors 'none'` would block the same-origin `/welcome` iframe; everything else inherited; cross-origin framing stays denied (generate-headers.ts:153-177,325-333).

### 33.3 Determinism & env discipline — clean

Seeded runtime keypair + fake session (no OPAQUE, no stored auth — seed-session.ts:21-35); fixtures sealed with the **real @hushbox/crypto envelope** (full AAD tuple) so the unmodified client decrypt path runs verbatim (crypto-encoder.ts:1-28,114-142); scripted director blocks trusted human input; capture-phase guardrails nudge unsupported controls to signup; frozen mode (`?frozen=1&convo=…`) bounded to fixtures (unknown convo → early return). **Env discipline clean**: zero env access in `apps/web/src/demo/` (grep); demo-mode is a runtime path gate, not a build flag. **Cannot leak into prod by data flow** — the gated dynamic import is the only entry (repo-wide grep: no static `demo/*` import outside the dir) — but no lint rule pins this (DM-6).

### 33.4 hq-tour capture & Remotion status

Lives in the `@hushbox/ads` workspace (Remotion + Playwright studio). Capture drives the frozen `/demo` through scripted beats, records phone-shaped 9:16 video via a CDP `Page.captureScreenshot` 30fps loop + ffmpeg VP8, and emits a ground-truth action log powering the Remotion cursor/zoom overlay (capture.ts:1-24,96-161; phone-capture.ts:82-179). Trusted Playwright input works because frozen mode installs no director/input-block. **Manual-only — zero CI references** (grep clean); pure helpers unit-tested at a 95% perFile gate, driver/ffmpeg/Remotion tsx deliberately excluded and documented (ads/vitest.config.ts:4-64). Remotion: shared studio **built** (`Root.tsx` + campaigns; full tools/remotion component set); master export committed via LFS (~21 MB); **`07-project/` is empty** — PRODUCTION-GUIDE.md:335-338 + create-ad SKILL.md:410-413 still instruct scaffolding there (doc drift, DM-5).

### 33.5 Other asset tooling

OG image (canvas render, committed + hash sidecar); social banners (rendered from the real `/welcome` frozen demo via dev-only `/dev/render-asset` route); README GIF/SVG generators with committed content-addressed `.cache/*.hash` sidecars — the cache design is sane (null-delimited, output-existence-gated, `HB_FORCE_REGENERATE` override; cache.ts:13-82). **No CI job runs any generator or drift-checks the committed assets** (DM-3).

### 33.6 Risk check

No embedded credentials (runtime keypair; the one `no-secrets` disable is base64 media bytes). The auth bypass (`seedDemoSession`) + fetch shim load only inside the `/demo` dynamic import; mock backend serves fixtures only, never mutates a real backend.

### 33.7 Section findings (pending verification)

| # | sev | finding |
|---|---|---|
| DM-3 | 🟠 | Committed generated assets (og-image, social banners, readme GIF/SVGs) are never verified in CI — silent drift from source tokens/copy possible; `.cache` hashes gate only local regen. |
| DM-4 | 🟡 | Two stray Playwright-MCP screencast `page@*.webm` files committed via LFS in 03-screen-capture/. |
| DM-5 | 🟡 | Remotion layout doc drift: `07-project/` empty; guide + create-ad skill still instruct per-ad scaffolding there while the shared `ads/` studio is canonical. |
| DM-6 | 🟡 | No lint/arch rule pins demo-bundle isolation — a future static import of `seed-session`/`fetch-shim` would pull the auth-bypass + global fetch patch into the prod main chunk. |
| DM-1/2/7 | ⚪ | Demo architecture sound (fixture-only, real crypto, minimal same-origin frame relaxation); capture studio manual-by-design with tested pure helpers. |

**Founder questions (demo):** (a) standalone `hushbox.ai/demo` direct visits intended, or redirect to `/welcome`? (b) live `GET /models` passthrough from the demo iframe accepted, or freeze a fixture catalog? (c) add CI drift check for committed generated assets? (d) delete the stray `page@*.webm` debris + guard? (e) `07-project/` — delete and fix the docs, or scaffold per-ad? (f) add the demo-isolation import ban?

## 31. Client crypto consumption (apps/web)

> Status: **pending hard-confirm pass.**

**Scope:** how apps/web *consumes* `@hushbox/crypto` (packages/crypto internals are §3/§4). Key finding cluster: the account private key is memory-only and zeroed on logout, but the KEK that unwraps it is persisted, and several module-level plaintext/key caches survive SPA logout.

### 31.1 Browser key lifecycle

| Material | Home | Persistence | Cleared by |
|---|---|---|---|
| Account private key | Zustand `useAuthStore.privateKey` | RAM only (no persist middleware) | `clear()` → `privateKey.fill(0)` on logout (auth.ts:97-127) |
| OPAQUE export key (KEK) | localStorage (keepSignedIn) or sessionStorage | localStorage survives browser close | `clearStoredAuth()` (auth-client.ts:53-64,114-117) |
| Epoch private keys | module `Map` epoch-key-cache | RAM only | `clearEpochKeyCache()` zeros then clears |
| Decrypted message plaintext | module `Map decryptedCache` | RAM only | `clearDecryptedMessageCache()` — **never wired to logout** (CC-7) |
| Decrypted media Blob | Blob behind object URL in Query cache | RAM, `gcTime` | `installBlobUrlCacheGc` revokes on cache removal |
| Link-guest private key | `useMemo` in share route | RAM only | never zeroed (CC-9) |

**Restore-on-refresh:** the persisted KEK + an authenticated `/me` re-derive the private key via `unwrapAccountKeyWithPassword` (auth-client.ts:134-183). The private key is never persisted, **but the KEK that unwraps it is** — a documented "stay signed in" tradeoff, fail-closed on definitive 401/403 (CC-1).

### 31.2 Findings (pending verification)

| # | sev | finding |
|---|---|---|
| CC-1 | 🟠 | Persisted KEK reconstructs the account private key given a same-origin `/me` — the one persistence that softens zero-knowledge (documented "keep me signed in" tradeoff). Founder Q. |
| CC-2 | 🟠 | `KeyChainResponse` redeclared client-side vs two hand-written server serializers, no compile-time link (FE-1 cluster); fail-closed at runtime (drift → `[decryption failed]`, never plaintext corruption); dead `visibleFromEpoch` client field. |
| CC-7 | 🟠 | `decryptedCache` (all viewed message plaintext) **not cleared on logout** — survives SPA sign-out until tab reload. Fix: call `clearDecryptedMessageCache()` from `clearLocalAuthState`. |
| CC-9 | 🟠 | Link-guest derived private key never zeroed; epoch cache + decryptedCache retain guest keys/plaintext after leaving the share page. |
| CC-3 | 🟡 | Message bodies sent as **plaintext** to the server for inference (by design — server seals to epoch pubkey); confirm the trust boundary. |
| CC-4 | 🟡 | Media decrypt materializes full ciphertext in memory with no client size guard before fetch/decrypt; chunked/streaming crypto path unused in web. |
| CC-5 | 🟡 | Recovery-phrase 3-word verification is client-only UX; server ack set by `recovery.save`, not proof of retention. |
| CC-8 | 🟡 | 5 `console.error(err)` sites on the streaming turn path may transitively log request context. |
| CC-6 | ⚪ | All crypto on the main thread (no worker offload; also no lingering transferable key copies). |

**Verified clean:** private key never persisted (only the KEK is); logout zeros the private key + epoch cache + document content + `queryClient.clear()`; no Query persister; Zustand stores exclude decrypted content; decompression-bomb cap honored transparently from packages/crypto; only a public key crosses the wire for link guests. **Founder questions:** CC-1 (hardware-bound KEK?), CC-3 (confirm plaintext-for-inference boundary), CC-7/CC-9 (hard-reload on logout/guest-exit?), CC-2 (lift KeyChain contract into AppType?).

## 34. Adversarial hard-confirm pass (§ money/security criticals)

Independent verifiers re-read the cited code attempting to **refute** each load-bearing claim. Verdicts:

| Claim | Verdict | Note |
|---|---|---|
| Zero Redis/external calls inside the settlement tx | **CONFIRMED** | Full call-graph re-walk; membership resolution uses DB stores not the Redis cache; snapshot write-through is post-commit; admin op bodies lint-banned from external calls |
| Lock order content→wallet→budget→conversations→key-row, always | **CONFIRMED** | No alternate path co-acquires a wallet lock with a conversation/content lock — no deadlock cycle vs settle() |
| Idempotency key-row fence → zombie writes flip 0 rows | **CONFIRMED** | `reclaim` CAS on `claims` + `fenceCondition` on every terminal/heartbeat write; either interleaving yields exactly one committed settlement |
| Admission Lua atomic; N racers can't jointly over-admit | **CONFIRMED** | Redis single-threaded serialization; free wallets use the same script (only the balance leg skipped); trial path is a separate non-atomic mechanism (holds no wallet; bounded overshoot — Q1) |
| Cost-circuit trip settles nothing | **CONFIRMED** | `finalizeFailed` never calls settle(); precedence stop>deadline>circuit means a deadline coincident with over-accrual settles the bounded partial — the trip *outcome* itself bills nothing |
| Owner-funded rules (purchased-only, absent row=0 cap, tier-gate exempt) | **CONFIRMED** | `resolvePayerWallet` private to turn-context, single call site; media tier-gate exemption is a premium-text UX lock, not a spend gate (spend bounded by the free allowance budget scope) |
| **charge amount == content_items mirror "by construction"** | **WEAKENED** | Equal **given per-run charge-key uniqueness**. A `modelCall` inside a `loop` with no chargeKey override mints duplicate keys → ledger debits once (idempotent) while the display path SUMS duplicates → gross drift. **Not reachable in the current product** (no chat turn definition uses a `loop` node; all keys unique), but the guarantee is narrower than "cannot drift by construction." → downgrades WF-7/FEE from "structural" to "structural for the current turn-definition set." |
| SE-1 (no lint confines @sentry imports) | **CONFIRMED** | No `no-restricted-imports` entry, no `no-external-sentry` rule, `@sentry` absent from the boundaries INFRA_MODULES allowlist; only convention keeps it in the adapter |
| JD-1 (real settle() never in a DO under workerd) | **CONFIRMED** | All 3 `.workers.test.ts` use fakes/no-op settlement or a lock-shaped scratch tx; real `runSettlement` exercised only by node tests |
| SEC-1 (no Origin check on WS upgrade) | **CONFIRMED** | GET upgrade structurally CSRF-exempt; `sameSite:'none'` in prod; only membership + broadcast-liveness mitigate |
| Global csrfProtection + 2 exemptions safe | **CONFIRMED** | Webhook HMAC-verified fail-closed; token-login is a 122-bit single-use possession credential |
| Rate limiter admits exactly maxAttempts under concurrency | **CONFIRMED** | Atomic INCR-before-verify; EXPIRE-NX anchors the window; no over-admit under any interleaving |
| OPAQUE config parity + challenge-state race fixed | **CONFIRMED** | Same OPAQUE_MASTER_SECRET both sides; all handshake state consumed via atomic `redisGetDel` |

**Net:** every load-bearing money/security claim survives adversarial review except the FEE/WF-7 "by construction" equality, which is downgraded to "holds for the current closed set of chat turn definitions" (a `loop`-node turn could violate it — a latent constraint worth an invariant test if `loop` is ever used in a billable definition).
