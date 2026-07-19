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

**Structural themes across the 🟠 tier:** (1) *enforcement gaps in otherwise-strong walls* — admin reversibility battery not mandated (AD-1/2), idempotency rule blind to non-exempt handlers (WF-3), pre-push cache masking (CI-2), watcher-less metrics (SE-2); (2) *the frontend's manual type bridge* — RPC response inference is vacuous on all 119 handlers, compensated by 69 hand-written casts (FE-1), plus auth-path fetch bypasses (FE-2) and no centralized 401 handling (FE-3); (3) *cutover debris* — Vercel-gateway env still shipped (OR-2), dual error-copy systems (ENV-8/FE-4), dual privilege-enum homes (DUP-1), `legacy*`-named live exports (LEG-1); (4) *new-surface hardening* — WS-upgrade Origin check (SEC-1/Q4), admin SPA headers (SEC-2), Overlay/Sheet overflow (UI-1/2), store deep-link placeholders (MK-1).

16 decisions need the founder (§25); every other finding carries a concrete recommended fix. Full ranked list: §24. Actionable work: the backlog below.

## The task list lives in §38

**There is one source of truth for all remediation work: the implementation register in [§38](#38-remediation-plan--the-implementation-register).** Its **§38.0 Board** lists every task (F-01 … F-70) with status, priority, and area; each has a detailed card in §38.1–38.7. Work the board there — this document has no other task list. *(An earlier draft duplicated a partial backlog here; it has been folded into §38 so nothing is split.)*

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
25. [Founder rulings — 2026-07-18](#25-founder-rulings--2026-07-18)
26. [Deploy pipeline & release flow](#26-deploy-pipeline--release-flow)
27. [Dev tooling (scripts/)](#27-dev-tooling-scripts)
28. [Realtime room-core (ConversationRoom DO)](#28-realtime-room-core-conversationroom-do)
29. [Admin SPA application code](#29-admin-spa-application-code)
30. [packages/db internals](#30-packagesdb-internals)
31. [Client crypto consumption (apps/web)](#31-client-crypto-consumption-appsweb)
32. [Notifications & account slices; GB-2 client copy](#32-notifications--account-slices-gb-2-client-copy)
33. [Demo surface & capture tooling](#33-demo-surface--capture-tooling)
34. [Adversarial hard-confirm pass (money/security criticals)](#34-adversarial-hard-confirm-pass--moneysecurity-criticals)
35. [Design: billing decision dedup (functional core)](#35-design-billing-decision-dedup-via-functional-core--imperative-shell-ruling-q17--gb-1)

> **Doc status (2026-07-18):** §1–§25 are the complete legacy→new audit with founder rulings recorded (§25). §26–§33 are the deep-exploration wave (frontend/infra/realtime/admin/db/crypto/demo); their findings are Verified but **not yet adversarially re-verified** — only the money/security criticals were (§34). §35 is the approved billing-dedup design.

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
| SE-2 | 🟠→**RULED (Q10): tear down WAE** — see §25. All 4 metrics removed; alerting collapses to Sentry + Workers Logs. Original finding retained below for context. Confirmed: all 4 shipped WAE metrics are watcher-less — written, never read back. `realtime_ws_upgrade_failure` (realtime-room-bindings.ts:128) + `realtime_billable_generation` (:131): the WAE auditor is explicitly deferred until an Analytics Engine SQL client exists (scheduled.ts:46-49). `jobs_queue_depth` (jobs-health-entry.ts:67): its comment claims an ops dashboard watches it, but no dashboard code queries WAE — the actual stuck-work signal is the separate Sentry page (jobs-health-entry.ts:~80). `jobs_oldest_pending_age_seconds` (:69 — the emitted name carries `_seconds`): same, no reader. `realtime_ws_upgrade_failure` has NO alternative alarm — doctrine says every metric has a named watcher or doesn't ship (that rule is deleted with WAE — see §25 Q10). Verified. |
| SE-3 | 🟠→**partly superseded (Q10)**: with WAE gone the fix is not "route to WAE" but **stop paging Sentry for these expected conditions** — downgrade to a structured Workers-Log line (or a daily digest), never the defect channel (refresh.ts:109/120/131/154). Verified. |
| SE-4 | 🟠 | `no-silent-catch` accepts any handling — a genuine defect can be downgraded to `err()` and pass lint; nothing forces captureError for defects. No violations today, but unenforced. Verified. |
| SE-5 | ⚪→**MOOT (Q10)**: WAE torn down, so there are no metrics to register or watch. The "every metric names its watcher" rule is deleted with WAE. Verified. |
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
| CI-1 | 🟡→**CORRECTED** | **Prettier IS enforced** — via `eslint-plugin-prettier/recommended` in the shared ESLint config (`packages/config/eslint.config.js:7,713,726`), so `pnpm lint` (CI lint gate + pre-push ESLint) fails on JS/TS/TSX formatting. The original "enforced nowhere" claim was WRONG. The real defect is only that `docs/DEVELOPMENT.md:43` falsely says pre-commit runs Prettier (the pre-commit hook runs codegen only); `.astro` may also be uncovered (UI-4). Verified. |
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

Coverage gaps (E2E-2 corrected 2026-07-19): 2FA login/setup/disable ✅ (auth-2fa.spec.ts), recovery-phrase→forgot-password ✅ (auth-recovery.spec.ts), 2FA-gated deletion ✅ — only the "use recovery code instead" 2FA fallback (two-factor-input.tsx:76) is a possible gap ⚠️. Other originally-listed items (media upload, marketing render, Capacitor shell, ledger detail, a11y toggles) are dropped per founder ruling.

| # | sev | finding |
|---|---|---|
| E2E-1 | 🟠 | Harness-bypassing specs (demo, marketing-leaderboard, marketing-roadmap, ui/personas, api/health) import `test` from raw `@playwright/test` → no console/API-error auto-fail, no network allowlist; demo runs the whole app shell so a live third-party leak/console error passes silently. Route through fixtures.js + add a lint rule banning raw `@playwright/test` import in specs. Verified. |
| E2E-2 | 🟠→**CORRECTED** | **Overstated — 2FA IS e2e-covered.** `auth-2fa.spec.ts` tests login (valid/invalid code), setup, and disable lifecycles; `auth-recovery.spec.ts` covers recovery-phrase→forgot-password; `account-deletion.spec.ts` covers 2FA-gated deletion. Only the "use recovery code instead" fallback (two-factor-input.tsx:76) may lack a test. The other holes are dropped per ruling 2026-07-19. Verified. |
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
| WF-1 | 🟠→**RULED (Q9): keep no-bill; emit a Sentry `captureMessage` per trip** (runId + accrued-unbilled), document the posture + the deadline-vs-trip asymmetry in ARCHITECTURE §Money. Not a WAE metric (WAE torn down, Q10). Original finding: a trip settles nothing while a deadline settles the billable partial (interpreter.ts:486,579,1000-1016). Verified. |
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
| | Gaps | pre-push turbo cache can mask the test gate (CI-2) — 🟠. (CI-1 corrected: Prettier IS enforced via ESLint; only a stale DEVELOPMENT.md pre-commit claim remains.) |
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
| SE-2 | 🟠→ruled | **Tear down WAE** (Q10) — Sentry + Workers Logs only | ruled |
| SE-3 | 🟠 | Expected catalog conditions ride the Sentry defect channel hourly — with WAE gone, downgrade to Workers-Log/digest (not WAE) | open (per Q10) |
| SE-4 | 🟠 | no-silent-catch can't force captureError for defects | open |
| SE-5 | ⚪ moot | WAE torn down (Q10) — no metrics to register/watch | resolved |
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
| CI-1 | 🟡 corrected | Prettier IS enforced via `eslint-plugin-prettier` (CI lint + pre-push); only the DEVELOPMENT.md pre-commit claim is false | open (doc fix) |
| CI-2 | ⚪ accepted | Pre-push turbo cache can mask the coverage/test gate — **founder ruled no fix (F-47 deleted); CI is the protected gate** | won't-fix |
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
| E2E-2 | 🟡 corrected | 2FA IS covered (auth-2fa.spec.ts); other holes dropped per ruling; only the recovery-code fallback is a possible narrow gap | deferred |
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
| WF-1 | 🟠→ruled | Keep no-bill + Sentry event per trip + document (Q9) | ruled |
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

## 25. Founder rulings — 2026-07-18

All questions below were settled by the founder on 2026-07-18. Two audit premises were **wrong** and were corrected during a hard-confirm pass (Q1 trial-quota, Q5 payment-decline granularity — see their rows). Everything here is a decision to implement; no code has been changed yet. Q7/Q8 were closed as verified-parity earlier.

| # | Topic | Ruling | Action to implement |
|---|---|---|---|
| 1 | Trial abuse limits | **No feature change.** Hard-confirm CORRECTED the premise: the 5/day dual-identity quota (trial-quota.ts:68) + 20/60s burst (rate-limit.ts:23) + $50/day pool are **all live**; nothing was dropped. | Remove **only** the 20/60s per-IP burst (`consumeTrialBurst`, TRIAL_BURST_RATE_LIMIT) — it is already redundant under the 5/day per-IP cap. Keep everything else as-is. |
| 2 | Keyed epoch confirmation | **Wire in the keyed version.** Cheapest now (zero users ⇒ no stored `confirmationHash` to migrate). | Switch `epoch-lifecycle.ts:38,54` from bare `sha256Hash(privateKey)` to `computeEpochConfirmation(...)` (epoch.ts:32); update `verifyEpochConfirmation` sites + the client `verifyEpochKeyConfirmation`; delete the bare path. TDD. |
| 3 | Delete-account lockout | **Restore legacy's split window.** | Replace the single 3-in-24h `deleteAccountLockout` (keys.ts:217) with a tight 3/1h attempt window + a separate 24h lock (legacy's two-key shape). |
| 4 | WS CSWSH | **Add the Origin check.** (Surface adversarially confirmed real.) | Allowlist-Origin check on the WS upgrade handler mirroring `csrfProtection`'s origin set + a test. |
| 5 | Error-code granularity | **Restore — 3 targeted items** (counts corrected to 128→81; payment-decline granularity NEVER existed in legacy, so it is net-new). | (1) Wire the media-modality errors (`UNSUPPORTED_MODALITY` already defined at error-codes.ts:31, zero emit sites; + resolution/duration/config). (2) Re-classify streaming failures to emit `CONTENT_POLICY`/`CONTEXT_LENGTH_EXCEEDED`/`NETWORK_ERROR` (copy exists, only STREAM_ERROR/CHAT_STREAM_FAILED minted). (3) Build a structured payment `declineReason` enum from the captured Helcim signal (payment-helcim.ts:104-115). Keep payment-lifecycle/storage/not-found flattened. |
| 6 | Cassette version | **Bump to v2.** Note: recording is **out-of-band** and CI **fails on cassette miss** (never auto-charges) — that behavior is already correct in code; the bump just needs a deliberate re-record. | Bump `AI_RECORDING_VERSION` (cassette-store.ts:33) to `v2`; re-record out-of-band; commit the v2 cassettes. |
| 9 | Cost-circuit billing | **Keep no-bill; route the trip signal to Sentry** (not a WAE metric). A trip = estimate exceeded 5× = exceptional, worth a human glance. | On a cost-circuit trip, emit one Sentry `captureMessage` with runId + accrued-unbilled nano-USD (aggregate absorbed loss from the events). Document the no-bill posture (and the deadline-vs-trip asymmetry) in ARCHITECTURE §Money. |
| 10 | WAE watcher / observability | **Tear down WAE entirely.** WAE is one adapter behind the single telemetry port (port.ts) with only 4 `emitMetric` sites. Collapse alerting to Sentry + structured Workers Logs. | Remove the WAE adapter (`wae-adapter.ts`) + all 4 `emitMetric` calls: `jobs_queue_depth`/`jobs_oldest_pending_age_seconds` (already redundant with the Sentry `captureError('jobs stuck…')` at jobs-health-entry.ts:79); `realtime_ws_upgrade_failure` + `realtime_billable_generation` (analytics/strategic, not defects). Update ARCHITECTURE §Observability + TECH-STACK (drop WAE row) **as part of that change**. Re-entry: add PostHog or WAE+SQL-watcher when aggregate/business measurement is needed. Consciously accepted: `realtime_ws_upgrade_failure` (the fallback-transport re-entry signal) becomes instrument-on-demand. Supersedes SE-2/SE-3/SE-5 and backlog item 9. |
| 11 | Password-reset email subject | **Distinct reset subject.** | Add a reset-specific subject/template; wire the recovery-reset finish path to it (not the shared password-changed port). |
| 12 | Invert-colors scaffolding | **Delete it.** | Remove `data-no-invert` emission from `Img`/`Logo` + the invert docstrings. Preserve any genuine `decorative` screen-reader semantics (aria-hidden) — remove only the dead invert plumbing. |
| 13 | Admin a11y panel | **Accept** (internal tool). | None. (Separate cheap gap available on request: admin `<main>` skip link, UI-7.) |
| 14 | Store deep-link files | **Substitute at deploy + CI guard.** | Template AASA/assetlinks; substitute real Apple Team ID + Android release SHA-256 from secrets at deploy; fail the prod deploy if `TEAMID`/`PLACEHOLDER_SHA256_FINGERPRINT` remain. **Needs founder input:** the real Team ID + signing fingerprint. |
| 15 | Android WebView debugging | **Gate to dev.** | Make `webContentsDebuggingEnabled` false for release builds (capacitor.config.ts:14). |
| 16 | Overlay hardening | **Push into the primitives.** | Add the Dialog `max-h`/`overflow-y-auto` guarantee to `SheetContent` + `OverlayDialog`/`OverlayContent` + tests. |
| 17 | Billing logic dual-home | **Functional core / imperative shell** (design in §35). | Extract the pure funding+premium decision into a `packages/shared` function over primitive inputs; chat slice + client both call it; retire the fat `resolveBilling`; add the §2.K funding-matrix contract test. Full design: §35. |
| 18 | Owner-funded premium rule | **Ignore** (verified equivalent to legacy by construction). | None. |
| 19 | Default member cap | **Ignore** (verified: self-fund matches legacy). | None. |

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
| DP-4 | 🟡→accepted | **Version gate is strict equality, no floor** — every deploy hard-426s all prior-version clients (no grace band). **Ruled (QD-2): keep exact-match; no floor added.** |
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

## 35. Design: billing decision dedup via functional core / imperative shell (ruling Q17 / GB-1)

**Problem restated.** `packages/shared/resolve-billing.ts` documents itself as "the one function both frontend and backend call," but the new server never calls it — the chat slice re-implements the two billing decisions natively:
- **who-pays** in `resolvePayerWallet` (`chat/domain/turn-context.ts:311-360`): solo → self; non-solo → owner-funded if `groupEffectiveRemainingNanoUsd > 0`, else self-fund (signed-in) or refuse (guest).
- **premium gating** in `tierGateRejection` (`chat/routes.ts:483-505`): `directBilling = payer wallet is the caller's own`; `canAccessPremium = own purchased > 0`; owner-funded turns exempt.

The client (and legacy) still route through shared `resolveBilling`. So the *decision logic* exists twice, with no compile-time link keeping the two in sync (GB-1). The founder's constraint: **do not duplicate logic, and do not fight the slice architecture.**

**The pattern: functional core, imperative shell.** Split each decision into a pure core (moves to `packages/shared`) and an I/O shell (stays in the slice / client).

### 35.1 The pure core — `packages/shared`

One pure function over **primitive inputs only** — no DB, no Drizzle, no Zod-object fetching, no I/O:

```ts
// packages/shared/src/billing/funding-decision.ts  (illustrative shape)
export interface FundingInputs {
  readonly isSolo: boolean;
  readonly isGuest: boolean;
  readonly memberRemainingNanoUsd: bigint;      // absent member_budgets row ⇒ 0n
  readonly conversationRemainingNanoUsd: bigint;
  readonly ownerPurchasedBalanceNanoUsd: bigint;
  readonly callerOwnPurchasedBalanceNanoUsd: bigint;
  readonly isPremiumModel: boolean;
}
export type FundingDecision =
  | { payer: 'self';  walletKind: 'purchased' | 'free'; premiumAllowed: boolean }
  | { payer: 'owner'; walletKind: 'purchased';           premiumAllowed: true }
  | { payer: 'refuse'; refusalCode: 'GROUP_BUDGET_EXHAUSTED' | 'MODEL_TIER_LOCKED' };

export function resolveFundingDecision(i: FundingInputs): FundingDecision { /* pure */ }
```

The core encodes exactly the branching that lives inline today: the `groupEffectiveRemainingNanoUsd` min (already a shared pure helper — the proof the pattern works), the purchased-then-free selection, the owner-funded exemption, and the `canAccessPremium = own purchased > 0` gate. It returns a decision; it performs no reads and no writes.

### 35.2 The imperative shells — unchanged responsibilities

- **Chat slice (server).** `resolvePayerWallet` keeps every DB read — it resolves the member/conversation/owner balances from Postgres (its job; it owns the tables and the `SettlementTx`), packs them into `FundingInputs`, calls `resolveFundingDecision`, and acts on the result (freeze `walletId`, gate the tier, refuse). No client code is imported; the slice imports a *pure domain function from the shared contract layer*, which is what that layer is for.
- **Client.** `use-prompt-budget` resolves the same primitives from the budgets endpoint + `/models` `premiumIds`, calls the **same** `resolveFundingDecision`, and renders the lock/pay state from it.

### 35.3 Why this honors the architecture (not a workaround)

1. **`packages/shared` is the designated home** for "Zod schemas, types, constants, contracts" — pure cross-cutting logic shared frontend/backend. A pure decision function *is* a contract; the server importing it imports a shared rule, not a client concern.
2. **The slice keeps everything that makes it a slice** — single-writer, all data access, the `SettlementTx`. Only arithmetic/branching leaves; the slice boundary (I/O) is untouched, and the server opens no second connection and calls no client code.
3. **The pattern already ships here.** `groupEffectiveRemainingNanoUsd` (billing/domain/group-budget.ts) is a pure function used by both server and client today. §35 extends that proven split to the rest of the decision that currently sits inline.
4. **Retire the fat `resolveBilling`.** It is the legacy-shaped function that mixes concerns; both sides converge on the thin pure core and the client stops carrying its own decision path.

### 35.4 The contract test — the real prize

Add a table-driven test feeding the §2.K funding-scenario matrix (owner solo · member within budget · member over budget · no-budget-row · link-guest ± headroom · trial · free-allowance) through **both** the server's input-resolution and the client's, asserting each produces the identical `FundingDecision`. This turns future client↔server drift into a **compile-or-test failure** instead of the current silent divergence — closing GB-1 permanently.

### 35.5 Migration steps

1. Extract `resolveFundingDecision` (+ `FundingInputs`/`FundingDecision`) into `packages/shared`, TDD from the §2.K matrix.
2. Rewrite `resolvePayerWallet` + `tierGateRejection` shells to resolve primitives → call the core (behavior-preserving; existing tests stay green).
3. Rewrite the client `use-prompt-budget`/`use-resolve-billing` path to call the core; delete the fat `resolveBilling`.
4. Add the cross-side contract test (§35.4).
5. Confirm no behavior change via the existing billing integration + e2e suites.

## 36. Hard-confirm verdicts — §26–33 (adversarial pass)

Every deep-exploration finding re-verified by an independent agent instructed to **refute** it against fresh file:line reads (the same pass that caught RL-1 and ENV-9). Verdicts: CONFIRMED (survived) · WEAKENED (narrower than stated) · REFUTED (wrong). New founder questions per section feed §25's successor list.

### 36.1 §26 Deploy — all CONFIRMED

| ID | Verdict | Evidence |
|---|---|---|
| DP-1 | CONFIRMED | `APP_VERSION` secret put ci.yml:758 (live vs old worker immediately), API redeploy :825, R2 bundle upload :874-876, checksum mint :885 — checksum is NOT version-keyed (fixed `APP_BUNDLE_CHECKSUM_${PLATFORM_KEY}`), so `/updates/current` (routes.ts:104-112) advertises `{version:NEW, checksum:OLD}` in the gap; `/updates/download/.../NEW` 404s until :876. |
| DP-2 | CONFIRMED | `grep -i rollback ci.yml` → 0; linear deploy sequence :743-895, no `if: failure()` compensation. |
| DP-3 | CONFIRMED | `db:migrate` :820-821 runs before API redeploy :825; whole pending set applied; nothing gates expand/contract. |
| DP-4 | CONFIRMED | Strict equality version-check.ts:64; `MIN_SUPPORTED` grep → 0 hits repo-wide; VITE_APP_VERSION + server APP_VERSION single-sourced from the `version` job. |
| DP-5 | CONFIRMED | ci.yml:857-860 `sleep 10` + curl the `workers.dev` subdomain `/health`, not `api.hushbox.ai`; single shallow GET. |
| DP-6 | CONFIRMED | 24 `secret put` (ci.yml:746-771) re-pushed every run; verify is presence-only `grep -q` (:783). |
| DP-7 | CONFIRMED (nuance) | Dead **at runtime** — only legacy/* consumers (unmounted); live poller uses `OPENROUTER_BASE_URL` (scheduled.ts:190). But still wired into `env.config.ts:313` + wrangler.toml:58 + ci.yml:701 — deletion requires the legacy tree staying unmounted. |
| DP-10 | CONFIRMED | `resolvePlatformChecksum` returns undefined on unset binding (routes.ts:64-71); integrity silently skipped by design (:26-28). |

**New founder questions (deploy):** **QD-1** rollback policy — accept no-rollback + non-atomic partial deploys (legacy had the same shape), or add a revert path + down-migration gating? **QD-2** version gate — keep strict exact-match (every lagging client 426'd through the OTA window), or add a `MIN_SUPPORTED_APP_VERSION` floor? **QD-3** OTA ordering — move APP_VERSION/checksum promotion to *after* R2 publish (or version-key the checksum) so `/updates/current` never advertises an undownloadable/mismatched bundle? **QD-4** health check — target `api.hushbox.ai` + assert version/OTA readiness, or is the workers.dev liveness ping enough?

### 36.2 §29 Admin SPA — all CONFIRMED

| ID | Verdict | Evidence |
|---|---|---|
| AS-1 | CONFIRMED (load-bearing) | Full chain proven: (a) prod never re-mints — `dev-auth.ts:45` returns before mint when `!enabled`, and `computeDevAuthEnabled = (isLocalDev‖isE2E) && !isProduction` = false in prod; (b) `fetchJson` success path calls `res.json()` unconditionally with no content-type check (api-client.ts:77-80; try/catch only on the `!res.ok` branch); (c) no `QueryCache`/`onError`/interceptor (query-provider.tsx). An expired Access cookie → 302→login-HTML → raw non-`ApiError` throw → every screen renders static "Failed to load"; only `ApiError`-404 is special-cased. **Definitive: no clean re-auth; user stuck until a manual full-page reload.** Caveat: concrete throw is SyntaxError (code-supported) or a CORS TypeError — either way non-`ApiError`. |
| AS-2 | CONFIRMED | No `defaultErrorComponent`/`defaultNotFoundComponent` (router.tsx:10-13); no `errorComponent`/boundary (__root.tsx:41-43); repo grep for error-boundary APIs → 0 hits. Render throw outside a query blanks the SPA. |
| AS-3 | CONFIRMED | 3 routes use hand-rolled `typeof` guards (customer-360.tsx:13, audit.tsx:27, feedback.tsx:38); zero zod imports in src/routes/. |
| AS-4 | CONFIRMED (nuance) | All 16 `fetchJson<unknown>` + shared-Zod re-validation; 0 hand-casts. Nuance: use-newsletter.ts:102 declares one *local* `renderResponseSchema` (a runtime zod validator, not a hand-cast type) — weakens "0 locally-declared" wording, not the safety property. |
| AS-5 | CONFIRMED | No version/platform headers in apps/admin (grep empty); gate passes missing-header (version-check.ts:48-49). Structural exemption (unknown-version passes), not an admin allowlist. |
| AS-6/SEC-2 | CONFIRMED | admin/index.html ships only `robots noindex` — no CSP/XFO; wrangler.toml assets-only; `headers-vite-plugin` wired only into apps/web. Admin document ships zero security headers. |

**New founder questions (admin):** **QA-1** detect the Access-expiry signature (redirected/opaque response, non-JSON 200, or HTML body) and force `window.location.reload()` so Cloudflare re-runs the challenge, instead of leaving the SPA on "Failed to load"? **QA-2** add a router `defaultErrorComponent` + root error boundary? **QA-3** adopt zod `validateSearch` on the 3 routes (the app's own CLAUDE.md mandates shared-Zod)? **QA-4** confirm admin's 426 exemption is intentional (it rides missing-header-passes, not an explicit allowlist)? **QA-5** confirm admin intentionally ships no CSP/XFO (Access-gated), or wire `headers-vite-plugin` into apps/admin?

### 36.3 §32 Notifications & account — all CONFIRMED

| ID | Verdict | Evidence |
|---|---|---|
| NA-1 | CONFIRMED (load-bearing) | `push-fcm.ts:188-202` checks only `response.ok`, discards the per-token body, reduces to `{successCount,failureCount}`; `deleteByToken` (device-token-store-db.ts:37-45) is called ONLY by the client unregister route (device-tokens.ts:40), never the send path. **Strengthened: this is longstanding parity — legacy `services/push/fcm.ts:161-175` also never parsed per-token errors or pruned.** The new backend carried the gap forward while adding an unused `deleteByToken`. |
| NA-2 | CONFIRMED | `email-resend.ts` send/sendBatch post directly; no suppression/bounce/complaint gate. The only such vocabulary is the newsletter marketing-list subscriber status (`newsletter.ts:26`), not a transactional-send gate. |
| NA-3 | CONFIRMED | Single send posts empty extra headers (email-resend.ts:112, timeout-only, no retry, by design :20-24); batch injects caller `Idempotency-Key` (:131) + positional-integrity check (:137-142). |
| NA-4 | CONFIRMED | `preferences.accessibility` plaintext jsonb (schema/preferences.ts:18-20) vs `custom_instructions` ECIES bytea (schema/custom-instructions.ts:7,16). Deliberate asymmetry. |
| NA-6 | CONFIRMED | `MODEL_TIER_LOCKED` mapped in both with different wording (error-codes.ts:188 "needs credits/add funds" vs error-messages.ts:105-106 "paid accounts/top up"); live chat uses the NEW `friendlyErrorMessage` (use-authenticated-chat.ts:303). |
| NA-7 | CONFIRMED | `PREMIUM_REQUIRES_BALANCE` sole emitter is legacy/lib/stream-pipeline.ts:221; absent from the new `ERROR_MESSAGES` map → dead on the new backend, orphaned legacy-map copy. |

Push parity confirmed in both stacks: new-message-only trigger, exclude muted+sender+present, no content in payload.

**New founder questions (notif/account):** **QN-1** parse FCM per-token errors and prune `UNREGISTERED` via `deleteByToken` (note: send path must carry the owning userId), or accept unbounded `device_tokens` growth (legacy parity)? **QN-2** is Resend account-level suppression the intended sole gate, or add an app-side suppression store before transactional sends? **QN-3** confirm accessibility prefs are intentionally plaintext (server-readable, not private content)? **QN-4** which `MODEL_TIER_LOCKED` wording is canonical, and retire the legacy `error-messages.ts` map now that it's dead outside legacy/**?

### 36.4 §31 Client crypto — all CONFIRMED (3 real leaks)

| ID | Verdict | Evidence |
|---|---|---|
| CC-1 | CONFIRMED | (a) private key memory-only — `auth.ts:97-98` no-persist, `clear()` zeros it :117-119; only `hushbox_auth_kek` + trial tokens are ever `setItem`'d. (b) KEK persisted — `auth-client.ts:53-64` writes `{kek,userId}` to local/sessionStorage. (c) reconstruct — `restoreSession` reads KEK + authed `/me` `passwordWrappedPrivateKey` → `unwrapAccountKeyWithPassword` (auth-client.ts:134-183). **Scope: server-side ZK intact (server never gets the KEK); client-side softening — localStorage-KEK theft + a live cookie rebuilds the account key. Both factors required.** |
| CC-2 | CONFIRMED (fail-closed) | Client redeclares `KeyChainResponse` (epoch-key-cache.ts:114-118) with no shared-type tie, but `verifyEpochKeyConfirmation` gates every unwrap (:123,:154) → drift renders `[decryption failed]`, never silent plaintext corruption. |
| CC-3 | CONFIRMED (by design) | Message **body sent plaintext** for inference (`content: message`, use-authenticated-chat.ts:781-782); only the title is client-encrypted (:701). **The single biggest gap vs "E2E" intuition: bodies are visible to the server at inference time.** |
| CC-4 | CONFIRMED | Media decrypt buffers full ciphertext then full plaintext with no pre-fetch size guard (use-decrypt-blob.ts:158,185-186). |
| CC-7 | CONFIRMED (real leak) | `clearLocalAuthState` (auth.ts:600-611) never calls `clearDecryptedMessageCache`; the module `decryptedCache` of all viewed plaintext (use-decrypted-messages.ts:41) survives SPA sign-out until a tab reload; zero non-test callers of the clear fn. |
| CC-8 | CONFIRMED | 5 `console.error` sites log error objects with static labels, not plaintext (use-authenticated-chat.ts:327,759,838,1123,1304). |
| CC-9 | CONFIRMED (real leak) | Guest `derivedKeys.privateKey` (share.c.$conversationId.tsx:44) never zeroed; unmount runs only `clearLinkGuestAuth` (nulls pubkey); guest-derived epoch keys (in epoch-key-cache, only cleared on account logout) + plaintext (decryptedCache, never cleared) persist after leaving the share page. |

**New founder questions (client crypto):** **QC-1** move the account-key KEK behind a non-extractable WebCrypto `CryptoKey` / WebAuthn-passkey wrapping so localStorage theft alone can't rebuild the key (accept the keep-signed-in UX cost)? **QC-2** make `clearLocalAuthState` call `clearDecryptedMessageCache`, zero the guest key + clear epoch cache on share-page unmount, and force `location.reload()` on logout/guest-exit to drop module-level plaintext (CC-7/CC-9)? **QC-3** sign off that plaintext-body-for-inference is the intended trust model, and scope "encrypted" copy to at-rest + titles (CC-3)? **QC-4** hoist a single shared KeyChain type/schema so server-serializer drift is a build error not a runtime `[decryption failed]` (CC-2)? **QC-5** add a client-side media `sizeBytes` ceiling before fetch/decrypt (CC-4)?

### 36.5 §27 Scripts — CONFIRMED with 2 sub-claim REFUTATIONS

| ID | Verdict | Evidence |
|---|---|---|
| ST-1 | CONFIRMED (headline) / **2 sub-claims REFUTED** | Core holds: 244 committed files, `git status` = 163 M + 81 D + 82 ??; pure perf cache (nothing asserts exact cache bytes; any valid OPAQUE registration authenticates); gitignore rationale "nothing produces new files" is FALSE (live seed writes on miss, package.json:9). **REFUTED (a):** churn is NOT from a divergent OPAQUE_MASTER_SECRET/fingerprint — the 163 M files keep the SAME filename-key but different bytes ⇒ secret+fingerprint unchanged. **REFUTED (b):** a miss does NOT regenerate identical bytes — `createAccount`→`generateKeyPair`→`x25519.keygen()` (sharing.ts:12-15) is random, no seed (a deterministic `deriveKeyPairFromSeed` exists at sharing.ts:17 but is unused). **Consequence: pinning the dev secret will NOT stop the churn; only gitignoring the dir OR switching persona keygen to `deriveKeyPairFromSeed` will.** |
| ST-2 | CONFIRMED | `scripts/.cache/local/**` — 4 tracked files despite `.gitignore:108`; `git rm --cached` needed. |
| ST-3 | CONFIRMED (location nit) | Stale "no seed phase" docstrings (ensure-stack.ts:18-19,82-85) vs live seed (package.json:9,64); `TRACKED_TABLES=[]` is at **ensure-stack-cli.ts:34** (not ensure-stack.ts). |
| ST-4 | CONFIRMED | Sole raw `process.env['CI']` at ensure-stack-cli.ts:287; explained but not framed as an `isCI`-convention exception. |
| ST-5 | CONFIRMED | `legacy_seed.ts`/`legacy_seed-cache.ts` (mutually referencing orphans) + `generate-og-image.ts` — zero pnpm/workflow consumers. |
| ST-6 | CONFIRMED | `djb2Hash(name)%199+1` (worktree.ts:78) with no collision detection. |
| ST-7 | CONFIRMED | `verify-evidence.ts:9-10,35` + `SERVICE_NAMES.AI_GATEWAY` (packages/db/src/evidence.ts:5) reference `ai-gateway`. |

**MOOT (prior question retracted):** "wire verify:env into CI" — it already runs in three modes (ci.yml:146,223,413).

**New founder questions (scripts):** **QS-1** the seed-crypto cache can NEVER be clean-in-git after a seed (keygen is random) — gitignore `scripts/.cache/seed-crypto/` (accept per-machine warm cost) OR switch persona keygen to the deterministic `deriveKeyPairFromSeed` so committed bytes are stable? (pinning the secret is a non-fix). Also fix the false `.gitignore:99-103` comment regardless. **QS-2** `git rm --cached scripts/.cache/local/` (ST-2)? **QS-3** restore `TRACKED_TABLES` for re-seed dirty-tracking, or is idempotent-mint-every-time intended (ST-3)? **QS-4** worktree slot collision fail-fast (ST-6)? **QS-5** delete the dead scripts (ST-5)?

### 36.6 §28 Realtime — CONFIRMED with 1 REFUTATION + severity corrections

| ID | Verdict | Evidence |
|---|---|---|
| RT-1 | CONFIRMED | Control routes `safeParse(await request.json())` with no try/catch on the parse (conversation-room.ts:241,249,257,278); malformed JSON → SyntaxError → 500, the 400-VALIDATION branch unreachable. |
| RT-2 | CONFIRMED | `sendQuietly` (room-core.ts:878-888) never reads `bufferedAmount`; a present-but-slow socket buffers unbounded in the runtime. |
| RT-3 | **WEAKENED — "unbounded memory" REFUTED** | The per-stream-bytes-not-count observation is literally true, BUT stream count is hard-bounded by compile ceilings (context.ts:50-55 `maxNodes:64 × maxFanOutWidth:6 × maxLoopIterations:32 × maxModelCallSteps:16`, enforced compile-definition.ts:150-201); streamId minted once per streaming node execution (interpreter.ts:909). Buffered bytes are additionally cost-circuit-bounded, and a 2 MiB-full stream drops its events array. **Non-issue by construction; the missing count cap is inert.** |
| RT-4 | **WEAKENED — premise CONFIRMED, severity refuted** | No `ctx.waitUntil` in packages/realtime (grep empty) is true, but the in-flight executor subrequest keeps the DO resident for the run, `finishRun` issues terminal duties synchronously as fresh tracked I/O, and every duty is backstopped (releaseHold→TTL, failRun→lease lapse, notify→best-effort). Worst case = delayed hold-release / missed push, recovered by backstops — **not corruption.** `waitUntil` is defense-in-depth, not a correctness fix. |
| RT-5 | CONFIRMED (low) | `createCachedLiveness` memo (liveness.ts:55) never evicts; bounded by the room's cumulative participant set, not per-frame. |
| RT-6 | **CONFIRMED dead — LOC figure WRONG** | `legacy_conversation-room.ts` is imported only by its own test (index.ts exports the live class); genuinely dead. **But it is 217 LOC, not ~889** — the audit's size figure was inaccurate. |
| RT-7 | CONFIRMED (doctrine-compliant) | Stop is HTTP-only (`POST /run/stop`); `clientMessageSchema` has no stop variant (protocol.ts:40-44). Matches ARCHITECTURE:171 verbatim — not a defect. |

**New founder questions (realtime):** **QR-1** backpressure — when `bufferedAmount` exceeds a threshold, drop-and-`stream-gone` the slow socket (client reconnects + resumes), pause that principal, or accept unbounded buffering (RT-2)? **QR-2** wrap `releaseHold`/`failRun`/`notify` + the `watchRun` continuation in `ctx.waitUntil` for a contractual flush guarantee, or rely on the TTL/lease backstops (RT-4, correctness safe either way)? **QR-3** delete `legacy_conversation-room.ts` (217 LOC) + its test, or retain as a rollback artifact (RT-6)? **QR-4** (minor) bound/TTL-sweep the liveness memo, or accept participant-set growth (RT-5)?

### 36.7 §30 db internals — all CONFIRMED (attribution nuances)

| ID | Verdict | Evidence |
|---|---|---|
| DBI-5 | CONFIRMED (load-bearing) | Drift gate (ci.yml:63-66) diffs only generated output; drizzle doesn't model triggers (0039:5-6; 0039_snapshot.json has zero trigger tokens); `db:generate` never rewrites an existing SQL file → editing/deleting `CREATE FUNCTION` (0039:17), the `search_path` pin (0039:19), or the trigger (0039:47) yields **no diff, gate passes**. Only the billing integration suite guards it. |
| DBI-7 | CONFIRMED (=JD-1) | `runLockValidation` (txn-executor.ts:55-131) is a scratch-table lock test; no `runSettlement`/`chargeWithinTx`/`ledger_entries`/trigger in the workers project. |
| DBI-10 | CONFIRMED (load-bearing) | `users.id = crypto.randomUUID()` (v4) at registration.ts:118, bound to OPAQUE registerInit, threaded to the insert (stores.ts:65,92), overriding the schema `uuidv7()` default (users.ts:12). Every other PK keeps uuidv7(). Users is the sole non-time-ordered PK. |
| DBI-1 | CONFIRMED (attribution nuance) | `new Pool({max:1})` is at **client.ts:96** (not factories.ts, which merely calls createDb); hot path (pipeline-bindings.ts:29) never `.end()`s it. Nuance: cron (scheduled.ts:207) + jobs (dispatcher-bindings.ts:86) DO close it — "only the DO test closes it" was overstated; the hot-request-path abandonment holds. |
| DBI-4 | CONFIRMED | Dual lint bans (no-brand-cast, no-brand-import) close forgery; but `runSettlement` hands the live `tx` to `body` (settlement.ts:12-13) and nothing prevents capturing it past close — runtime footgun, unguarded. |
| DBI-6 | CONFIRMED (scope nuance) | Hand SQL bare `CREATE FUNCTION`/`CREATE CONSTRAINT TRIGGER` (no OR REPLACE); the drift job never migrates. Nuance: `db:migrate` DOES run against fresh docker PG in test/e2e/deploy jobs (ci.yml:148,428,820) and the journal prevents re-apply — fresh-DB executability IS exercised there; non-idempotency is mitigated, not eliminated. |
| DBI-2 | CONFIRMED | The four `neonConfig.*` mutations are gated `if(options.neonDev)` (client.ts:89-94); production omits neonDev. Dev-only. |

**New founder questions (db):** **QB-1** add a CI step snapshotting `pg_get_functiondef`/`pg_get_triggerdef` from the migrated DB, diffed against a committed golden file, so the money-safety trigger can't silently regress even if the integration assertion weakens (DBI-5)? **QB-2** confirm the settlement concurrency model — READ COMMITTED + row-lock (`FOR UPDATE`) with no 40001 retry, resting on the deferred trigger at COMMIT — so we assert it rather than infer it? **QB-3** accept v4 `users.id` (costs B-tree insert locality on the most-joined table) or give OPAQUE a separate ephemeral id and let `users.id` keep uuidv7 (DBI-10)? **QB-4** add one `vitest-pool-workers` test driving the REAL settlement (or a faithful multi-leg ledger insert that trips the deferred trigger) under workerd, closing the node-vs-workerd gap (DBI-7/JD-1)?

### 36.8 §33 Demo & capture — all CONFIRMED (isolation clean)

| ID | Verdict | Evidence |
|---|---|---|
| DM-1 | CONFIRMED | Gated dynamic import (main.tsx:33-35); zero static prod imports of `src/demo/*` (grep); fetch shim serves in-memory `DemoBackendStore`, 404s unknown API routes, never mutates a real backend (fetch-shim.ts:49-59,222-231); runtime-ephemeral fake session (seed-session.ts:21-35). Only API egress is `GET /models` (fetch-shim.ts:83). |
| DM-6 | CONFIRMED (load-bearing) | No lint/arch rule bans a static import of `src/demo/**` into the prod chunk; isolation is the `isDemoPath` convention only, unenforced. |
| DM-2 | CONFIRMED | `buildDemoHeaders` (generate-headers.ts:162-177) relaxes only `frame-ancestors`→'self' + XFO→SAMEORIGIN; script-src untouched; cross-origin framing stays denied. |
| DM-3 | CONFIRMED | Generators are npm scripts only; zero CI workflow runs them or drift-checks the committed assets. |
| DM-4 | CONFIRMED | Two stray `page@*.webm` screencasts committed via LFS (ads/2026-07-hq-tour/03-screen-capture/; .gitattributes:23). |
| DM-5 | CONFIRMED (nuance) | `07-project/` empty (git doesn't track empty dirs, so not literally "committed") while PRODUCTION-GUIDE.md:337,477 + create-ad SKILL.md:413 still instruct scaffolding there; real model is spec-driven (ads/src/campaigns.ts). |
| DM-7 | CONFIRMED | Capture manual-only (no CI ref); pure helpers 95% perFile; driver/ffmpeg/Remotion tsx excluded by design. |
| RISK | **CLEAN** | No embedded credentials/API keys in demo/capture; the auth "bypass" is a runtime-ephemeral in-memory keypair reachable only via the gate; capture drives localhost. |

**New founder questions (demo):** **QM-1** redirect a standalone `hushbox.ai/demo` visit → `/welcome`, or accept a bare framed public SPA at `/demo`? **QM-2** freeze the `/models` catalog to a fixture (fully hermetic/deterministic demo) or keep the live passthrough (current catalog)? **QM-3** add a `git diff --exit-code` CI drift job for committed generated assets (og/readme/social), or leave manual? **QM-4** purge the two `page@*.webm` debris + add a guard against auto-named Playwright captures? **QM-5** delete empty `07-project/` and fix the two docs to the spec-driven model, or adopt the per-ad-project layout for real? **QM-6** add an arch rule banning static imports of `src/demo/**` outside `main.tsx`'s dynamic import + tests, so a refactor can't pull the fake session/shim into the prod chunk (DM-6)?

### 36.9 Hard-confirm summary

**60 findings across §26–33 re-verified. Outcome: no finding was fully REFUTED; 1 was WEAKENED to a non-issue (RT-3 "unbounded memory" — stream count is compile-ceiling-bounded); 2 supporting sub-claims were struck (ST-1: churn is not secret/fingerprint-driven, and a cache miss does NOT regenerate identical bytes — keygen is random); RT-4 severity downgraded (backstopped, not a correctness defect); RT-6 LOC corrected (217, not 889); DBI-1/DBI-6 attribution nuances.** The core of every section holds. The load-bearing security/money items — CC-1/CC-7/CC-9 (client-crypto leaks), AS-1 (admin Access-expiry UX), NA-1 (device-token growth), DBI-5 (trigger invisible to drift gate), DBI-7/JD-1 (settlement never run in a DO under workerd), DM-1/DM-6 (demo isolation unenforced) — are all CONFIRMED. Every §26–33 finding now has a definitive verdict; the surviving design decisions are the QD/QS/QR/QA/QB/QN/QC/QM questions above, awaiting founder rulings.

### 36.10 Founder rulings on §26–33 (2026-07-18)

Decided (32); **open-pending-discussion (5):** qs1, qs5+qr3, qr4, qb1, qc1.

| # | Ruling | Action |
|---|---|---|
| QD-2 | **Keep strict exact-match** (option a — no floor). *Corrects a mis-record: the earlier row logged my recommendation (a floor), not the founder's answer.* | No change (F-25 retired) |
| QD-1 | Accept no-rollback / non-atomic deploys | **No change, no doc change** (legacy parity, zero users) |
| QD-3 | Fix OTA ordering | Publish R2 bundle + checksum before flipping APP_VERSION/deploy |
| QD-4 | Health check → real host | curl `api.hushbox.ai` + assert version/OTA readiness |
| QS-2 | `git rm --cached scripts/.cache/local/` | Do it |
| QS-3 | Keep idempotent-mint-always | Leave `TRACKED_TABLES=[]`; refresh stale docstrings |
| QS-4 | Worktree slot collision | Ignore (accept) |
| QR-1 | WS backpressure | **Accept unbounded buffering** (option c) |
| QR-2 | `waitUntil` for terminal duties | Wrap releaseHold/failRun/notify + watchRun |
| QA-1 | Admin Access-expiry | Detect expiry signature → force reload to re-auth |
| QA-2 | Admin error boundary | Add router defaults + root boundary |
| QA-3 | Admin zod `validateSearch` | Adopt on the 3 routes |
| QA-4 | Admin 426 exemption | Confirmed intentional |
| QA-5 | Admin security headers | Wire `headers-vite-plugin` into apps/admin |
| QB-4 | Real settlement under workerd | Add the vitest-pool-workers test (closes JD-1) |
| QB-3 | v4 user ids | **Give OPAQUE a separate ephemeral id; `users.id` → uuidv7 default** |
| QB-2 | Concurrency model | Confirmed READ COMMITTED + FOR UPDATE + deferred trigger; add a pinning assertion |
| QN-1 | FCM token pruning | Parse per-token errors + prune via `deleteByToken` (thread userId) |
| QN-4 | MODEL_TIER_LOCKED wording | New wording canonical; retire the legacy map |
| QN-2 | Email suppression | Confirmed Resend-side is the sole gate |
| QN-3 | Accessibility prefs plaintext | Confirmed intentional (non-private UI state) |
| QC-3 | Plaintext-for-inference | **Already correct** — signed off; marketing copy already honest. No action |
| QC-2 | Clear plaintext caches on logout/guest-exit | Wire clears + hard reload |
| QC-4 | Lift KeyChain contract into shared | Do it (drift → build error) |
| QC-5 | Client media size-guard | Add pre-fetch `sizeBytes` ceiling |
| QM-2 | Demo `/models` | **Keep live passthrough** (option b) |
| QM-1 | Standalone `/demo` | Redirect → `/welcome` |
| QM-6 | Demo isolation | Add arch rule banning static `src/demo/**` imports |
| QM-3 | Committed-asset drift CI | **Leave manual** (option b) |
| QM-5 | `07-project/` + docs | Ignore |
| QM-4 | Capture webm debris | Purge + guard |

**qc1 (KEK hardening) — approved in principle (option a), pending the exact-change spec below.**

**§36.10 open-items resolved (2026-07-18):** **qs1** — keep the seed-crypto cache (it works in CI via shared committed dev master secret; churn is fingerprint self-invalidation from the rewrite — regenerate+commit once after crypto settles; fix only the false gitignore comment). **qr4** — accept the liveness memo (bounded by participant set). **qb1** — (a) add a CI `pg_get_functiondef`/`pg_get_triggerdef` golden-dump diff so the zero-sum trigger can't silently regress. **qc1** — (a1) wrap the KEK under a non-extractable IndexedDB `CryptoKey`; **no UX cost, keep-me-logged-in preserved** (a2/WebAuthn not adopted). **qs5+qr3** — see §37 (legacy quarantine plan), pending approval.

---

# 38. Remediation plan — the implementation register

This is the actionable heart of the audit: every decided fix as a self-contained work item an implementer can pick up cold. Each carries **Legacy** (what the old monolith did, where a counterpart exists), **New (now)** (what the current code does — the problem), **Change** (the exact planned fix, with the founder ruling baked in), **Why**, **Touch points** (files), and **Acceptance** (tick-box criteria that double as progress). Update the **Status** line and tick the acceptance boxes as you go.

**This register — and specifically its §38.0 Board — is the single source of truth for every remediation task in this audit. There is no other task list; the former top-of-doc backlog was folded in here.**

**How to use this section**
- The **Board** (§38.0) is the at-a-glance tracker — one row per item, flip its status there and in the item.
- Work top-down by tier; the build order inside a tier is roughly listed order.
- Evidence for every claim lives in the referenced finding section (§2–§36); this register is the *plan*, not the proof.

**Status legend:** `⬜ not-started` · `🟨 in-progress` · `🟦 in-review` · `✅ done` · `⬛ blocked`
**Priority:** 🔴 critical · 🟠 major · 🟡 minor · ⚪ trivial

## 38.0-pre Orientation for a brand-new implementer

Read this once and you can pick up any item below cold.

**What HushBox is.** A privacy-first, end-to-end-encrypted AI chat aggregator: users talk to 100+ LLMs (via OpenRouter) through a React SPA (`apps/web`), a Capacitor mobile shell (same web code), an Astro marketing site (`apps/marketing`), and an Access-gated admin SPA (`apps/admin`). The backend is one Cloudflare **Worker** (`apps/api`) organized as **vertical slices**, with **Durable Objects** for realtime + job dispatch, **Neon Postgres** as the only durable truth, **Upstash Redis** for ephemeral coordination, and **R2** for ciphertext blobs.

**The rewrite context.** The backend was rewritten from a deployed monolith into vertical slices. The old monolith survives as a read-only **legacy corpus** (`apps/api/src/legacy/**` + scattered `legacy_*` files) used for parity reference. This audit is that parity record; F-34/F-35 quarantine the corpus.

**Where to get your bearings (read these first):** `docs/ARCHITECTURE.md` (system map + doctrine), `docs/CODE-RULES.md` (binding rules), `docs/TECH-STACK.md` (choices), `apps/api/CLAUDE.md` + `apps/web/CLAUDE.md` (tree-specific rules). Run the stack with `pnpm dev`; test with `pnpm test` (95% per-file coverage gate).

**Conventions you must follow (or CI fails):** TDD (a failing test first — `docs/AGENT-RULES.md`); every mutating route goes through one of five `idempotent.*` wrappers via `runMutation`; domain code returns `neverthrow` `Result`, never throws; env vars exist only as `env.config` registry entries; Redis keys only as typed registry entries; new code must never import from a `legacy_` path (lint-enforced).

**Glossary of terms used in the cards below:**
- **Slice** — a vertical feature module under `apps/api/src/slices/*` (identity, conversations, chat, billing, models, media, notifications, newsletter, account, workflows, admin). Its `index.ts` barrel is its only public surface; one slice owns each table.
- **Settlement (`settle()`)** — the single fenced DB transaction that atomically writes a chat turn's content + every charge + double-entry ledger legs + the idempotency-key flip. "Nothing commits mid-run": a run either fully settles or leaves only an expiring Redis hold. Entered only with a branded `SettlementTx` handle.
- **Idempotency-key row** — the referee for a chat run (there is no run table); first arrival claims it by unique insert; the conversation DO heartbeats a ~90s lease.
- **Ledger** — double-entry: signed legs per `transactionId` summing to zero; a `DEFERRABLE INITIALLY DEFERRED` **zero-sum trigger** aborts any unbalanced transaction at COMMIT. This is the money-safety invariant.
- **Admission / hold / cost circuit** — before a paid run, an atomic Redis Lua script checks balance − Σholds ≥ estimate and places a TTL **hold**. Mid-run, a **cost circuit** kills any run whose observed spend exceeds `hold × 5`.
- **Conversation DO** — the Durable Object that hosts a conversation's realtime WebSocket, the in-memory workflow interpreter, and the run/settlement coordination.
- **OPAQUE / export key (KEK) / private key** — auth is the OPAQUE PAKE (zero-knowledge password proof). Login yields an **export key** (a.k.a. KEK) that unwraps the user's **account private key**. The private key decrypts conversation keys.
- **Epoch keys / wrapping** — each conversation has versioned **epoch** keys; message content is encrypted to an epoch key, which is wrapped to each member. Rotation mints a new epoch.
- **Cassettes** — recorded OpenRouter request/response pairs replayed in CI so tests never make real charged AI calls.
- **Telemetry: Sentry / WAE / Workers Logs** — Sentry = unexpected-error/defect alerting (scrubbed); WAE (Workers Analytics Engine) = metrics (being torn down, F-32); Workers Logs = structured audit-trail logs. All behind one `Telemetry` port with adapter fan-out.
- **Jobs / JobDispatcher** — the only must-happen async mechanism: a `jobs` row inserted in a transaction, executed by an alarm-clocked Durable Object.

**Reading a card:** *Legacy* = what the old monolith did (skip if "N/A"); *New (now)* = the current code + the problem, with `file:line`; *Change* = exactly what to do (the founder's ruling); *Why* = the rationale; *Touch* = where to work; *Acceptance* = tick-boxes that are both the definition-of-done and your progress. Where the exact implementation is genuinely open, the card says so and scopes what is known — do not invent precision that isn't there.

## 38.0 Board

> **Remediation run status — updated 2026-07-19 (subagent-driven-dev run).**
> This block is the authoritative done/remaining tracker and **supersedes the per-row
> `⬜` markers** in the table below (those were not individually re-flipped). A future
> agent picking up the remaining work should start here. All changes are in the
> **uncommitted working tree** (not committed).
>
> **✅ DONE — implemented + independently audited clean (56):**
> F-01, F-02, F-03, F-04, F-05, F-06, F-07, F-08, F-09, F-10, F-11, F-12, F-13, F-14,
> F-15, F-16, F-17, F-18, F-20, F-21, F-22, F-23\*, F-24, F-26, F-27, F-28, F-29, F-30,
> F-31, F-33\*, F-36, F-37, F-38, F-39, F-40, F-41†, F-42, F-43, F-44, F-45, F-46, F-48,
> F-50, F-52, F-53, F-56, F-57, F-58, F-60, F-61, F-62, F-63, F-64, F-66, F-69, F-70.
> (F-25 / F-47 / F-55 are retired IDs — do not implement.)
>
> **Scoping notes on the asterisked done items:**
> - **F-23\*** — done for the **media + streaming** targets only (founder ruling 2026-07-19):
>   an additive `DomainError.wireCode` carrier + `UNSUPPORTED_MODALITY/RESOLUTION/DURATION`
>   and `CONTENT_POLICY/CONTEXT_LENGTH_EXCEEDED/NETWORK_ERROR`. The **payment-decline** target
>   was deliberately left flattened (it would reverse the "persist only `card_declined`,
>   never provider text" decision). `MISSING_MODALITY_CONFIG` + `AUDIO_DISABLED` are
>   registered with copy but unwired (no clean emit site) — an optional follow-up.
> - **F-33\*** — both the server functional-core extraction **and** the client `resolveBilling`
>   retirement are done; client + server share the pure `resolveFundingDecision` core and the
>   §2.K contract test guards both legs.
> - **F-41†** — deploy-substitution + CI placeholder-guard mechanism done; **values pending**:
>   founder must add the `APPLE_TEAM_ID` + `ANDROID_CERT_SHA256_FINGERPRINT` CI secrets.
> - **CI-pending / founder-verify** (code complete; first exercised on a real CI/deploy run):
>   F-02, F-09, F-26, F-27, F-41, F-56.
>
> **⛔ NOT DONE — remaining backlog (deferred; for the next agent), with unlock order:**
> - **F-19** — bump cassette version to v2 (needs an out-of-band re-record; not started).
> - **F-32** — tear down WAE (telemetry adapters + config + ARCHITECTURE §Observability +
>   TECH-STACK). Unblocked (F-11 done).
> - **F-34 → F-35** — de-legacy new code, then quarantine the legacy corpus to `/legacy/`.
>   Needs F-23 (done) and F-32 (not done) first.
> - **F-49** — restore server→client typed responses (large: ~119 `respond*` tails +
>   `api-client.ts`). Best run in an isolated window.
> - **F-51** — centralize mid-session 401/revocation (`auth.ts` + query-provider).
> - **F-54 / F-65** — e2e hardening (route harness-bypassing specs through fixtures;
>   fix conditional-noop + shared-persona ordering).
> - **F-59** — consolidate duplicated logic (nano→dollar ×4, `utcDayKey`, `PRIVILEGE_ORDER`,
>   media MIME allowlist).
> - **F-67** — Sentry scrub regression test + client-error-SDK lint ban.
> - **F-68** — fix stale-doc claims (ENV-10 / WF-2 / AD-5).
>
> **Optional micro-follow-ups surfaced during the run:**
> - Tighten `FlowStartRequest.runId` from optional → required (F-11 left it optional to avoid
>   rippling to ~11 test doubles; production always mints + forwards it).
> - Switch the interpreter's `telemetry.warn` `runId` field from the client `runKey` to the
>   DO-minted server `runId` (F-11 audit note).
> - Wire F-23's `MISSING_MODALITY_CONFIG` / `AUDIO_DISABLED` to emit sites.
>
> **Accepted behavior changes (founder-approved 2026-07-19):** F-33 — owner-funded turn with a
> failing *sender* wallet-read returns 201 not 503; guest + group-exhausted + premium now shows
> `guest_budget_exhausted` (was `premium_requires_balance`). F-61 — WS reconnect ceiling 30s→10s.
>
> **Pre-existing tree breakage (NOT an audit item; founder to handle):**
> `apps/api/src/slices/chat/domain/media-turn.integration.test.ts:87` (vitest Mock TS2322)
> blocks the api typecheck gate.
>
> **Docs updated this run** (applied): ARCHITECTURE §Money + §Deliberate-limits (F-10/F-11);
> CODE-RULES.md:242 (F-22); `apps/api/src/slices/admin/CLAUDE.md` guardrails (F-66); stale code
> comments for F-08/F-45/F-33/F-69. **Doc updates still owed** belong to the deferred items:
> F-32 (TECH-STACK WAE row + §Observability), F-35 (`legacy_` naming rules across docs),
> F-68 (ENV-10/WF-2/AD-5), `docs/plans/ADMIN-PLANE.md` `maxTargets` (lines 67, 294).

| ID | Fix | Pri | Area | Status | Ruling |
|---|---|---|---|---|---|
| F-01 | Confine `@sentry/*` imports to the telemetry adapter | 🔴 | telemetry | ⬜ | SE-1 |
| F-02 | Run real `settle()` inside a DO under workerd | 🔴 | jobs/db | ⬜ | JD-1/DBI-7/QB-4 |
| F-03 | Settlement crash-injection fuzz suite | 🔴 | jobs | ⬜ | JD-2 |
| F-04 | KEK → non-extractable IndexedDB wrap | 🟠 | client-crypto | ⬜ | QC-1 |
| F-05 | Clear plaintext caches on logout/guest-exit | 🟠 | client-crypto | ⬜ | QC-2 |
| F-06 | Origin check on the WS upgrade | 🟠 | security | ⬜ | SEC-1/Q4 |
| F-07 | Admin Access-expiry → reload re-auth | 🟠 | admin | ⬜ | QA-1 |
| F-08 | Admin SPA security headers | 🟠 | admin | ⬜ | QA-5/SEC-2 |
| F-09 | CI golden-dump of pg triggers/functions | 🟠 | db/ci | ⬜ | QB-1 |
| F-10 | Pin the settlement concurrency model | 🟡 | db | ⬜ | QB-2 |
| F-11 | Cost-circuit trip → Sentry event + doc | 🟠 | money | ⬜ | WF-1/Q9 |
| F-12 | FCM dead-token pruning | 🟠 | notifications | ⬜ | QN-1 |
| F-13 | Lift the KeyChain contract into shared | 🟡 | client-crypto | ⬜ | QC-4 |
| F-14 | Client media size-guard before decrypt | 🟡 | client-crypto | ⬜ | QC-5 |
| F-15 | Arch rule pinning demo isolation | 🟡 | demo | ⬜ | QM-6/DM-6 |
| F-16 | Redirect standalone `/demo` → `/welcome` | 🟡 | demo | ⬜ | QM-1 |
| F-17 | Keyed epoch confirmation | 🟡 | crypto | ⬜ | Q2/CR-3 |
| F-18 | Delete-account lockout split window | 🟡 | auth | ⬜ | Q3/RL-2 |
| F-19 | Bump cassette version to v2 | 🟠 | ci | ⬜ | Q6/CAS-1 |
| F-20 | Distinct password-reset email subject | 🟡 | email | ⬜ | Q11/EM-2 |
| F-21 | Overlay/Sheet overflow hardening in primitives | 🟠 | ui | ⬜ | Q16/UI-1/2 |
| F-22 | Delete dead invert-colors scaffolding | 🟡 | ui | ⬜ | Q12/UI-3 |
| F-23 | Restore error-code granularity (3 targets) | 🟡 | api | ⬜ | Q5/ENV-9 |
| F-24 | Remove the redundant trial 20/60s burst | ⚪ | billing | ⬜ | Q1/RL-1 |
| F-26 | Fix OTA advertise-before-publish ordering | 🟠 | deploy | ⬜ | QD-3/DP-1 |
| F-27 | Health check → real host + version assert | 🟡 | deploy | ⬜ | QD-4/DP-5 |
| F-28 | Admin root error boundary | 🟠 | admin | ⬜ | QA-2/AS-2 |
| F-29 | Admin zod `validateSearch` | 🟡 | admin | ⬜ | QA-3/AS-3 |
| F-30 | `waitUntil` on DO terminal duties | ⚪ | realtime | ⬜ | QR-2/RT-4 |
| F-31 | v4→v7 user ids (separate OPAQUE id) | 🟠 | db | ⬜ | QB-3/DBI-10 |
| F-32 | Tear down WAE; Sentry + Workers Logs only | 🟠 | observability | ⬜ | Q10/SE-2 |
| F-33 | Billing decision functional-core refactor | 🟠 | billing | ⬜ | Q17/GB-1 |
| F-34 | De-legacy the new code (sever all live edges) | 🟠 | cross-cutting | ⬜ | §37-P0 |
| F-35 | Quarantine the legacy corpus to `/legacy/` | 🟠 | cross-cutting | ⬜ | §37 |
| F-36 | Fix seed-cache gitignore comment + regen once | ⚪ | scripts | ⬜ | QS-1 |
| F-37 | `git rm --cached scripts/.cache/local/` | ⚪ | scripts | ⬜ | QS-2 |
| F-38 | Refresh stale seed docstrings | ⚪ | scripts | ⬜ | QS-3 |
| F-39 | Purge stray `page@*.webm` capture debris + guard | ⚪ | ads | ⬜ | QM-4/DM-4 |
| F-40 | Delete dead `generate-og-image.ts` | ⚪ | scripts | ⬜ | QS-5 |
| F-41 | Store deep-link files: deploy substitution + CI guard | 🟠 | mobile | ⬜ | Q14/MK-1 |
| F-42 | Gate Android WebView debugging to dev | 🟠 | mobile | ⬜ | Q15/MK-2 |
| F-43 | Mandate admin reversibility battery | 🟠 | admin | ⬜ | AD-1 |
| F-44 | Registry-driven undo round-trip harness | 🟠 | admin | ⬜ | AD-2 |
| F-45 | Close the idempotency-rule blind spot | 🟠 | arch | ⬜ | WF-3 |
| F-46 | Fix the Prettier-enforcement doc claim (already enforced via ESLint) | 🟡 | ci | ✅ | CI-1 (corrected) |
| F-48 | Jobs alarm-semantics + idle-step tests | 🟠 | jobs | ⬜ | JD-3/4 |
| F-49 | Restore server→client response typing (RULED: full refactor) | 🟠 | frontend | ⬜ | FE-1 |
| F-50 | Route OPAQUE/2FA fetches through header shim | 🟠 | frontend | ⬜ | FE-2 |
| F-51 | Centralize mid-session 401/revocation | 🟠 | frontend | ⬜ | FE-3 |
| F-52 | Fix the version-check error contract | 🟠 | api | ⬜ | ENV-7 |
| F-53 | Delete `provisionUserBilling` | 🟠 | billing | ⬜ | EM-1 |
| F-54 | Route harness-bypassing e2e through fixtures | 🟠 | e2e | ⬜ | E2E-1 |
| F-56 | Assert Resend + FCM in CI | 🟠 | ci | ⬜ | CAS-3 |
| F-57 | Token estimates → shared helper | 🟡 | billing | ⬜ | TE-1 |
| F-58 | Fix env existence-branching + comments | 🟡 | env | ⬜ | ENV-1…6 |
| F-59 | Consolidate duplicated logic | 🟡 | cross-cutting | ⬜ | DUP-2/3/4/5 |
| F-60 | FCM RS256 → packages/crypto (RULED: relocate) | 🟡 | crypto | ⬜ | CR-5/6 |
| F-61 | WS reconnect backoff jitter | 🟡 | realtime | ⬜ | FE-5 |
| F-62 | Web query-key factories + zod validateSearch | 🟡 | frontend | ⬜ | FE-6/7 |
| F-63 | Close a11y-wall gaps | 🟡 | a11y | ⬜ | UI-4/6/7 |
| F-64 | Marketing SEO/links fixes | 🟡 | marketing | ⬜ | MK-3/4/5 |
| F-65 | Fix conditional/fragile e2e | 🟡 | e2e | ⬜ | E2E-3/4 |
| F-66 | Delete admin maxTargets field + interleaving tests (RULED: delete) | 🟡 | admin | ⬜ | AD-3/4 |
| F-67 | Sentry scrub test + client-SDK lint ban | 🟡 | telemetry | ⬜ | SE-6 |
| F-68 | Fix stale-doc claims | 🟡 | docs | ⬜ | ENV-10/WF-2/AD-5 |
| F-69 | Delete dead exports | 🟡 | cleanup | ⬜ | DEAD-2 |
| F-70 | Jobs edge-case tests | 🟡 | jobs | ⬜ | JD-5…8 |

**Retired IDs** (deleted, gaps intentional): F-25 (version-gate floor), F-47 (pre-push cache un-mask), F-55 (2FA fallback e2e).

**Ruled — no action** (recorded in §38.6): Q13, Q18, Q19, QD-1, QD-2 (keep exact-match gate), QR-1, QR-4, QS-4, QA-4, QN-2, QN-3, QC-3, QM-2, QM-3, QM-5, QB-2(confirm-half).

## 38.1 Tier 0 — Criticals

#### F-01 · Confine `@sentry/*` imports to the telemetry adapter · 🔴 · SE-1
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** the monolith had no Sentry scrub discipline of this shape; not a parity item.
- **New (now):** nothing stops `import * as Sentry from '@sentry/cloudflare'` anywhere in the tree — the boundaries `INFRA_MODULES` allowlist omits `@sentry`, there is no `no-restricted-imports` entry, and no vendored rule. Any stray import bypasses `scrubSentryEvent` and could ship message content/PII to Sentry — the single guarantee the whole telemetry port exists to provide. Today only the two legitimate adapter files import it, but nothing *enforces* that.
- **Change:** add a vendored ESLint rule `no-external-sentry` (clone `no-external-cockatiel.mjs`) that bans importing any `@sentry/*` specifier outside `apps/api/src/lib/telemetry/adapters/**`. Wire it `error` in the shared config. Add a test that flags a violation.
- **Why:** the scrub is the only thing preventing plaintext egress to a third party; convention is not enough for a leak of that severity.
- **Touch:** `packages/config/eslint-extensions/rules/no-external-sentry.mjs`, the extensions index, `packages/config/eslint.config.js`, a rule test.
- **Acceptance:**
  - [ ] a fixture `import * as S from '@sentry/cloudflare'` outside the adapter dir errors
  - [ ] the two real adapter imports pass
  - [ ] rule runs in CI lint + pre-push

#### F-02 · Run the real `settle()` inside a DO under workerd · 🔴 · JD-1 / DBI-7 / QB-4
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** N/A — the DO settlement model is new.
- **New (now):** every `*.workers.test.ts` uses scripted fakes (`settlement: () => Promise.resolve()`) or a generic lock-shaped scratch transaction (`runLockValidation`); the real `runSettlement`/`chargeWithinTx`/zero-sum trigger path is exercised **only** under node-env vitest. Driver, `waitUntil`, and connection semantics differ between node and workerd exactly where money settles inside the conversation DO.
- **Change:** add one `vitest-pool-workers` test that drives the **real** settlement (or a faithful multi-leg ledger insert that trips the deferred zero-sum trigger) inside a DO, against managed Neon (not the local proxy — DBI-8), asserting exactly-once + saved⟺billed + the trigger rejecting an unbalanced write.
- **Why:** the money code is verified by reading and adversarially — but never by the production runtime. This closes the largest fidelity gap in the repo.
- **Touch:** `packages/db/src/workers-validation/**` (new test-worker path), a workers-project vitest config, CI wiring.
- **Acceptance:**
  - [ ] a real `runSettlement` (or trigger-tripping multi-leg insert) executes inside a DO under workerd
  - [ ] the deferred zero-sum trigger aborts an unbalanced transaction in that environment
  - [ ] exactly-once holds under a simulated retry/crash in the workers env
  - [ ] runs in CI

#### F-03 · Settlement crash-injection fuzz suite · 🔴 · JD-2
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** N/A.
- **New (now):** the design promises crash-between-every-statement-pair fuzzing of `settle() × retry-claim × cancel`; only **one** deterministic crash point is tested. The "crash recovery by construction" claim rests on that being exhaustive.
- **Change:** build a seeded fuzzer (reuse `seeded-prng.ts`, pass the seed via args since `Math.random` is banned) that injects a crash after each statement in the settlement transaction and, for each, asserts exactly-once and saved⟺billed against real local Postgres, across the retry-claim and user-cancel interleavings.
- **Why:** exactly-once + saved⟺billed is the core money invariant; a single crash point proves almost nothing about the interleaving space.
- **Touch:** `apps/api/src/**/settlement*.integration.test.ts` (new fuzz harness), seeded-prng utility.
- **Acceptance:**
  - [ ] crash injected at every statement boundary of the settlement tx
  - [ ] each interleaving asserts exactly-once + saved⟺billed
  - [ ] deterministic under a fixed seed; seed logged on failure
  - [ ] runs in CI

## 38.2 Tier 1 — Security & money hardening

#### F-04 · KEK → non-extractable IndexedDB wrap · 🟠 · QC-1 / CC-1
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** the monolith persisted the OPAQUE export key the same way (base64 in web storage) — parity, not a regression.
- **New (now):** `persistExportKey` (`auth-client.ts:53-64`) stores `{kek: toBase64(exportKey), userId}` in local/sessionStorage. Any storage read — stolen device/profile, a synced backup, a file-read XSS — plus a session cookie reconstructs the account private key **offline**. Server-side zero-knowledge is intact (the server never sees the KEK); the softening is entirely client-side.
- **Change (ruling: a1, no UX cost, keep-me-logged-in preserved):** generate a **non-extractable** AES-GCM `CryptoKey` (`crypto.subtle.generateKey(..., /*extractable*/ false, ['encrypt','decrypt'])`), store the *key object* in **IndexedDB** (which structured-clones a CryptoKey whose raw bytes JS can never read back). Encrypt the export key under it and persist only `{iv, ciphertext, userId}`. On restore, retrieve the device key from IndexedDB, `decrypt` the export key **into memory** (transient), feed `unwrapAccountKeyWithPassword`, and never persist raw bytes. Preserve keep-signed-in (persistent device key in IndexedDB) vs session (a `sessionStorage` marker that clears the device key + ciphertext on tab close).
- **Why:** closes the dominant threat (static exfiltration of storage) at **zero UX cost**; an attacker who dumps storage now holds only ciphertext + a non-usable key handle. Live in-page XSS remains out of scope — that needs WebAuthn-PRF (a2), deferred by ruling.
- **Touch:** `apps/web/src/lib/auth-client.ts` (`persistExportKey` / `getStoredAuth` / `restoreSession`) + a new small IndexedDB device-key helper.
- **Acceptance:**
  - [ ] raw export key is never written to local/sessionStorage (grep + unit test)
  - [ ] the device key is created with `extractable:false`; a test asserts `exportKey()` on it rejects
  - [ ] keep-signed-in survives a browser-close simulation; session mode is cleared on tab close
  - [ ] full login → refresh → restore round-trip green; auth e2e pass

#### F-05 · Clear plaintext caches on logout / guest-exit · 🟠 · QC-2 / CC-7 / CC-9
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** SPA-teardown behavior differs; treat as new-surface.
- **New (now):** `clearLocalAuthState` (`auth.ts:600-611`) never calls `clearDecryptedMessageCache`, so the module `decryptedCache` of **every viewed message's plaintext** survives SPA sign-out until a tab reload (CC-7). A link-guest's derived private key is never zeroed and its epoch keys + plaintext persist after leaving the share page (CC-9).
- **Change:** make `clearLocalAuthState` call `clearDecryptedMessageCache()`; zero the guest-derived private key and clear the epoch cache on share-page unmount; and force a hard `location.reload()` on both logout and guest-exit to guarantee module-level plaintext is dropped from JS memory.
- **Why:** a reload is the only way to *guarantee* no plaintext lingers in module memory; logout/guest-exit are rare enough to afford it.
- **Touch:** `apps/web/src/lib/auth.ts` (`clearLocalAuthState`), `apps/web/src/hooks/crypto/use-decrypted-messages.ts` (export/wire the clear), `apps/web/src/routes/share.c.$conversationId.tsx` (unmount cleanup), `apps/web/src/lib/link-guest-auth.ts`.
- **Acceptance:**
  - [ ] after logout, `decryptedCache` is empty (test)
  - [ ] after leaving a share page, the guest private key is zeroed and epoch/decrypted caches are cleared
  - [ ] logout and guest-exit trigger a hard reload
  - [ ] no regression in normal navigation (in-conversation route changes do NOT reload)

#### F-06 · Origin check on the WebSocket upgrade · 🟠 · SEC-1 / Q4
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** transport was SSE, governed by CORS — a cross-site page could not open the stream. New WS transport lost that implicit guard.
- **New (now):** the WS upgrade is a `GET` (structurally exempt from the CSRF middleware, which only guards state-changing verbs), the session cookie is `SameSite=None` in production, and CORS does not gate a handshake — so a cross-site page can open an authenticated socket as the victim (bounded only by per-conversation membership + broadcast-time liveness). Adversarially confirmed real.
- **Change:** add an allowlist **Origin** check on the WS upgrade handler that mirrors `csrfProtection`'s allowed-origin set (app origin + configured origins), rejecting a mismatched/missing Origin with a 403 before the upgrade.
- **Why:** closes the cross-site WebSocket-hijacking (CSWSH) class; small, self-contained.
- **Touch:** `apps/api/src/slices/conversations/routes.ts` (the `websocket` upgrade route / `resolveUpgradePrincipal`), reuse the CSRF origin allowlist.
- **Acceptance:**
  - [ ] upgrade from a non-allowlisted Origin → 403
  - [ ] upgrade from the app origin(s) succeeds
  - [ ] a test pins the rejection; native-app origins (Capacitor) are in the allowlist

#### F-07 · Admin Access-expiry → reload re-auth · 🟠 · QA-1 / AS-1
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** N/A — the Access-gated SPA is new.
- **New (now):** in production the dev re-mint is disabled, so an expired Cloudflare-Access cookie makes `/api/*` return a 302→login HTML page that `fetchJson` then `res.json()`-parses into a raw non-`ApiError` throw — every screen renders a static "Failed to load," with no interceptor and no re-auth. The admin is stuck until a manual full reload.
- **Change:** add a `QueryCache`/`MutationCache` `onError` (or a fetch-layer check) that detects the Access-expiry signature — a redirected/opaque response, a non-JSON content-type on a 200, an HTML body, or a 401 — and forces `window.location.reload()`, so Cloudflare re-runs the Access challenge as a navigation.
- **Why:** turns a dead-end generic error into an automatic re-auth; the admin plane is your primary operational surface.
- **Touch:** `apps/admin/src/providers/query-provider.tsx` (add `QueryCache({onError})`), `apps/admin/src/lib/api-client.ts` (surface a distinguishable signal).
- **Acceptance:**
  - [ ] a simulated HTML/302/401 response triggers a reload, not a generic error
  - [ ] a genuine query failure (real `ApiError`) still renders its normal error, no reload loop
  - [ ] guard against reload loops (only reload once per detected expiry)

#### F-08 · Admin SPA security headers · 🟠 · QA-5 / SEC-2
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** N/A.
- **New (now):** the admin document ships **zero** security headers — no CSP, no `X-Frame-Options`, no HSTS; the `headers-vite-plugin` is wired only into `apps/web`, and the admin `wrangler.toml` is assets-only. Access gates authentication, not clickjacking or injection.
- **Change:** wire `headers-vite-plugin` (or an equivalent `_headers`) into `apps/admin/vite.config.ts` so the admin document ships a CSP + `X-Frame-Options: DENY` + HSTS, scoped to the admin origin.
- **Why:** the highest-value target in the system should not be missing the baseline injection/clickjacking defenses the main app has.
- **Touch:** `apps/admin/vite.config.ts`, the shared `scripts/generate-headers.ts` (add an admin route set), CSP tuned to admin's asset/API needs.
- **Acceptance:**
  - [ ] admin responses carry CSP + XFO + HSTS
  - [ ] the admin SPA + SQL panel + Customer-360 still function under the CSP (no console violations)

#### F-09 · CI golden-dump of pg triggers/functions · 🟠 · QB-1 / DBI-5
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** N/A (hand-written triggers are new to the rewrite).
- **New (now):** the `db:generate` drift gate only diffs Drizzle-generated output; Drizzle does not model triggers/functions, so editing or deleting the `ledger_entries_zero_sum` trigger, its `assert_ledger_transaction_balanced` function, or the `search_path` pin produces **no diff and passes CI**. The only guard is the billing integration suite — a test that could be weakened or skipped.
- **Change:** add a CI step that, against the migrated DB, dumps `pg_get_functiondef` + `pg_get_triggerdef` for the money-safety objects and `git diff --exit-code`s them against a committed golden file. Any change to the trigger/function must be an intentional golden-file update.
- **Why:** the double-entry conservation invariant is enforced by that trigger; it must not be silently removable.
- **Touch:** a new `scripts/verify-db-objects.ts` (or a `pnpm` gate), a committed golden dump under `packages/db/`, `ci.yml`.
- **Acceptance:**
  - [ ] deleting/altering the trigger in a branch fails CI with a golden diff
  - [ ] an intentional trigger change updates the golden file and passes
  - [ ] runs in the CI test job against the migrated DB

#### F-10 · Pin the settlement concurrency model · 🟡 · QB-2
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** the monolith's settlement concurrency shape differed; not a direct parity item.
- **New (now):** settlement runs at pg-default READ COMMITTED with **no** 40001 serialization-failure retry; correctness rests entirely on `FOR UPDATE` row locks + the `DEFERRABLE INITIALLY DEFERRED` zero-sum trigger firing at COMMIT. This is sound but **inferred**, asserted nowhere.
- **Change (ruling: confirmed model):** document the model explicitly in ARCHITECTURE §Money, and add a test/assertion that pins it — e.g. an integration test proving two concurrent settlements on the same wallet serialize via the row lock (no lost update, no 40001 surfacing to the caller).
- **Why:** so a future change can't silently switch isolation or drop a lock without a red test.
- **Touch:** ARCHITECTURE.md §Money, a billing concurrency integration test.
- **Acceptance:**
  - [ ] ARCHITECTURE states READ COMMITTED + FOR UPDATE + deferred trigger, no retry
  - [ ] a concurrent-settlement test proves serialization + no lost update

#### F-11 · Cost-circuit trip → Sentry event + documented no-bill · 🟠 · WF-1 / Q9
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** the monolith had no cost circuit; it pre-reserved worst-case cents and settled actual usage — there was no mid-run kill path to bill.
- **New (now):** a cost-circuit trip routes through `finalizeFailed`, which settles **nothing** — the already-incurred provider spend (up to ~`hold×5`) is silently absorbed as platform loss, with no signal. (By contrast a deadline stop settles its billable partial.)
- **Change (ruling: keep no-bill; signal via Sentry, not WAE):** on a cost-circuit trip, emit one Sentry `captureMessage` carrying `runId` + accrued-unbilled nano-USD (aggregate absorbed loss from the events). Document the no-bill posture and the deadline-vs-trip asymmetry in ARCHITECTURE §Money and the deliberate-limits list. Use `captureMessage` (exceptional-but-not-crash), not `captureError`, and do not spam it for routine failures.
- **Why:** a trip means the admission estimate was exceeded 5× — abuse or a systematically-low estimate — which a human should see; and the platform-absorbs posture must be written down and measured.
- **Touch:** `apps/api/src/slices/workflows/engine/interpreter.ts` (the trip path → telemetry), ARCHITECTURE.md §Money + deliberate limits.
- **Acceptance:**
  - [ ] a trip emits exactly one Sentry event with runId + absorbed nano-USD
  - [ ] routine domain failures do NOT emit to Sentry (no SE-3-style spam)
  - [ ] ARCHITECTURE documents no-bill + the deadline-vs-trip asymmetry

#### F-12 · FCM dead-token pruning · 🟠 · QN-1 / NA-1
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** legacy `services/push/fcm.ts` also never parsed per-token errors or pruned — **longstanding parity**, carried forward.
- **New (now):** the FCM adapter checks only `response.ok`, discards the per-token error body, reduces to `{successCount, failureCount}`, and never calls the available `deleteByToken` from the send path — so `device_tokens` grows monotonically with dead/`UNREGISTERED` tokens (wasted FCM calls, rising fan-out cost).
- **Change:** parse the FCM per-message response body; on `UNREGISTERED`/`NOT_FOUND`, prune the offending token via `deleteByToken`. Thread the owning `userId` alongside each token through the send path (it currently holds tokens without their userId), since `deleteByToken(userId, token)` is user-scoped.
- **Why:** stops an unbounded leak and wasted provider calls; the prune primitive already exists.
- **Touch:** `apps/api/src/slices/notifications/adapters/push-fcm.ts` (parse body, return per-token results), `ports/push-sender.ts` (widen `PushDelivery`), `domain/notify-message.ts` / `push-notify.ts` (carry userId, call prune).
- **Acceptance:**
  - [ ] an `UNREGISTERED` response prunes exactly that token
  - [ ] a valid token is untouched
  - [ ] a single bad token still never fails the whole send

#### F-13 · Lift the KeyChain contract into shared · 🟡 · QC-4 / CC-2
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** N/A.
- **New (now):** the client hand-redeclares `KeyChainResponse`/`KeyChainWrap`/`KeyChainLink` (`epoch-key-cache.ts:114-118`) with no compile-time tie to the two server serializers; drift fails **closed** (→ `[decryption failed]`) but only at runtime, and a dead `visibleFromEpoch` field lingers.
- **Change:** define one shared `KeyChainResponse` type/Zod schema in `@hushbox/shared`, have both server serializers and the client import it, and delete the local redeclaration + the dead field.
- **Why:** turns a silent-until-runtime decrypt failure into a compile error; single source of truth for a crypto-load-bearing contract.
- **Touch:** `packages/shared/src/**` (new schema), `apps/web/src/lib/epoch-key-cache.ts`, `apps/api/src/slices/conversations/domain/keychain.ts`.
- **Acceptance:**
  - [ ] client + both server serializers reference the one shared type
  - [ ] a deliberate field rename breaks typecheck
  - [ ] dead `visibleFromEpoch` removed

#### F-14 · Client media size-guard before decrypt · 🟡 · QC-5 / CC-4
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** N/A.
- **New (now):** media decrypt buffers the entire ciphertext (`arrayBuffer()`) then the entire plaintext with no pre-fetch size check; a hostile/oversized blob is bounded only by R2's write-time cap.
- **Change:** read the content-item `sizeBytes` metadata and reject before fetch/decrypt if it exceeds a client ceiling (mirroring the server media cap); stream or hard-cap otherwise.
- **Why:** bounds browser memory and defends the client against an oversized blob independent of server trust.
- **Touch:** `apps/web/src/hooks/crypto/use-decrypt-blob.ts`.
- **Acceptance:**
  - [ ] an over-ceiling item is rejected before fetch with a clear error
  - [ ] normal media decrypts unchanged

#### F-15 · Arch rule pinning demo isolation · 🟡 · QM-6 / DM-6
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** N/A.
- **New (now):** the demo's fake session + global fetch-shim are isolated only by the `isDemoPath` dynamic-import convention; **no** lint/arch rule prevents a static import of `src/demo/**` (esp. `seed-session`, `fetch-shim`) from pulling the bypass into the production main chunk. (Verified no live leak today.)
- **Change:** add a `no-restricted-imports`/boundaries rule banning any static import of `apps/web/src/demo/**` outside `main.tsx`'s dynamic import + tests.
- **Why:** makes the isolation structural so a future refactor can't silently bundle the fake-auth path into production.
- **Touch:** `packages/config/eslint.config.js` (or a vendored rule), a rule test.
- **Acceptance:**
  - [ ] a static `import … from '.../demo/seed-session'` in prod code errors
  - [ ] `main.tsx`'s dynamic import + demo-internal imports pass

#### F-16 · Redirect standalone `/demo` → `/welcome` · 🟡 · QM-1 / DM-1
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** N/A.
- **New (now):** `/demo` and `/demo/*` are production-reachable first-class routes; a direct visit gets a bare framed SPA with a fake logged-in session, outside the intended `/welcome` iframe.
- **Change:** redirect a top-level (non-iframed) `/demo` navigation to `/welcome`; keep it working when embedded as the same-origin iframe.
- **Why:** a bare fake-logged-in SPA at a public URL is confusing for a privacy product; demo should only exist inside `/welcome`.
- **Touch:** demo bootstrap (`apps/web/src/demo/bootstrap.tsx`) or a marketing redirect; detect top-level vs framed (`window.top === window`).
- **Acceptance:**
  - [ ] direct `hushbox.ai/demo` → `/welcome`
  - [ ] the `/welcome` iframe still renders the demo

## 38.3 Tier 2 — Product rulings

#### F-17 · Keyed epoch confirmation · 🟡 (do EARLY — see Why) · Q2 / CR-3
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Background:** when a conversation rotates keys (a new "epoch"), every member re-derives the new epoch private key; a stored **confirmation hash** lets a member verify they derived the correct key without revealing it.
- **Legacy:** legacy also used a bare `sha256(epochPrivateKey)` — parity.
- **New (now):** the live path uses the bare `confirmationHash = sha256Hash(epoch.privateKey)` (`packages/crypto/src/epoch-lifecycle.ts:38,54`). A stronger, HKDF-keyed, domain-separated `computeEpochConfirmation(epochPrivateKey, conversationId, epochNumber)` already exists (`packages/crypto/src/epoch.ts:32`, exported at `index.ts:63`) but has **zero callers**.
- **Change:** switch `epoch-lifecycle.ts` to call `computeEpochConfirmation` (and `verifyEpochConfirmation`); update the client's `verifyEpochKeyConfirmation` to match; delete the bare-hash path. TDD.
- **Why:** the keyed HKDF construction is the correct "prove-you-have-the-key" primitive (domain separation binds the confirmation to this conversation + epoch); the bare hash is a code-smell, not a live vuln. **Do this before real users exist** — with zero users there are no stored confirmation hashes to migrate; after launch, changing the algorithm means re-confirming every epoch of every conversation.
- **Touch:** `packages/crypto/src/epoch-lifecycle.ts`, `apps/web` epoch-confirmation verify site, tests in `packages/crypto`.
- **Acceptance:**
  - [ ] epoch create + rotation store the keyed confirmation
  - [ ] the client verifies against the keyed value; a wrong key fails closed
  - [ ] the bare `sha256Hash(privateKey)` path is deleted (grep clean)

#### F-18 · Delete-account lockout split window · 🟡 · Q3 / RL-2
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** legacy had **two** mechanisms — `deleteAccountUserRateLimit` (3 attempts / 1h) **plus** a separate 24h `deleteAccountLockout` (`origin/main` redis-registry.ts).
- **New (now):** the two were merged into a single `deleteAccountLockout` `{maxAttempts:3, windowSeconds:86_400}` (`apps/api/src/slices/identity/domain/keys.ts:217`) — 3-in-24h, so one fumbled sequence freezes account deletion for a full day. The new-code comment documents the collapse.
- **Change:** restore the split: a tight **3-attempts/1h** guessing gate + a separate **24h lock** that engages after repeated failure (legacy's two-key shape). Use the atomic increment-before-verify limiter class (the §11 secret-guessing pattern).
- **Why:** keeps the guessing defense tight while making the day-long lock a deliberate consequence of *repeated* abuse, not a hair-trigger.
- **Touch:** `apps/api/src/slices/identity/domain/keys.ts` (two keys), `identity/domain/deletion.ts` (evaluate both), tests.
- **Acceptance:**
  - [ ] 3 fast failures within 1h → short lockout; window resets after 1h
  - [ ] repeated failures escalate to a 24h lock
  - [ ] concurrency: exactly `maxAttempts` admitted under parallel attempts

#### F-19 · Bump cassette version to v2 · 🟠 · Q6 / CAS-1
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Background:** cassettes are recorded OpenRouter request/response pairs replayed in CI. A request is matched by hashing a canonical descriptor including an **allowlist of headers**.
- **Legacy:** legacy's allowlist included the Vercel gateway's `ai-model-id` header.
- **New (now):** the allowlist is now `{'content-type','accept'}` (`apps/api/src/slices/models/adapters/cassette/canonical-request.ts:44`) because OpenRouter carries the model id in the *body* — but `AI_RECORDING_VERSION` is still `'v1'` (`cassette-store.ts:33`). So the hash function changed under a stale version tag: old v1 cassettes miss, which (correctly) fails CI rather than making a real charged call — but the store's own rule says to bump on a match-key change.
- **Change:** bump `AI_RECORDING_VERSION` to `'v2'`; re-record the cassettes **out-of-band** (recording is a deliberate step; CI fail-on-miss is already correct and unchanged); commit the new `.ai-cassettes/v2/` directory. Read `docs/CI-CASSETTES.md` first.
- **Why:** the store documents "when to bump the version" for exactly this case; a clean v2 directory retires v1 without confusion.
- **Touch:** `apps/api/src/slices/models/adapters/cassette/cassette-store.ts:33`, `.ai-cassettes/`.
- **Acceptance:**
  - [ ] `AI_RECORDING_VERSION = 'v2'`
  - [ ] CI replays 100% from `v2/` cassettes (warm cache, zero real calls)
  - [ ] `verify:evidence` still passes

#### F-20 · Distinct password-reset email subject · 🟡 · Q11 / EM-2
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** legacy's recovery-reset sent subject **"Your password was reset"** (`origin/main` opaque-auth.ts ~1625).
- **New (now):** the recovery-**reset** finish path reuses the password-**changed** port, whose subject is the hard-coded `PASSWORD_CHANGED_EMAIL_SUBJECT = 'Your password was changed'` (`apps/api/src/adapters/password-changed-email.ts:6,25`). A user who just reset via recovery phrase gets "changed," which reads as alarming. This is the one confirmed behavioral regression.
- **Change:** add a reset-specific subject + template and wire the recovery-reset finish path (`identity/routes.ts` ~712) to it instead of the shared changed-password port.
- **Why:** honest, non-alarming copy after a deliberate reset.
- **Touch:** `apps/api/src/adapters/` (new reset-email port/subject), `apps/api/src/slices/notifications/domain/templates/` (new template), `identity/routes.ts` binding.
- **Acceptance:**
  - [ ] recovery-reset sends "Your password was reset" (or agreed copy)
  - [ ] change-password still sends "Your password was changed"

#### F-21 · Overlay/Sheet overflow hardening in primitives · 🟠 · Q16 / UI-1 / UI-2
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** N/A (shared UI library is new).
- **New (now):** `DialogContent` was hardened with `max-h-[calc(100dvh-2rem)] overflow-y-auto` (`packages/ui/src/components/dialog.tsx:63`), but the sibling primitives were not: `SheetContent` (`sheet.tsx:56-66`) and the custom desktop `OverlayDialog`/`OverlayContent` (`overlay-dialog.tsx:62`, `overlay-content.tsx:29`) have no max-height/overflow — tall content pushes actions off-screen and no consumer can un-forget it.
- **Change:** push the Dialog `max-h`/`overflow-y-auto` guarantee down into `SheetContent`, `OverlayDialog`, and `OverlayContent` as a primitive-level invariant + tests.
- **Why:** primitives should carry the invariant so every consumer inherits it; matches the Dialog precedent.
- **Touch:** `packages/ui/src/components/sheet.tsx`, `.../overlay-dialog.tsx`, `.../overlay-content.tsx`, tests.
- **Acceptance:**
  - [ ] content taller than the viewport scrolls inside each primitive; actions stay reachable
  - [ ] a test asserts the overflow behavior per primitive

#### F-22 · Delete dead invert-colors scaffolding · 🟡 · Q12 / UI-3
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** N/A.
- **New (now):** `<Img>` and `<Logo>` emit `data-no-invert` and `<Img>` has a `decorative` prop documented as "invert-colors mode skips re-inverting" — but there is **no** invert-colors toggle in the accessibility schema, **no** `[data-no-invert]` CSS selector, and **no** `invert()` filter anywhere. The attribute guards a feature that doesn't exist.
- **Change:** remove the `data-no-invert` emission from `Img`/`Logo` and the invert-related docstrings. **Preserve** any genuine decorative-image screen-reader semantics (e.g. `aria-hidden`/empty `alt`) — remove only the dead invert plumbing. Verify whether `decorative` has any non-invert effect before deleting the prop.
- **Why:** dead mechanism is doc-debt; the invert feature is not on the roadmap.
- **Touch:** `packages/ui/src/components/img.tsx`, `.../logo.tsx`.
- **Acceptance:**
  - [ ] no `data-no-invert` in the tree; no invert docstrings
  - [ ] decorative images retain their a11y semantics (if any existed)

#### F-23 · Restore error-code granularity (3 targets) · 🟡 · Q5 / ENV-9
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Background:** the wire error taxonomy was narrowed **128 → 81** codes; the new backend returns typed `DomainError` (8 kinds) mapped to wire codes. Payment-decline granularity **never existed** in legacy (one `PAYMENT_DECLINED` + free text), so that piece is net-new, not a restore. The full flattening map is in §5/§10 (ENV-9).
- **Change — three targeted items:**
  1. **Media-modality errors:** wire the already-defined `UNSUPPORTED_MODALITY` (`packages/shared/src/error-codes.ts:31`, currently **zero emit sites**) and restore `UNSUPPORTED_RESOLUTION` / `UNSUPPORTED_DURATION` / `MISSING_MODALITY_CONFIG` / `AUDIO_DISABLED` — the user-facing copy already exists in the legacy map; today these collapse to a generic "Invalid input."
  2. **Streaming errors:** re-classify streaming failures to emit `CONTENT_POLICY` / `CONTEXT_LENGTH_EXCEEDED` / `NETWORK_ERROR` (copy exists at `error-messages.ts:87,91,92`) instead of only `STREAM_ERROR`/`CHAT_STREAM_FAILED`.
  3. **Payment decline reason (net-new):** build a structured `declineReason` enum from the already-captured Helcim `responseMessage` (`billing/adapters/payment-helcim.ts:104-115`).
- **Why:** each restored code tells the user a *different* action ("pick another resolution," "switch to a larger-context model," "card declined vs insufficient funds"); the generic collapse loses that. Leave payment-lifecycle/storage/not-found flattened (all → "retry/refresh/support").
- **Touch:** media slice emit sites, chat streaming error classification, billing decline mapping; add the codes to `error-codes.ts` + `friendlyErrorMessage` and the shared error schema (per CODE-RULES "new error codes need: constant + friendly-message entry").
- **Acceptance:**
  - [ ] each new code is emitted at its real site + has friendly copy
  - [ ] a bad-resolution media request surfaces `UNSUPPORTED_RESOLUTION`, not `VALIDATION`
  - [ ] a policy-refused stream surfaces `CONTENT_POLICY`
  - [ ] a declined payment carries a structured `declineReason`

#### F-24 · Remove the redundant trial 20/60s burst · ⚪ · Q1 / RL-1
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Background (premise corrected):** the audit first claimed the per-identity 5/day trial quota was dropped — **it was not.** `consumeTrialQuota` enforces `Math.max(sessionCount, ipCount) ≤ TRIAL_MESSAGE_LIMIT(=5)` (`chat/domain/trial-quota.ts:68-83`), live at `routes.ts:1112`. The 20/60s per-IP burst (`consumeTrialBurst`, `rate-limit.ts:23`, `routes.ts:1091`) and a $50/day global pool are additive.
- **Change:** remove **only** the 20/60s per-IP burst (`TRIAL_BURST_RATE_LIMIT` + `consumeTrialBurst` + its call site). Keep the 5/day quota and the $50 pool.
- **Why:** the burst is **already redundant** — a per-IP cap of 5/day means 20-in-60s from one IP is unreachable; removing it is pure cleanup, no behavior change.
- **Touch:** `apps/api/src/slices/chat/domain/rate-limit.ts` (delete the burst key/fn), `chat/routes.ts:1091` (remove the call), its tests.
- **Acceptance:**
  - [ ] burst key + `consumeTrialBurst` removed; trial send path still gated by the 5/day quota
  - [ ] trial e2e still green

#### F-26 · Fix OTA advertise-before-publish ordering · 🟠 · QD-3 / DP-1
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** N/A (OTA is new).
- **New (now):** in `.github/workflows/ci.yml` the `deploy` job sets the `APP_VERSION` secret and deploys the API worker (`:758`, `:825`) **before** it uploads the R2 bundle and mints the per-platform `APP_BUNDLE_CHECKSUM_*` (`:876`, `:885`); the checksum isn't version-keyed. In the gap, `/updates/current` advertises `{version: NEW, checksum: OLD}` and `/updates/download/…/NEW` 404s.
- **Change:** reorder the deploy job so the R2 bundle upload + checksum mint happen **before** `APP_VERSION` is set / the worker deploys (or version-key the served checksum so a mismatch is impossible). Publish artifacts first, promote the version last.
- **Why:** so `/updates/current` never advertises a version whose bundle/checksum isn't live — mobile auto-update won't 404 or fail integrity mid-deploy.
- **Touch:** `.github/workflows/ci.yml` (deploy job step order).
- **Acceptance:**
  - [ ] R2 bundle + checksum exist before `APP_VERSION` flips
  - [ ] a deploy dry-run shows `/updates/current` never advertises an undownloadable version

#### F-27 · Health check → real host + version assert · 🟡 · QD-4 / DP-5
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** N/A.
- **New (now):** the post-deploy check is `sleep 10; curl -f https://hushbox-api.<subdomain>.workers.dev/health` (`ci.yml:857-860`) — the `workers.dev` subdomain, not the production custom domain `api.hushbox.ai`, and it asserts nothing about version/OTA/DB.
- **Change:** point the health check at `api.hushbox.ai` and assert version/OTA readiness (e.g. `/updates/current` returns the just-deployed version with a live checksum). Consider making failure gate the tag/OTA steps.
- **Why:** test the actual production host and the thing that just changed.
- **Touch:** `.github/workflows/ci.yml` (health step).
- **Acceptance:**
  - [ ] health check hits `api.hushbox.ai`
  - [ ] it asserts the deployed version is serving + OTA is coherent

#### F-28 · Admin root error boundary · 🟠 · QA-2 / AS-2
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** N/A.
- **New (now):** the admin router has no `defaultErrorComponent`/`defaultNotFoundComponent` (`apps/admin/src/router.tsx:10-13`) and no React error boundary in `__root.tsx` — a render throw outside a TanStack query blanks the SPA.
- **Change:** add a router `defaultErrorComponent` + `defaultNotFoundComponent` and a root React error boundary that degrades to a readable message.
- **Why:** a shell/provider throw shouldn't blank the admin console.
- **Touch:** `apps/admin/src/router.tsx`, `apps/admin/src/routes/__root.tsx`.
- **Acceptance:**
  - [ ] a thrown render error shows a fallback, not a blank page
  - [ ] an unknown route shows a not-found component

#### F-29 · Admin zod `validateSearch` · 🟡 · QA-3 / AS-3
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** N/A.
- **New (now):** three admin routes hand-roll `typeof` guards for search params instead of zod (`customer-360.tsx:13`, `audit.tsx:27`, `feedback.tsx:38`) — invalid values silently coerce; the admin's own CLAUDE.md mandates shared-Zod.
- **Change:** replace the `typeof` guards with zod `validateSearch` schemas (shared with the server's query validators where possible).
- **Why:** consistency with the mandated convention; invalid search params get schema-rejected, not silently coerced.
- **Touch:** the three admin route files, shared search schemas.
- **Acceptance:**
  - [ ] all three routes use zod `validateSearch`
  - [ ] invalid params are rejected/normalized per schema

#### F-30 · `waitUntil` on DO terminal duties · ⚪ · QR-2 / RT-4
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** N/A.
- **New (now):** there is no `ctx.waitUntil` anywhere in `packages/realtime`; the run continuation (`watchRun`) and terminal best-effort duties (`releaseHold`/`failRun`/`notify` in `finishRun`) ride bare `void` promises. Correctness is safe (the in-flight executor keeps the DO resident; every duty is backstopped by hold-TTL / key-lease), so this is defense-in-depth, not a defect.
- **Change:** wrap the terminal duties + `watchRun` continuation in `ctx.waitUntil` for a contractual flush guarantee before isolate reclaim.
- **Why:** guarantees the hold-release/push flush without relying on the executor keeping the isolate alive — cheap insurance.
- **Touch:** `packages/realtime/src/room-core.ts` (`finishRun`, `watchRun` launch).
- **Acceptance:**
  - [ ] terminal duties run under `ctx.waitUntil`
  - [ ] no behavior change on the happy path; tests green

#### F-31 · v4→v7 user ids (separate OPAQUE id) · 🟠 · QB-3 / DBI-10
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Legacy:** legacy also minted v4 user ids at registration — parity, not a regression.
- **New (now):** `users.id` is app-side v4 `crypto.randomUUID()` (`apps/api/src/slices/identity/domain/registration.ts:118`), minted to bind OPAQUE `registerInit` before the row exists — overriding the schema's `uuidv7()` default (`users.ts:12`). Every **other** PK uses DB-side `uuidv7()`. So the most-joined table loses B-tree insert locality + time-ordering.
- **Change:** give the OPAQUE binding a **separate ephemeral id** and let `users.id` keep the `uuidv7()` default (either DB-generated on insert, or an app-side `uuidv7()` if the id must be known pre-insert). Verify the OPAQUE flow only needs a stable identifier, not specifically the PK.
- **Why:** cheap now (zero users), a permanent locality/ordering win on the hottest table; the OPAQUE binding needn't *be* the primary key.
- **Touch:** `apps/api/src/slices/identity/domain/registration.ts`, `identity/adapters/stores.ts` (insert), possibly the OPAQUE identity binding.
- **Acceptance:**
  - [ ] `users.id` is v7 (time-ordered)
  - [ ] OPAQUE registration/login still bind correctly via the separate id
  - [ ] registration integration + auth e2e green

## 38.4 Tier 3 — Structural: observability, billing, legacy

#### F-32 · Tear down WAE; Sentry + Workers Logs only · 🟠 · Q10 / SE-2
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Background:** telemetry is one `Telemetry` port (`apps/api/src/lib/telemetry/port.ts`) with adapter fan-out: a **Sentry** adapter (`captureError`; `emitMetric` is a no-op), a **WAE** adapter (`emitMetric` → `writeDataPoint`; everything else inert), and a **console/Workers-Logs** adapter.
- **Legacy:** N/A (this telemetry shape is new).
- **New (now):** four `emitMetric` sites feed WAE, and **none has a live watcher** (the WAE SQL auditor was never built): `realtime_ws_upgrade_failure` + `realtime_billable_generation` (`conversations/adapters/realtime-room-bindings.ts:128,131`), `jobs_queue_depth` + `jobs_oldest_pending_age_seconds` (`jobs/jobs-health-entry.ts:67,69`). The jobs metrics are already redundant with a Sentry `captureError('jobs stuck past health bounds')` on the next line (`:79`); the realtime ones are deferred analytics.
- **Change (ruling):** remove the WAE adapter (`wae-adapter.ts`) and all four `emitMetric` call sites. Collapse alerting to **Sentry** (defects + the F-11 cost-circuit event) + **structured Workers Logs** (the audit trail). Delete the "every metric names its watcher" rule (it's moot). Stop paging Sentry for expected catalog conditions (SE-3 → downgrade to a Workers-Log line/digest). Update ARCHITECTURE §Observability + TECH-STACK (drop the WAE row) **in the same change**; add a documented re-entry condition (add PostHog or WAE+SQL-watcher when aggregate/business measurement is needed). **Consciously accepted:** `realtime_ws_upgrade_failure` (the fallback-transport re-entry signal) becomes instrument-on-demand.
- **Why:** you don't have two error systems in code — you have one port with a WAE adapter that feeds an unbuilt watcher. Removing it collapses alerting to one pager (Sentry) + one record (Workers Logs), both already built, and deletes the half-built SQL-auditor plan. Aggregate analytics is already deferred (PostHog), so nothing needed is lost.
- **Touch:** delete `apps/api/src/lib/telemetry/adapters/wae-adapter.ts` + its wiring; remove the 4 `emitMetric` calls; `docs/ARCHITECTURE.md` §Observability; `docs/TECH-STACK.md` (WAE row + re-entry note); `packages/config` (drop the never-shipped metric-watcher arch rule if any).
- **Acceptance:**
  - [ ] no `emitMetric` call sites remain; WAE adapter deleted
  - [ ] the `Telemetry` port compiles without the WAE sink (or `emitMetric` removed from the interface)
  - [ ] ARCHITECTURE + TECH-STACK updated with the re-entry condition
  - [ ] jobs-stuck still pages via Sentry (unchanged)

#### F-33 · Billing decision functional-core refactor · 🟠 · Q17 / GB-1
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Background:** two billing decisions — *who pays* a chat turn and *whether a premium model is allowed* — currently live in two places with no compile-time link (drift risk). Full design is §35; read it before starting.
- **Legacy + web:** use the shared `packages/shared/src/resolve-billing.ts` ("the one function both frontend and backend call").
- **New server (now):** re-implements both decisions natively — `resolvePayerWallet` (`apps/api/src/slices/chat/domain/turn-context.ts:311-360`) and `tierGateRejection` (`chat/routes.ts:483-505`) — and never calls `resolveBilling`. So the decision logic is duplicated client vs server.
- **Change (functional core / imperative shell):** extract a **pure** `resolveFundingDecision(inputs) → decision` into `packages/shared` over primitive inputs (member/conversation/owner/caller balances + `isPremium`), no DB/IO. The chat slice resolves those primitives from the DB (its job) and calls the core; the client resolves them from its endpoints and calls the **same** core. Retire the fat `resolveBilling`. Add a **contract test** feeding the §2.K funding-scenario matrix through both sides asserting identical decisions. Behavior-preserving — existing billing integration + e2e stay green.
- **Why:** deduplicates without fighting the slice (the slice keeps all data access + the `SettlementTx`; only pure branching moves out — exactly what `packages/shared` is for). The contract test makes future client↔server drift a test failure instead of a silent divergence.
- **Touch:** new `packages/shared/src/billing/funding-decision.ts`, `chat/domain/turn-context.ts`, `chat/routes.ts` (tier gate), `apps/web/src/hooks/billing/use-prompt-budget.ts` / `use-resolve-billing.ts`, delete/retire `resolve-billing.ts`, a new contract test.
- **Acceptance:**
  - [ ] one pure `resolveFundingDecision` in shared; no DB/IO in it
  - [ ] server + client both call it; `resolveBilling` retired
  - [ ] contract test covers the full §2.K matrix, both sides agree
  - [ ] no behavior change (billing integration + e2e green)

#### F-34 · De-legacy the new code (sever all live edges) · 🟠 · §37 Phase 0 — **prerequisite for F-35**
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Why this is first:** the legacy corpus cannot be quarantined (F-35) until **no new code imports anything named/located "legacy."** These four live edges were confirmed by grep this audit; each must be severed. Several overlap already-approved fixes (F-23, F-32-adjacent). Do this before F-35.
- **Edges to sever (all verified live):**
  1. **`legacyFriendlyErrorMessage` / `LegacyErrorCode`** — imported by 5+ new web files (`payment-form.tsx:8`, `media-preview.tsx:5`, `trial-chat-page.tsx:3`, `message-item.tsx:5`, `error-boundary.tsx`) + `packages/ui/src/hooks/use-async-action.ts`. **Fix:** finish the `friendlyErrorMessage` migration (ties to F-23), make the new wording canonical, then delete the legacy-named exports from `packages/shared/src/error-messages.ts` (QN-4). `PREMIUM_REQUIRES_BALANCE` is already dead outside legacy — retire its orphaned map entry.
  2. **`LegacyModality`** — the type backing all of `apps/web/src/stores/model.ts`. **Fix:** rename to `Modality` (or the proper new modality type) in `packages/shared` + the web store.
  3. **`packages/shared/src/enums.ts` live schemas** (`memberPrivilegeSchema`, `paymentStatusSchema`, `MEMBER_PRIVILEGES`, `MESSAGE_ROLES`) — imported by new conversation/billing schemas (DUP-1). **Fix:** migrate consumers to `member-privilege.ts` / `schemas/api/*`, then `enums.ts` is dead. (Note: the DB pgEnum file `packages/db/src/schema/enums.ts` is a *different*, live, keep file — do not touch.)
  4. **Vercel-gateway remnants** (`PUBLIC_MODELS_URL` + `fetchModels`/`toRawModel`/`clearModelCache` in `packages/shared/src/models/fetch.ts`) — OR-2/DEAD-1, also in `wrangler.toml:58` + `ci.yml:701`. **Fix:** delete the env entry + functions + the wrangler/ci references. Verify the VEO helpers (`getSupportedVideo*`) are legacy-only (grep suggested so) — if any are live in web, migrate to catalog-derived data first (OR-1); otherwise they move out with legacy.
- **Why:** "new code doesn't know about legacy" is only true once nothing new depends on a legacy name or path.
- **Touch:** the files above; run the exit-gate grep after.
- **Acceptance:**
  - [ ] `grep -rn "legacy" apps packages --include=*.ts` over NEW-code dirs returns only comments, no imports
  - [ ] `legacyFriendlyErrorMessage`, `LegacyModality`, `enums.ts` legacy schemas, `PUBLIC_MODELS_URL` + `fetchModels` trio all deleted
  - [ ] typecheck + tests green after each sever

#### F-35 · Quarantine the legacy corpus to `/legacy/` · 🟠 · §37 — **needs F-34 done first**
**Status:** ⬜ not-started · **Owner:** — · **PR:** — **Blocked-by:** F-34
- **Ruling:** move the legacy corpus into a repo-root `/legacy/` directory that no tool or doc knows about — kept (not deleted), version-controlled, but invisible to typecheck, lint, test, coverage, knip, jscpd, arch. History docs (`docs/history/**` + this audit + `BACKEND-REDESIGN.md`) are **not** touched.
- **What moves (the true dead corpus):** `apps/api/src/legacy/**` (the whole old monolith), `packages/db/src/legacy_*` + `packages/db/src/legacy-zod/**`, `packages/realtime/src/legacy_conversation-room.ts` (+ test) [this resolves QR-3], `scripts/lib/legacy_seed.ts` + `legacy_seed-cache.ts` (+ tests), and any `legacy_*` test-fixtures used only for the boundaries rule.
- **Plan:**
  1. **Move** all of the above to repo-root `/legacy/` (preserve internal structure so it still cross-compiles as a reference if ever needed).
  2. **Blind every tool:** ensure `/legacy/` is NOT a `pnpm-workspace.yaml` package; remove it from every `tsconfig` include/references (no typecheck); remove from every `eslint.config.js` (no lint) and delete the now-dead per-package `legacy_*`/`src/legacy/**` ignore globs; remove the `exclude` legacy entries from the vitest configs; remove from knip/jscpd/arch scope.
  3. **Keep one tripwire:** repoint the `no-legacy-imports` lint rule to ban importing from `/legacy/`, and update its `packages/config/__test-fixtures-boundaries__` fixture — so no new code can ever wire the archive back in.
  4. **Purge docs (current/loaded only):** strip the `legacy_`-prefix rules from `docs/CODE-RULES.md` (§Durable Naming), the "compiling reference corpus" line from `docs/TECH-STACK.md`, and any legacy mentions in `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`, `docs/AGENT-RULES.md`, `apps/api/CLAUDE.md`. **Do NOT touch** `docs/history/**`, this audit, or `BACKEND-REDESIGN.md`.
- **Why:** the rewrite is essentially done (this audit is the parity record), so the corpus's day-to-day reference value is spent; quarantining removes it from every gate and the new-code mental model while keeping it recoverable.
- **Acceptance:**
  - [ ] all listed legacy files live under `/legacy/`; none remain in `apps/*`/`packages/*`/`scripts/*`
  - [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `arch:check`, knip, jscpd all pass with `/legacy/` entirely out of scope
  - [ ] `no-legacy-imports` blocks importing from `/legacy/` (tripwire test)
  - [ ] loaded docs contain no `legacy_`/legacy-corpus language; history docs untouched

## 38.5 Tier 4 — Minor cleanups

#### F-36 · Fix seed-cache gitignore comment + regenerate once · ⚪ · QS-1
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **Background:** `scripts/.cache/seed-crypto/` holds 244 committed OPAQUE crypto fixtures. It's a **pure performance cache** — a cache *hit* is a pure read/reuse (`seed-crypto-cache.ts:129-149`), a *miss* regenerates valid bytes. The key is `sha256(cacheVersion ∥ cryptoFingerprint ∥ sha256(masterSecret) ∥ sha256(password) ∥ credentialIdentifier)`; four inputs are shared committed constants (incl. the dev/CI `OPAQUE_MASTER_SECRET`), so **CI and matching-secret devs get 100% hits — it works, as it did in legacy.**
- **New (now):** the `git status` churn (163 M / 81 D / 82 ??) is the cache **correctly self-invalidating** because the backend rewrite changed `packages/crypto` (the `cryptoFingerprint`). The only real defects: (a) the `.gitignore:99-103` comment "Nothing produces new files (the seed:cache script is gone)" is **factually false** (the live seed writes on every miss), and (b) regeneration is non-deterministic (`x25519.keygen()` is random) so a dev with a *different* master secret churns locally.
- **Change (ruling: keep the cache):** fix the false `.gitignore:99-103` comment; once `packages/crypto` stabilizes, run the seed and **commit the regenerated cache once** so CI + matching-secret devs return to clean hits.
- **Why:** the caching system is fine and working as designed — do NOT gitignore it. Only the comment is wrong and the cache is mid-invalidation from the rewrite.
- **Touch:** `.gitignore` (the comment), a one-time cache regen commit.
- **Acceptance:**
  - [ ] `.gitignore` comment accurately describes that the live seed writes on cache miss
  - [ ] a clean regen is committed; a fresh `pnpm db:seed` on a matching-secret machine leaves `git status` clean

#### F-37 · `git rm --cached scripts/.cache/local/` · ⚪ · QS-2
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **New (now):** 4 runtime-state files under `scripts/.cache/local/` are git-**tracked** despite `.gitignore:108` ignoring the dir (gitignore can't untrack), so they churn as `D` in status.
- **Change:** `git rm -r --cached scripts/.cache/local/` and commit; the ignore rule then holds.
- **Touch:** git index only.
- **Acceptance:**
  - [ ] `git ls-files scripts/.cache/local/` returns nothing; the dir stays ignored

#### F-38 · Refresh stale seed docstrings · ⚪ · QS-3
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **New (now):** docstrings say "no seed phase" / "db:seed fails fast" (`ensure-stack.ts:18-19,82-85`) although a full live seed runs in `pnpm dev` (`package.json:9`, `scripts/seed.ts`). `TRACKED_TABLES=[]` (`ensure-stack-cli.ts:34`) disables re-seed dirty-tracking (ruling: keep idempotent-mint-always).
- **Change:** update the stale docstrings to describe the live seed + idempotent-mint model; leave `TRACKED_TABLES=[]` (idempotent mint is intended).
- **Touch:** `scripts/lib/ensure-stack.ts`, `scripts/ensure-stack-cli.ts` (comments only).
- **Acceptance:**
  - [ ] docstrings match reality (live seed, idempotent mint)

#### F-39 · Purge stray capture debris + guard · ⚪ · QM-4 / DM-4
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **New (now):** two auto-named Playwright-MCP screencasts `page@093a2bd8….webm` and `page@819b80dd….webm` are committed via LFS under `ads/2026-07-hq-tour/03-screen-capture/` (alongside the intentional takes).
- **Change:** remove both from tracking (`git rm`) and add a `.gitignore`/guard for `page@*.webm` under `ads/` so auto-named captures can't be committed again.
- **Touch:** git index, `ads/.gitignore` (or root).
- **Acceptance:**
  - [ ] the two `page@*.webm` files are gone; a new `page@*.webm` is ignored

#### F-40 · Delete dead `generate-og-image.ts` · ⚪ · QS-5
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **New (now):** `scripts/generate-og-image.ts` (+ test) is dead **new** code — a never-wired OG-image generator with no `pnpm`/workflow consumer (it is NOT legacy, so it does not go to `/legacy/`).
- **Change (ruling: delete if dead):** confirm no consumer (grep `pnpm`/workflows/imports), then delete the script + its test. If a future OG-image feature is actually wanted, leave a one-line note in `docs/DEVELOPMENT.md` instead — otherwise delete outright.
- **Touch:** `scripts/generate-og-image.ts` (+ test).
- **Acceptance:**
  - [ ] confirmed zero consumers, then deleted; build green

## 38.7 Consolidated items (F-41–F-70)

Folded in from the former top "Improvement backlog" so the §38.0 board is the single source of truth. F-41/F-42 are two founder rulings that were missed in the first pass; F-43–F-56 are audit findings not yet turned into a founder question (mostly clear "just do it" fixes); F-57–F-70 are the minor/hygiene tier. **The four genuine decision-items were ruled on 2026-07-19: F-49 full refactor · F-55 deferred · F-60 relocate · F-66 delete. The remaining 24 are accepted for scheduling (no decision needed).** `⏸` on the board = deferred.

#### F-41 · Store deep-link files: deploy substitution + CI guard · 🟠 · Q14 / MK-1
**Status:** ⬜ not-started · **Owner:** — · **PR:** — · **Blocked-by:** founder must supply certs
- **New (now):** the AASA / assetlinks files ship literal placeholders — `appIDs:["TEAMID.ai.hushbox.app"]` and `sha256_cert_fingerprints:["PLACEHOLDER_SHA256_FINGERPRINT"]` (`apps/marketing/public/.well-known/*`) with no substitution — so iOS Universal Links + Android App Links verification will fail in production.
- **Change (ruling: a):** template the two files; substitute the real Apple Team ID + Android release signing SHA-256 from secrets at deploy; add a CI guard that fails the prod deploy if `TEAMID`/`PLACEHOLDER_SHA256_FINGERPRINT` remain.
- **Why:** broken deep-link association silently breaks app-open flows in production.
- **Needs you:** the real Apple Team ID + release signing fingerprint (the one input the audit can't derive).
- **Touch:** `apps/marketing/public/.well-known/*`, deploy job in `ci.yml`.
- **Acceptance:** [ ] real values substituted at deploy [ ] CI fails if a placeholder remains [ ] AASA/assetlinks validate against the shipped app id

#### F-42 · Gate Android WebView debugging to dev · 🟠 · Q15 / MK-2
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **New (now):** `webContentsDebuggingEnabled: true` is baked into the built Android release config (`apps/web/capacitor.config.ts:14`), i.e. WebView remote debugging is on even in release builds.
- **Change (ruling: a):** gate it to dev builds (false for release), off the build mode/platform.
- **Why:** release WebView remote debugging is a real attack convenience.
- **Touch:** `apps/web/capacitor.config.ts` (conditional on build mode).
- **Acceptance:** [ ] release builds set `webContentsDebuggingEnabled:false` [ ] dev builds keep it on

#### F-43 · Mandate the admin reversibility battery · 🟠 · AD-1
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **New (now):** the Reversibility Iron Law (every admin mutation has a registered inverse) is enforced by *construction* but not by a test — a new admin op can ship with zero reversibility tests and green CI; `describeAdminOp` doesn't force it.
- **Change:** have `describeAdminOp` register each `contract.name` into a module set; add an aggregate test asserting equality with `ADMIN_OP_NAMES` (every registered op is battery-covered). Not-yet-ruled — clear improvement.
- **Why:** inverse *existence* is structural; this makes inverse *coverage* enforced, not conventional.
- **Touch:** `apps/api/src/slices/admin/**` (op registry + a battery test).
- **Acceptance:** [ ] an op with no reversibility test fails CI [ ] all current ops pass

#### F-44 · Registry-driven undo round-trip harness · 🟠 · AD-2
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **New (now):** inverse *correctness* is convention — there is no generic snapshot→execute→undo→snapshot equality harness; a wrong inverse passes CI.
- **Change:** per-op fixtures + a generic harness asserting state returns to the pre-execute snapshot after undo; a durable op with neither a fixture nor a justified exclusion fails the build. Not-yet-ruled.
- **Why:** proves inverses actually restore state, not just that one is registered.
- **Touch:** `apps/api/src/slices/admin/**` (harness + fixtures).
- **Acceptance:** [ ] snapshot/undo round-trip runs per durable op [ ] a deliberately-wrong inverse fails the harness

#### F-45 · Close the idempotency-rule blind spot · 🟠 · WF-3
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **New (now):** the ts-morph idempotency arch rule inspects only *declared-exempt* routes; nothing statically proves a non-exempt mutating handler actually calls `runMutation`/`idempotent.*`, nor bans an external call inside a plain DB transaction (pattern-D). No live violation observed, but unenforced.
- **Change:** extend the arch rule so every mutating route (POST/PUT/PATCH/DELETE) must either declare an exemption+wrapper or route through `runMutation`; add a check against external calls inside a plain (non-`byExternalPreClaim`) tx. Not-yet-ruled.
- **Why:** the idempotency guarantee currently rests on convention for non-exempt routes.
- **Touch:** `packages/config/arch/idempotency-*.rule.ts`.
- **Acceptance:** [ ] a mutating handler without `runMutation`/exemption fails arch:check [ ] no false positives on current routes

#### F-46 · Fix the Prettier-enforcement doc claim (+ optional standalone check) · 🟡 · CI-1 — **CORRECTED**
**Status:** ✅ done (doc fix landed 2026-07-19; optional standalone `format:check` not added) · **Owner:** — · **PR:** —
- **New (now):** **Prettier IS enforced** — `eslint-plugin-prettier/recommended` is in the shared ESLint config (`packages/config/eslint.config.js:7,713,726`), so `pnpm lint` (the CI lint gate + pre-push ESLint via `.husky/pre-push`) fails on JS/TS/TSX formatting violations. The standalone `format:check` script exists (`package.json:20`) but isn't a separate CI step, and the **pre-commit** hook runs codegen only (`.husky/pre-commit` — no Prettier, no lint). So `docs/DEVELOPMENT.md:43` ("Pre-commit runs Prettier and basic lint") is **false** — the real gate is ESLint at lint/pre-push, not pre-commit. `.astro` may be uncovered (see F-63/UI-4).
- **Change:** correct `docs/DEVELOPMENT.md:43` to describe the real gate (Prettier via ESLint at lint/pre-push). **Optional:** add a fast standalone `format:check` to CI/pre-commit if you want formatting caught without a full lint run; extend Prettier coverage to `.astro`.
- **Why:** Prettier is **not** unenforced — the earlier "enforced nowhere" finding was overstated; only the doc claim is wrong.
- **Touch:** `docs/DEVELOPMENT.md:43`; optionally `ci.yml` / `.husky` for a standalone check.
- **Acceptance:**
  - [x] DEVELOPMENT.md accurately describes Prettier enforcement (via ESLint, not pre-commit) — done
  - [ ] (optional) a standalone `format:check` gate exists if wanted

#### F-48 · Jobs alarm-semantics + idle-step tests · 🟠 · JD-3 / JD-4
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **New (now):** every jobs test force-fires the alarm; the real platform alarm delivery/retry and the eviction-mid-idle-decay `idleStep` path are never exercised.
- **Change:** miniflare timer-advance tests that exercise real alarm delivery + retry, and the eviction-during-idle-decay path. Not-yet-ruled.
- **Why:** the dispatcher's core timing is unverified against the platform.
- **Touch:** `packages/realtime` JobDispatcher tests.
- **Acceptance:** [ ] a test advances real timers to fire an alarm [ ] idle-decay + eviction path covered

#### F-49 · Restore server→client response typing · 🟠 · FE-1
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **New (now):** all 119 API route handlers return bare `Response` via the uniform `respond*` tails, so `hc<AppType>` infers no response body — the web client re-asserts every body by hand through 69 `fetchJson<T>` casts, and a few (`MeResponse`, `KeyChainResponse`) are locally redeclared with no server link (drift risk).
- **Change (RULED 2026-07-19: FULL refactor):** make every slice's `respond*` tail return `TypedResponse` so `hc<AppType>` infers all 119 response bodies; drop the manual `fetchJson<T>` casts as they become redundant and route `MeResponse`/`KeyChainResponse` to shared contracts. Large (L).
- **Why:** the typed-RPC contract currently doesn't flow to the client for response bodies.
- **Touch:** each slice's `respond*` helpers, `apps/web/src/lib/api-client.ts`.
- **Acceptance:** [ ] `hc<AppType>` yields typed 200 bodies for the high-traffic reads [ ] `MeResponse`/`KeyChainResponse` sourced from shared contracts

#### F-50 · Route OPAQUE/2FA fetches through the header shim · 🟠 · FE-2
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **New (now):** 14 raw `fetch()` sites in OPAQUE auth + 2FA-setup (`lib/auth.ts` ×12, `two-factor-setup.tsx` ×2) bypass `customFetch`, so they carry no `X-App-Version`/`X-HushBox-Platform` and can't receive the 426 upgrade gate.
- **Change:** route these through a shared header-injecting fetch (they can keep their byte-array OPAQUE bodies, just not skip the header shim). Not-yet-ruled (clear).
- **Why:** auth traffic must participate in the version gate + platform attribution.
- **Touch:** `apps/web/src/lib/auth.ts`, `components/auth/two-factor-setup.tsx`.
- **Acceptance:** [ ] all auth/2FA requests carry the platform+version headers [ ] a stale-version auth request receives 426

#### F-51 · Centralize mid-session 401/revocation · 🟠 · FE-3
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **New (now):** there is no global 401 handler — a session revoked mid-session throws an `ApiError(401)` into whichever hook fires next; auth is cleared only at bootstrap `restoreSession`.
- **Change:** add a `QueryCache.onError` (or fetch-layer) handler that on a definitive 401 clears auth and redirects to login. Not-yet-ruled (clear). (Web analog of the admin QA-1/F-07.)
- **Why:** a revoked session should log the user out, not surface a random error.
- **Touch:** `apps/web/src/providers/query-provider.tsx`, `lib/auth.ts`.
- **Acceptance:** [ ] a mid-session 401 clears auth + redirects once (no loop)

#### F-52 · Fix the version-check error contract · 🟠 · ENV-7
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **New (now):** the 426 VERSION_MISMATCH response spreads `currentVersion`/`updateUrl` at the top level, violating the strict `{code, details?}` error contract every other route follows.
- **Change:** move those fields under `details`. Not-yet-ruled (clear).
- **Why:** one route breaking the error shape defeats uniform client handling.
- **Touch:** `apps/api/src/middleware/version-check.ts`, client 426 parsing.
- **Acceptance:** [ ] 426 body is `{code, details:{currentVersion, updateUrl}}` [ ] client reads them from `details`

#### F-53 · Delete `provisionUserBilling` · 🟠 · EM-1
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **New (now):** `provisionUserBilling` (`billing/domain/wallets.ts:86`) is verified dead (zero production callers — the live path is `provisionWalletsWithinTx` + one welcome send); it carries a latent double-welcome-email path.
- **Change:** delete the function (and its now-orphaned tests). Not-yet-ruled (clear).
- **Why:** removes dead code + a latent double-send.
- **Touch:** `apps/api/src/slices/billing/domain/wallets.ts`, barrel exports.
- **Acceptance:** [ ] function + orphan tests deleted; build green

#### F-54 · Route harness-bypassing e2e specs through fixtures · 🟠 · E2E-1
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **New (now):** demo/marketing/persona e2e specs import raw `@playwright/test`, losing the harness's console/network auto-fail assertions.
- **Change:** route them through the project fixtures; add a lint ban on raw `@playwright/test` imports in `e2e/`. Not-yet-ruled. Read `e2e/CLAUDE.md` first.
- **Why:** bypassing specs silently lose failure detection.
- **Touch:** `e2e/**`, a lint rule.
- **Acceptance:** [ ] no spec imports raw `@playwright/test` [ ] all specs get console/network auto-fail

#### F-56 · Assert Resend + FCM in CI · 🟠 · CAS-3
**Status:** ⬜ not-started · **Owner:** — · **PR:** —
- **New (now):** Resend + FCM have evidence adapters but are mocked/unasserted in CI, so their real code paths aren't exercised or proven.
- **Change:** wire a sandbox or `verify:evidence`-style assertion so each integration's code path is proven to have run. Not-yet-ruled.
- **Why:** the evidence doctrine ("every integration's path ran") isn't met for these two.
- **Touch:** `ci.yml`, `scripts/verify-evidence.ts`, the adapters.
- **Acceptance:** [ ] CI asserts the Resend + FCM code paths executed

#### F-57 · Route token estimates through the shared helper · 🟡 · TE-1
**Status:** ⬜ · **Owner:** — · **PR:** —
- **New (now):** trial/classifier token estimates re-implement `ceil(chars/ratio)` instead of the canonical `estimateTokensForTier`.
- **Change:** route both through `estimateTokensForTier`. **Touch:** the two estimate sites. **Acceptance:** [ ] one implementation, both callers use it.

#### F-58 · Fix env existence-branching + stale comments · 🟡 · ENV-1…6
**Status:** ⬜ · **Owner:** — · **PR:** —
- **New (now):** 5 sites branch on a var's existence instead of the mode (`cors.ts`, `payment-form`, `sidebar-footer`, `drizzle.config`, `admin-nav`), + 3 stale factory comments — violates the env doctrine (branch on mode via `envUtils`, never on presence).
- **Change:** branch on mode / fail-fast; fix the comments. **Touch:** the 5 files + comments. **Acceptance:** [ ] no existence-branching; all via `envUtils`/mode.

#### F-59 · Consolidate duplicated logic · 🟡 · DUP-2/3/4/5
**Status:** ⬜ · **Owner:** — · **PR:** —
- **New (now):** nano→dollar render re-implemented ×4, `utcDayKey` bypassed ×2, a web `PRIVILEGE_ORDER` parallel to the shared ladder, and the media MIME allowlist copy-pasted byte-identically in two files.
- **Change:** import the canonical helpers (`nano-usd.ts`, `utcDayKey`, `MEMBER_PRIVILEGES`) and extract one shared MIME const. **Touch:** the re-impl sites. **Acceptance:** [ ] each concept has one implementation.

#### F-60 · FCM RS256 relocation + keyless-sha256 carve-out · 🟡 · CR-5/CR-6
**Status:** ⬜ · **Owner:** — · **PR:** —
- **New (now):** FCM RS256 signing lives outside `packages/crypto`; 5 keyless `sha256` sites use `crypto.subtle` directly (consistency).
- **Change (RULED 2026-07-19: RELOCATE):** move the FCM RS256 signing into `packages/crypto` (matches the crypto-segregation doctrine); document the 5 keyless-sha256 sites. **Touch:** notifications FCM adapter, `packages/crypto`. **Acceptance:** [ ] signing in packages/crypto or a documented exception.

#### F-61 · WS reconnect backoff jitter · 🟡 · FE-5
**Status:** ⬜ · **Owner:** — · **PR:** —
- **New (now):** the WS client's reconnect backoff is deterministic ×2 (no jitter), unlike the jittered HTTP retry — synchronized-reconnect risk after a shared blip.
- **Change:** reuse the shared jittered backoff (`retry.ts`). **Touch:** `apps/web/src/lib/ws-client.ts`. **Acceptance:** [ ] reconnect delay is jittered.

#### F-62 · Web query-key factories + zod validateSearch · 🟡 · FE-6/FE-7(web)
**Status:** ⬜ · **Owner:** — · **PR:** —
- **New (now):** 6 ad-hoc inline query keys outside the per-hook factory pattern; `validateSearch` on 3 web routes is hand-rolled `typeof`, not zod (the admin analog is F-29).
- **Change:** move the 6 keys into factories; adopt zod `validateSearch`. **Touch:** the listed web hooks/routes. **Acceptance:** [ ] no ad-hoc keys; web search is zod-validated.

#### F-63 · Close a11y-wall gaps · 🟡 · UI-4/UI-6/UI-7
**Status:** ⬜ · **Owner:** — · **PR:** —
- **New (now):** `.astro` files are outside the a11y lint wall (img/inline-style bans glob `.tsx` only); the raw-rAF member-form ban is `.tsx`-only so `.ts` can call `globalThis.requestAnimationFrame`; the admin `<main>` has no skip link (web does).
- **Change:** extend the lint globs to `.astro`/`.ts` as appropriate; add the admin skip link. **Touch:** `packages/config/eslint.config.js`, `apps/admin/src/routes/__root.tsx`. **Acceptance:** [ ] astro + .ts covered; admin has a skip link.

#### F-64 · Marketing SEO/links fixes · 🟡 · MK-3/MK-4/MK-5
**Status:** ⬜ · **Owner:** — · **PR:** —
- **New (now):** the AASA components register `/login`,`/signup` as universal-link targets but the client allowlist excludes them (UX dead-end); there is no static `404.astro`; `robots.txt` allows `/chat`,`/login`,`/signup` and doesn't `Disallow: /demo`.
- **Change:** align the AASA↔allowlist lists; add a `404.astro`; prune the robots allows + disallow `/demo`. **Touch:** `apps/marketing/**`, `use-deep-links.ts`. **Acceptance:** [ ] no AASA dead-ends; static 404 exists; robots cleaned.

#### F-65 · Fix conditional/ordering-fragile e2e · 🟡 · E2E-3/E2E-4
**Status:** ⬜ · **Owner:** — · **PR:** —
- **New (now):** some e2e assertions are conditional and can silently no-op (plus an empty fixme stub); 11 serial `describe`s share personas (brittle, order-dependent).
- **Change:** make assertions unconditional; give tests per-worker users. **Touch:** `e2e/**`. Read `e2e/CLAUDE.md`. **Acceptance:** [ ] no conditional no-op assertions; no shared-persona ordering coupling.

#### F-66 · Admin `maxTargets` guardrail + interleaving tests · 🟡 · AD-3/AD-4
**Status:** ⬜ · **Owner:** — · **PR:** —
- **New (now):** the `maxTargets` guardrail is defined in the contract type but unimplemented in the engine (only `maxAmountNanoUsd` is checked); 3 ops (feedback.setStatus, newsletter.schedule/cancel) lack the interleaving property test.
- **Change (RULED 2026-07-19: DELETE the field):** delete the unused `maxTargets` field from the admin contract (no multi-target ops exist); add the interleaving property tests for the 3 ops. **Touch:** admin contract + engine + op tests. **Acceptance:** [ ] `maxTargets` enforced or removed; the 3 ops covered.

#### F-67 · Sentry scrub regression test + client-SDK lint ban · 🟡 · SE-6
**Status:** ⬜ · **Owner:** — · **PR:** —
- **New (now):** no regression test guards the Sentry scrub allowlist; no lint bans adding a client-side error SDK (absence is only dependency-enforced today).
- **Change:** add a scrub-allowlist regression test; add a lint ban on client-side error/analytics SDK imports. **Touch:** telemetry tests, `packages/config/eslint.config.js`. **Acceptance:** [ ] a scrub-allowlist change fails a test; a client error-SDK import errors.

#### F-68 · Fix stale-doc claims · 🟡 · ENV-10/WF-2/AD-5
**Status:** ⬜ · **Owner:** — · **PR:** —
- **New (now):** CODE-RULES references stale error-schema paths (ENV-10); the type-tag doc claims a non-existent "save" edge-check checkpoint (WF-2); the admin CLAUDE.md battery-claim wording is stale (AD-5).
- **Change:** correct all three doc claims to match the code. **Touch:** `docs/CODE-RULES.md`, `packages/shared/src/type-tag.ts` (comment), admin CLAUDE.md. **Acceptance:** [ ] each doc claim matches reality.

#### F-69 · Delete dead exports · 🟡 · DEAD-2
**Status:** ⬜ · **Owner:** — · **PR:** —
- **New (now):** `IMAGEN_SAMPLE_SIZE_BY_MODEL`+`getImagenSampleSize` (0 importers) are dead; `models/live-catalog-fetch.ts` is test-infra that should be relocated. (The `enums.ts` dead groups are handled in F-34.)
- **Change:** delete the Imagen pair; relocate `live-catalog-fetch.ts` under test-infra. **Touch:** `packages/shared/src/models/*`. **Acceptance:** [ ] dead exports gone; test-infra relocated; build green.

#### F-70 · Jobs edge-case tests · 🟡 · JD-5…JD-8
**Status:** ⬜ · **Owner:** — · **PR:** —
- **New (now):** four untested jobs edges: multi-isolate `FOR UPDATE SKIP LOCKED` contention, neon-proxy latency injection, wake-delivery e2e, and the wall-clock lease path.
- **Change:** add a test per edge (see §13 for the exact scenarios). Not-yet-ruled. **Touch:** jobs integration tests. **Acceptance:** [ ] each of JD-5…8 has a covering test.

## 38.6 Ruled — no action (sign-off ledger)

These were decided as accept / confirm / ignore. Recorded so nothing is left ambiguous; no work item.

| Ref | Decision | Note |
|---|---|---|
| Q1 (feature) | No trial feature change | 5/day quota + $50 pool retained; only F-24 (burst removal) remains |
| Q7 · Q8 | Closed — verified parity | no payment poll remains; legacy chat input was text-only |
| Q13 | Accept admin has no in-app a11y panel | internal tool; UI-7 skip-link optional, not scheduled |
| Q18 | Owner-funded premium rule accepted | verified equivalent to legacy by construction |
| Q19 | Default member cap accepted | absent cap ⇒ self-fund, matches legacy |
| QD-1 | Accept no-rollback / non-atomic deploys | legacy parity, zero users; **no doc change** per ruling |
| QR-1 | Accept unbounded WS send buffering | option (c) chosen — no backpressure shed |
| QR-4 / RT-5 | Accept the liveness memo | bounded by participant set; no TTL sweep |
| QS-4 / ST-6 | Accept worktree slot collision | no fail-fast added |
| QA-4 / AS-5 | Admin 426 exemption confirmed intentional | static SPA behind Access |
| QN-2 / NA-2 | Resend-side suppression is the sole email gate | confirmed intentional |
| QN-3 / NA-4 | Accessibility prefs stored plaintext | confirmed intentional (non-private UI state) |
| QC-3 / CC-3 | Plaintext-body-for-inference is the intended model | **already correct**; marketing copy already honest — no action |
| QM-2 / DM-1 | Demo `/models` stays a live passthrough | option (b) chosen |
| QM-3 / DM-3 | Committed-asset drift check stays manual | option (b) chosen |
| QM-5 / DM-5 | `07-project/` + doc drift ignored | left as-is per ruling |
| QB-2 (confirm half) | Concurrency model confirmed | the assertion/doc half is F-10 |
| QD-2 | Keep the strict exact-match version gate (no floor) | F-25 retired; the earlier "add a floor" ruling mis-recorded the founder's answer (they chose option a = keep exact) |

---

**§38 is the working plan of record.** As items land, flip their Status in both the item and the §38.0 board, tick the acceptance boxes, and fill Owner/PR. Evidence for any claim is in the referenced finding section (§2–§37).
