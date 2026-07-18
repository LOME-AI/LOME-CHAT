# Full Codebase Audit — 2026-07-18

**Scope:** complete legacy→new parity map (legacy = GitHub `origin/main` @ `fce35f4d`, the
deployed monolith directly before the backend refactor) plus deep audits of crypto, DB
schema, env-var discipline, single-source-of-truth, security, testing fidelity, admin
plane, OpenRouter, infra, e2e, and overall quality. Produced by a fleet of read-only
exploration subagents; every nontrivial claim carries file:line evidence and a
Verified/Inferred mark. Checks (tests/typecheck/lint) were NOT run — reported green
repo-wide by the founder.

**Legend:** ✅ retained · ⚠️ changed · ❌ missing (regression candidate) · 🗑 intentionally
dropped · ➕ new (no legacy counterpart) · 🔴 critical · 🟠 major · 🟡 minor · ⚪ info

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Legacy feature parity checklist](#2-legacy-feature-parity-checklist)
   (identity/auth · conversations · chat/streaming · billing/payments · models ·
   media · notifications/emails · newsletter · account · platform)
3. [Encryption & crypto parity (must be EXACT)](#3-encryption--crypto-parity)
4. [Crypto segregation (where crypto lives, leaks)](#4-crypto-segregation)
5. [OPAQUE auth correctness](#5-opaque-auth-correctness)
6. [DB schema: table-by-table, column-by-column](#6-db-schema-audit)
7. [Env vars: existence-branching audit + new vars/secrets inventory](#7-env-vars)
8. [Model pricing fee hygiene (fees applied once)](#8-model-pricing-fee-hygiene)
9. [Sentry & error-reporting policy](#9-sentry--error-reporting)
10. [Token estimation & repo-wide single-source-of-truth](#10-ssot-audit)
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
24. [Consolidated findings register (ranked)](#24-findings-register)

---

<!-- Sections are appended below as audit agents report. -->

## 6. DB schema audit

**Sources.** Legacy DDL = `git show origin/main:packages/db/src/schema/*.ts` (21 tables + `projects`). New DDL = `packages/db/src/schema/*.ts` (36 tables) + migrations `0037…0057`. Behavior traced through `apps/api/src/slices/**` (new) and `apps/api/src/legacy/**` (legacy). Anchors: `docs/plans/BACKEND-REDESIGN.md` §9/§20, `packages/db/CLAUDE.md`.

**Global changes (stated once, apply to every table):**

| Change | Verdict |
|---|---|
| PK `id` `text`→`uuid` (same uuidv7 generator) | CHANGED-justified (shape-test mandate; `service_evidence` grandfathered) |
| All FK columns `text`→`uuid` | CHANGED-justified |
| Money `numeric(20,x)`→`bigint` nano-USD (legacy `parseFloat` reads eliminated) | CHANGED-justified |
| Closed-set `text`→`pgEnum` (`jobs.type` the one text exception) | CHANGED-justified |

### 6.1 Per-table column audit

#### users
| column | legacy | new | verdict |
|---|---|---|---|
| id | text PK uuidv7 | uuid PK uuidv7 | CHANGED-justified |
| email | text unique, **nullable** | text **notNull** unique | CHANGED-justified — no user-less principals in new design (trial principal has no users row); Verified DDL, Inferred behavior — verify registration paths |
| username | varchar(20) notNull unique | same | SAME |
| emailVerified | bool notNull default false | same | SAME |
| emailVerifyToken / emailVerifyExpires | text / timestamptz nullable | DROPPED | DROPPED-justified → `verification_tokens` |
| opaqueRegistration | bytea notNull | same | SAME |
| totpSecretEncrypted | bytea nullable | same | SAME |
| totpEnabled | bool notNull default false | same | SAME |
| hasAcknowledgedPhrase | bool notNull default false | same | SAME |
| customInstructionsEncrypted | bytea nullable | DROPPED | DROPPED-justified → `custom_instructions` |
| publicKey | bytea notNull | same | SAME |
| passwordWrappedPrivateKey | bytea notNull | same | SAME |
| recoveryWrappedPrivateKey | bytea notNull | same | SAME |
| accessibilityPreferences(+UpdatedAt) | jsonb + timestamptz | DROPPED | DROPPED-justified → `preferences` |
| lockedAt / lockReason | — | timestamptz / enum nullable | NEW-justified (chargeback/admin lock; CHECK `users_lock_consistency`) |
| deletionRequestedAt | — | timestamptz nullable | NEW-justified (chunked deletion marker) |
| createdAt / updatedAt | timestamptz notNull defaultNow | same | SAME |

#### conversations
| column | legacy | new | verdict |
|---|---|---|---|
| id / userId | text / FK cascade | uuid / FK cascade | CHANGED-justified |
| title | bytea notNull | same | SAME |
| projectId | text FK→projects set null | DROPPED | DROPPED-justified (`projects` removed, migration 0037) |
| titleEpochNumber / currentEpoch / nextSequence | int notNull defaults | same | SAME |
| conversationBudget→conversationBudgetNanoUsd | numeric(20,2) default '0.00' | bigint default 0 | CHANGED-justified (money) |
| createdAt/updatedAt | timestamptz | same | SAME |

#### messages
| column | legacy | new | verdict |
|---|---|---|---|
| id / conversationId | text / FK cascade | uuid / FK cascade | CHANGED-justified |
| senderType | text notNull | `message_sender_type` enum | CHANGED-justified |
| senderId | text nullable, no FK (deletion-nulled) | uuid nullable, no FK | SAME |
| wrappedContentKey | bytea notNull | same | SAME |
| epochNumber / sequenceNumber | int notNull | same | SAME (+ new composite FK below) |
| parentMessageId | text nullable, **no FK** | uuid nullable, **self-FK set null** | CHANGED-justified (adds integrity) |
| batchId | text default `gen_random_uuid()::text` | uuid default `uuidv7()` | CHANGED-justified |
| createdAt | timestamptz | same | SAME |

Constraints: `UNIQUE(conversationId,sequence)` SAME (index→constraint) · **NEW composite FK** `(conversationId,epochNumber)`→`epochs` cascade (legacy had none) · parent index now partial. Writers: chat slice only.

#### content_items
| column | legacy | new | verdict |
|---|---|---|---|
| id / messageId | text / FK cascade | uuid / FK cascade | CHANGED-justified |
| contentType | text | `content_item_type` enum | CHANGED-justified |
| position / encryptedBlob / storageKey / mimeType / sizeBytes / width / height / durationMs | — | — | SAME |
| modelName→modelId | text nullable | text nullable (renamed) | CHANGED-justified |
| providerName | — | text nullable | NEW-justified |
| cost→costNanoUsd | numeric(20,8) nullable | bigint nullable | CHANGED-justified |
| isSmartModel | bool notNull default false | same | SAME |

storageKey partial-unique SAME · CHECK `content_items_type_consistency` SAME · NEW partial `model_id` index. Writers: chat only.

#### payments
| column | legacy | new | verdict |
|---|---|---|---|
| userId | FK set null | FK set null | SAME (retention) |
| amount→amountNanoUsd | numeric notNull | bigint notNull | CHANGED-justified |
| status | text default 'pending' | enum (+`awaiting_webhook`/`expired`) | CHANGED-justified |
| idempotencyKey | text **nullable**, unique(userId,key) | text **notNull, globally unique** | CHANGED-justified (mandatory pre-claim; 🟠 see findings) |
| helcimTransactionId | text unique | same | SAME |
| cardType / cardLastFour / webhookReceivedAt | — | — | SAME |
| errorMessage→errorCode | free-form message | code only | CHANGED-justified (telemetry doctrine; verify writers emit codes) |

#### wallets
| column | legacy | new | verdict |
|---|---|---|---|
| userId | FK set null | FK set null | SAME |
| type | text | `wallet_type` enum (purchased/free) | CHANGED-justified |
| balance→balanceNanoUsd | numeric default '0' | bigint default 0 | CHANGED-justified |
| ledgerSeq | — | bigint notNull default 0 | NEW-justified (snapshot CAS seq) |
| priority | int notNull | **DROPPED** | CHANGED-suspect 🟡 — spend order now relies on `wallet_type` ordering; verify spend-selection logic |

`UNIQUE(userId,type)` SAME. Writers: billing only.

#### usage_records
| column | legacy | new | verdict |
|---|---|---|---|
| type / status / sourceType / sourceId / completedAt | text lifecycle columns | **DROPPED** | DROPPED-justified 🟠 — synchronous settlement removes async lifecycle; high blast radius, verify no reader expects `pending` |
| cost→costNanoUsd | numeric notNull | bigint notNull | CHANGED-justified |
| isEstimated | bool default false | same | SAME |
| contentItemId | — | uuid FK set null | NEW-justified (saved⟺billed anchor) |
| runId | — | uuid notNull (no run table) | NEW-justified |
| conversationId | — | uuid FK set null | NEW-justified |
| modelId / providerName / modality / generationId | — | text/text/enum/text | NEW-justified |
| idempotencyKey | — | text notNull unique | NEW-justified |

Writers: billing only (incl. post-insert conversationId update, same slice).

#### llm_completions
| column | legacy | new | verdict |
|---|---|---|---|
| usageRecordId | notNull unique FK cascade | same | SAME |
| model / provider | text notNull | DROPPED | DROPPED-justified → usage_records |
| inputTokens / outputTokens | int notNull | same | SAME |
| cachedTokens→cachedInputTokens | int default 0 | same (renamed) | CHANGED-justified |
| reasoningTokens | — | int default 0 | NEW-justified |
| toolSteps | — | jsonb default `[]` | NEW-justified (agentic tool activity) |

#### media_generations
usageRecordId SAME · model/provider DROPPED-justified → usage_records · mediaType→`modality` enum CHANGED-justified · imageCount/durationMs/resolution SAME.

#### ledger_entries
| column | legacy | new | verdict |
|---|---|---|---|
| transactionId | — | uuid notNull | NEW-justified (double-entry group) |
| walletId | text **notNull** FK **cascade** | uuid **nullable** FK **RESTRICT** | CHANGED-justified 🟠 — house legs walletless (CHECK-guarded); financial rows survive; confirm no wallet hard-delete path |
| amount→amountNanoUsd | numeric notNull | bigint notNull | CHANGED-justified |
| balanceAfter→balanceAfterNanoUsd | numeric **notNull** | bigint **nullable** | CHANGED-justified (running balance only on wallet legs, CHECK-enforced) |
| entryType→kind | text | `ledger_entry_kind` enum | CHANGED-justified |
| houseAccount | — | enum nullable | NEW-justified |
| idempotencyKey | — | text notNull unique | NEW-justified |
| paymentId / usageRecordId | FK set null | same | SAME |
| sourceWalletId | text FK set null | DROPPED | DROPPED-justified (transfers = two signed legs sharing transactionId) |

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
| column | legacy | new | verdict |
|---|---|---|---|
| memberId | notNull unique FK cascade | same (named constraint) | SAME |
| budget→budgetNanoUsd | numeric default '0.00' | bigint **no default** | CHANGED-justified 🟡 — absent row/cap = deny (§9); every insert must supply cap; verify upserts |
| spent→spentNanoUsd | numeric default '0' | bigint default 0 | CHANGED-justified; **cumulative, no period** (confirmed §9) |
| createdAt | timestamptz | DROPPED (updatedAt added) | CHANGED-suspect ⚪ — benign column swap |

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
| DB-1 | 🟠 | `usage_records.status/type` dropped — verify no reader expects async lifecycle (Verified DDL) | justified-by-design, verify readers |
| DB-2 | 🟠 | `ledger_entries.walletId` cascade→RESTRICT + nullable (`ledger-entries.ts:419`) — confirm no wallet hard-delete path | justified, verify |
| DB-3 | 🟠 | `payments.idempotencyKey` nullable→notNull global-unique (`payments.ts:227`) — any keyless payment flow now fails | justified, verify |
| DB-4 | 🟡 | `users.email` nullable→notNull (`users.ts:13`) — verify registration paths (Inferred behavior) | verify |
| DB-5 | 🟡 | `wallets.priority` dropped — verify spend-order via wallet_type (Inferred) | verify |
| DB-6 | 🟡 | `member_budgets.budgetNanoUsd` default removed (`member-budgets.ts:669`) — inserts must supply cap | verify |
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
| IC-1 | 🟠 | User search now requires existing conversation + active membership (user-search.ts:11-54 vs legacy users.ts:12-38). Deliberate hardening but breaking for any pre-conversation search flow — confirm all web/mobile consumers supply a conversation. Verified. |
| IC-2 | 🟡 | Add-member forbids granting ≥ granter's privilege (members.ts:141-145); legacy admin could add another admin. Stricter contract, undocumented. Verified. |
| IC-3 | 🟡 | Public shared-message read no longer returns inline `downloadUrl` for media; verify the media presign endpoint accepts a public share id unauthenticated, else public shared media is unfetchable. Inferred (media side unread here — cross-check §media). |
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
| CR-2 | 🟠 | v0x02 blobs are not wire-compatible with v0x01 message blobs; decrypt rejects legacy versions (format.ts:15-23). Product has no users, but confirm no pre-cutover blob must remain readable. Verified. |
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

Findings: no protocol misuse found. m4 (⚪, Inferred): password-change/2FA-disable step-up flows have no dedicated per-user lockout — parity with legacy likely (they're session-gated + OPAQUE-proof-gated); verify legacy had none either.

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
| **multimodal image INPUT** | verify legacy support | ❓ | chat/smart-model input ports fixed text→text (smart-model-candidates.ts:74) | finding CH-2 (Inferred) |
| custom instructions injection | prompt/builder.ts:13 | ✅ | run-scoped (routes.ts:227) → interpreter.ts:904 → adapters; 5000-char bound; classifier deliberately excluded | never baked into definition |
| model params passthrough / maxOutputTokens | max-tokens.ts | ✅ | model-call-execution.ts:143; turn-definition.ts:228 | omitted ceiling → model default (parity) |
| title generation | client-side only (E2EE) | ✅ | still client-side only | no backend AI title either side |
| error surfaces | ERROR_CODE_* | ✅ | RUN_REFUSAL_STATUS map (409/402/503/429); admission refusals synchronous HTTP (room-core.ts:542) | |
| runless user-only message | saveUserOnlyMessage | ✅ | routes.ts:1244; + push side-band added (:1296) | |
| link-guest send (owner funds) | guest billing path | ✅ | routes.ts:871 /guest | |
| one-run-per-conversation | — | ⚠️ design | run-control.ts:32 claim; CONCURRENT_RUN 409 | |

Findings: **CH-1** ⚪ transport/stop/one-run divergences are all founder-ruled design (listed for sign-off). **CH-2** 🟡 Inferred — confirm legacy had no image-*input* prompts to text chat; new turn input ports are text-only. 

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
| OR-1 | 🟠 | capabilities.ts hard-coded per-model constants still exported from live shared barrel (legacy-only consumers) — delete with legacy tree. Verified. |
| OR-2 | 🟠 | Vercel gateway env/config still shipped incl. Production (`PUBLIC_MODELS_URL` ×3) + dead fetcher + dead evidence name. Verified. |
| OR-3 | 🟡 | Language adapter lacks explicit `zdrReachable` refusal (media adapters have it); safe via exposure gate + per-request zdr, but defense-in-depth asymmetry. Inferred. |
| OR-4 | 🟡 | PROVIDER_MAP + non-chat-exclusions denylist are hand-maintained data (display/policy — judged acceptable, flag for awareness). Verified. |
| OR-5 | ⚪ | Negative pricing sentinel "-1": legacy showed model as free, new hides it (fail-closed) — behavior delta. Stale "AI Gateway" docstrings. Latent `pricePerSecond` audio field (no adapter). Verified. |

### 2.C Billing / payments

| Feature | Legacy | Status | New | Note |
|---|---|---|---|---|
| Helcim credit-load | two-step: POST /payments + /:id/process (legacy/routes/billing.ts:119,172) | ⚠️ | single POST /payments Pattern-D + payment.verify.v1 job (billing/routes.ts:479) | equivalent; API shape changed |
| payment webhook credit | webhooks.ts:156 cardTransaction only | ⚠️ | /billing/webhooks/payment, full event taxonomy (payment-webhook.ts:303) | credit path preserved |
| webhook HMAC verify | fail-open if verifier absent non-prod (webhooks.ts:33) | ✅⚠️ | **fail-closed always** (routes.ts:67, webhook-verify.ts) | security improvement |
| payment poll GET /payments/:id | billing.ts:261 | 🗑➕ | removed; webhook + verify job authoritative | confirm clients updated (BL-3) |
| refunds/chargebacks/disputes | **none in legacy** | ➕ | clawback legs + account lock + session.revoke.v1 + email; inquiry→notify (payment-webhook.ts:128-227) | major new capability |
| payment statuses | pending→awaiting_webhook→completed/failed + expiry | ⚠️ | preserved; pending not client-visible; verify expiry in verify job | |
| wallets purchased+free | ensureWalletsExist (wallet-provisioning.ts:18) | ✅ | provisionWalletsWithinTx (wallets.ts:29); free_tier→free rename; welcome as zero-sum promo legs | |
| spend order | charge-time wallet walk ORDER BY priority (transaction-writer.ts:242) | ⚠️ | caller-selected walletId charged unconditionally; selection upstream at admission/who-pays | verify purchased→free priority replicated (BL-3, ties to DB-5) |
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
| trial billing quota | 5/day token+IP atomic (trial-usage.ts:34) | ❌🟠 | removed → per-IP burst 20/60 + **global $50/day** spend cap (trial-spend.ts:61) | finding BL-1 |
| public usage stats | — | ➕ | public-usage-stats + statsIpRateLimit | leaderboard feature |

## 8. Model pricing fee hygiene

**Legacy:** fees applied ONCE at catalog build (`applyFees` in process-models.ts:101-240); all downstream consumed fee-inclusive values.
**New: deliberately INVERTED** — catalog stores **base (pre-markup) nano-USD** (normalize.ts:111); markup applied once-per-amount at each consumption seam. Two primitives: `applyMarkup` (bigint half-even, money.ts:89, `MARKUP_BASIS_POINTS=1500n`) and `applyFees` (float, pricing.ts:56, `TOTAL_FEE_RATE=0.15`), rate-equality asserted at init (money.ts:25).

All 9 application sites verified single-application, **no double-application found**: charge.ts:76 (settlement) · settlement.ts:452 (content_items display mirror) · estimate.ts:293/:261/:22 (admission/call/search) · smart-model-candidates.ts:135 · list-models.ts:28 (display, applyFees) · premium-check.ts:60 · workflows/settlement.ts:173 (delegates).

| # | sev | finding |
|---|---|---|
| FEE-1 | 🟠 | Dual markup primitives (float display vs bigint half-even charge) can diverge sub-cent on rounding; init assertion checks rate only, not rounding parity. Legacy's single primitive had no such class. Verified. |
| FEE-2 | 🟡 | Charged amount computed twice independently (charge.ts:76 ledger vs settlement.ts:452 content_items mirror) — documented-identical but no shared helper enforces it; extract `chargedNanoUsd(base, storage)`. Verified. |
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
| **trial daily quota** | **5/day token+IP atomic** | **REMOVED** → global $50/day read-compare | — | ❌ RL-1 |
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
| RL-1 | 🟠 | Trial per-identity 5/day quota removed (legacy trial-usage.ts:34 dual-key max(token,ip)). Only bounds now: per-IP burst + one global $50/day pool — Sybil flood unbounded per identity, and pool exhaustion = shared-fate refusal for all trial users rest of day. Confirm intent + document in §20 amendments. Verified. |
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
| SE-2 | 🟠 | All 4 shipped WAE metrics lack a live named watcher: `realtime_ws_upgrade_failure` + `realtime_billable_generation` (auditors explicitly deferred, scheduled.ts:46-49), `jobs_queue_depth`/`jobs_oldest_pending_age` (claimed admin-dashboard render absent). `realtime_ws_upgrade_failure` has NO alternative alarm — doctrine says "every metric has a named watcher or doesn't ship". Verified. |
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
| EM-1 | 🟠 | `billing/domain/wallets.ts:95` `provisionUserBilling` sends a second welcome email but appears to have **no live caller** (identity registration owns the real send; only barrel/tests reference it). Confirm no app.ts wiring, then delete the dead function. Inferred. |
| EM-2 | 🟡 | Password-reset now reuses the password-changed port → likely ships "changed" subject where legacy said "reset". Verify adapter subject. Inferred. |
| EM-3 | 🟡 | GC semantics changed (derived min-age, sequential deletes) — safe, flag for awareness. Verified. |
| EM-4 | 🟡 | Device-token route path changed — confirm capacitor client targets /notifications/device-tokens. Verified server-side. |
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
| ENV-8 | 🟠 | Frontend runs TWO error systems: new `friendlyErrorMessage` AND legacy `legacyFriendlyErrorMessage`/`ERROR_CODE_*` (payment-form.tsx:8,77; media-preview.tsx:36; trial-chat-page.tsx:100; message-item.tsx:5; ~49 legacy-variant consumers). Two code→copy homes violate SSOT. Migrate + delete legacy exports. Verified. |
| ENV-9 | 🟡 | Wire-code taxonomy narrowed ~120 legacy codes → 86 (payment declines etc. flattened to 8-code domain map) — confirm intended narrowing; payment-form copy currently depends on inline fields, not wire code. Verified mapping / Inferred impact. |
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
21 tests across e2e/admin (op-lifecycle flagship incl. mid-flow preview-commits-nothing + doubly-linked audit thread; guardrails over-cap audited refusal; user-lock two-effect + lockReason restore; jobs conflicts; auth-boundary Single-Auth-Path live; SQL panel write-refusal + carve-outs; models kill-switch; palette/actor attribution). Access faked at the real JWKS seam via dev mint. **The whole e2e CI job is `if: false`** — suite green in isolation, does not gate merges (AD-7, cross-ref §18).

### 14.5 Section findings
| # | sev | finding |
|---|---|---|
| AD-1 | 🟠 | Battery not mandatory — no enforcement that a registered op invokes `describeAdminOp`; CLAUDE.md claim aspirational. Tier-1 fix. Verified. |
| AD-2 | 🟠 | No generic registry-driven round-trip harness — inverse *existence* enforced by construction, inverse *correctness* by convention. Tier-2 fix. Verified. |
| AD-3 | 🟡 | feedback.setStatus, newsletter.schedule/cancel lack the interleaving property test; exclusion defensible but undocumented. Verified. |
| AD-4 | 🟡 | `maxTargets` guardrail field defined in contract type but unimplemented in engine (only maxAmountNanoUsd checked, engine.ts:208-227); banner cap is Zod validation not audited guardrail. Latent for multi-target ops. Verified. |
| AD-5 | ⚪ | admin-op-purity rule doesn't catch raw Date.now/Math.random (no live violation); engine composes byKey primitives rather than literal `idempotent.byKey` (documented, CLAUDE.md wording stale). Verified. |

## 12. API & browser security

### 12.1 CSRF
Origin-validation strategy both sides (no tokens). New is a strict improvement: **global** `csrfProtection()` on all state-changing methods (app.ts:499; legacy was per-prefix — a new route could silently miss it), + ADMIN_URL origin, + explicit webhook/token-login exemptions, Capacitor origins preserved, missing-config fail-closed 403. WS upgrade (GET) structurally exempt → see SEC-1.

### 12.2 CORS
Same allowlist (FRONTEND_URL/PREVIEW/Capacitor) + credentials; wildcard `*` now only for route-class `public` on non-allowlisted origins, credential-free, `Vary: Origin`, fail-closed on 500 (legacy: path-prefix `/api/public/*`, all methods). No regression; class-driven beats path drift. ADMIN_URL absent from CORS (asymmetry vs CSRF — admin is same-origin via rewrite, so benign; SEC-3). No Access-Control-Max-Age (perf only, both sides).

### 12.3 Security headers
| header | legacy API | new API | web/marketing `_headers` | admin SPA |
|---|---|---|---|---|
| CSP | ✅ frame-ancestors 'none' | ✅ identical | ✅ per-route hashed + SPA fallback; **dual-emit path + path/ (the mailing-list CSP-route fix, verified correct)**; fail-loud on unbuilt route | ❌ none |
| HSTS | ❌ | ➕ 1y incl. subdomains | zone-level | ❌ |
| X-Frame-Options / nosniff / Referrer-Policy | ✅ | ✅ (+ applied in `finally` — errors carry headers too ➕) | ✅ (/demo* SAMEORIGIN for Sandpack, same-origin only) | ❌ |
| Permissions-Policy | ❌ | ➕ all-off | — | ❌ |

### 12.4 Cookies
`hushbox_session` byte-for-byte parity (intentional cross-cutover unseal): httpOnly, Secure prod, **SameSite=None prod**/lax dev, 30d, path default. New adds zod-validated claims subset ➕. No __Host- prefix (incompatible with cutover; informational).

### 12.5 WebSocket
Upgrade auth robust: handler resolves caller (session OR link credential via header/`?linkPublicKey=`), authorizes membership BEFORE proxying to DO; DO query params server-set (worker is only caller — verified); session snapshot enables broadcast-time revocation cuts; auto-ping/pong. **But no Origin validation on upgrade** (SEC-1).

### 12.6 Input validation
zValidator coverage effectively complete across all 12 route files (samples verified); the only raw reads are HMAC-verified webhooks, registry-gated admin op names, authz-scoped tokens, defensively-parsed bodies. Client-ID trust: presign/conversation paths derive authz from principal + server-side key construction — never trust client IDs. ✅

### 12.7 Other surfaces
40 MiB edge body limit (uniform 413) ✅ · storage-key traversal structurally impossible (UUID-regex every segment) ✅ · no open redirects ✅ · no SSRF (fixed Linear URL, server-derived presign, inbound-only webhooks) ✅ · webhook HMAC via constantTimeCompare; tokens are DB-looked-up UUIDs (no string compare); portal token SHA-256-hashed ✅ · share pages frame-denied ✅ · IP keying: cf-connecting-ip first, XFF fallback unreachable in prod ✅.

### 12.8 Section findings
| # | sev | finding |
|---|---|---|
| SEC-1 | 🟠 | **No Origin check on WS upgrade** + SameSite=None cookie ⇒ cross-site WebSocket hijack surface: any origin can open an authenticated socket as a visiting victim (read broadcasts/send frames for their conversations). Bounded by membership + liveness checks, but real. Add allowlist Origin check on the upgrade mirroring csrfProtection. New-architecture surface (legacy SSE was CORS-governed). Inferred behavior, Verified code (conversations/routes.ts:454-480, csrf.ts:46). |
| SEC-2 | 🟡 | Admin SPA document served with **zero security headers** (assets-only worker, no _headers, no CSP meta) — no CSP/XFO/HSTS at the shell lay
## 12. API & browser security

### 12.1 Mechanism parity tables (all Verified)
| Mechanism | Legacy | New | Verdict |
|---|---|---|---|
| CSRF strategy | Origin-validation, per-route-group mounts (legacy/app.ts:63-96) | Origin-validation, **global** `csrfProtection()` on all mutating methods (app.ts:499; csrf.ts:43-83) + ADMIN_URL + explicit webhook/token-login exemptions | ➕ fail-safe improvement |
| CORS | allowlist + `/api/public/*` path-prefix wildcard | class-driven: allowlist w/ credentials; `*` only for non-allowlisted origin on `public`-class routes, credential-free, Vary: Origin; fail-closed on 500 | ➕ tighter |
| Security headers (API) | CSP + XFO DENY + nosniff + no-referrer | identical CSP + **adds HSTS + Permissions-Policy**, applied in `finally` (errors too) | ➕ |
| Web/marketing headers | — | per-route hashed CSP via generate-headers.ts; dual-emit `path` + `path/` (the Pages trailing-slash CSP fix); fail-loud on unbuilt route; /demo relaxes frame-ancestors to 'self' only | ✅ CSP route coverage correct |
| Cookies | hushbox_session, httpOnly, Secure prod, SameSite=None prod/lax dev, 30d | byte-identical (deliberate cutover parity); claims now zod-validated | ✅ |
| WS security | SSE (fetch/CORS-governed) | upgrade auth: caller resolved + membership authorized before DO proxy; DO params server-set (worker is sole caller — verified); heartbeat auto-pong | ✅ but see SEC-1 |
| Input validation | per-route | zValidator effectively complete; raw reads all registry-gated / authz-scoped / HMAC-verified (webhooks) | ✅ |
| Body limit | — | 40 MiB edge bodyLimit, 413 `{code}` | ✅ |
| Path traversal | — | storage keys UUID-regex-validated at every segment; structurally impossible | ✅ |
| SSRF / open redirects | — | none: fixed Linear URL, server-derived presign keys, inbound-only webhooks; no user-controlled redirects | ✅ |
| Timing safety | — | HMAC via constantTimeCompare; tokens high-entropy DB-looked-up; portal token hashed pre-lookup | ✅ |
| IP keying | — | cf-connecting-ip first; XFF fallback unreachable in prod | ✅ |

### 12.2 Section findings
| # | sev | finding |
|---|---|---|
| SEC-1 | 🟠 | **No Origin check on the WebSocket upgrade** (public-class GET; CSRF covers only mutating methods; CORS doesn't govern WS; cookie is SameSite=None in prod) → cross-site WebSocket hijacking surface: any origin can open an authenticated socket as a logged-in victim. Bounded by membership + broadcast liveness checks. Add an allowlist Origin check on the upgrade mirroring csrfProtection's set. New-architecture surface (legacy SSE was CORS-governed). Verified code / Inferred behavior. |
| SEC-2 | 🟡 | **Admin SPA document served with z
## 12. API & browser security

### 12.1 Mechanism parity tables (all Verified unless noted)

**CSRF** — Origin-validation strategy both sides; new is a strict improvement: global `csrfProtection()` on all state-changing methods (app.ts:499) vs legacy per-prefix mounts; adds ADMIN_URL origin; explicit webhook/token-login exemptions; Capacitor origins preserved; fail-closed on missing config.

**CORS** — same allowlist (FRONTEND_URL/PREVIEW/Capacitor) + credentials; wildcard `*` only for `public` route-class AND non-allowlisted origin, credential-free, `Vary: Origin` (legacy: path-prefix `/api/public/*` wildcard) — tighter, class-driven. No maxAge either side (⚪ perf).

**Security headers** — API: CSP identical to legacy + **new HSTS + Permissions-Policy**, applied in `finally` (errors carry headers too). Web/marketing: generated `_headers` with per-route hashed CSP; the trailing-slash dual-emit (generate-headers.ts:343-346) fixes the Pages `/route/` CSP gap the mailing-list e2e caught; MARKETING_ROUTES single-source + fail-loud on missing HTML — coverage correct. **Admin SPA: no headers at all** (SEC-2).

**Cookies** — `hushbox_session` byte-for-byte parity (httpOnly, Secure=prod, SameSite none-prod/lax-dev, 30d) — intentional for cross-cutover unseal; new adds zod-validated claims subset. No `__Host-` prefix (⚪, incompatible with cutover parity).

**WebSocket** — upgrade is `public`-class GET, handler resolves caller (session OR link credential incl. `?linkPublicKey=` for browsers) and authorizes membership BEFORE proxying to DO; DO query-params are server-set (worker is only caller — Verified); session snapshot enables broadcast-time revocation cuts; heartbeat auto-pong. **But no Origin check on upgrade** (SEC-1).

**Input validation** — zValidator coverage effectively complete across all 12 route files; the un-schema'd reads are registry-gated (admin op name), authz-scoped (device token), or HMAC-verified (webhooks). Client-ID trust spot-check clean: presign authorizes against DB rows, keys derived server-side.

**Other** — body limit 40MiB edge-enforced 413 · storage keys UUID-validated, traversal structurally impossible · no open redirects · no SSRF surfaces (fixed Linear URL; inbound-only webhooks) · webhook HMAC via constantTimeCompare; tokens are random-UUID DB lookups (no timing channel); portal token SHA-256-hashed · share pages frame-denied; `/demo` relaxes to `'self'` only · IP keying: cf-connecting-ip first, XFF fallback unreachable in prod.

### 12.2 Section findings
| # | sev | finding |
|---|---|---|
| SEC-1 | 🟠 | **No Origin validation on WS upgrade** (cross-site WebSocket hijacking surface): public GET + SameSite=None cookie means any origin's page can open an authenticated socket as the victim (bounded by membership + liveness checks). Legacy SSE was CORS-governed — this is a new-architecture surface. Add allowlist Origin check on upgrade mirroring csrfProtection. conversations/routes.ts:454-480. Verified code / Inferred behavior. |
| SEC-2 | 🟡 | **Admin SPA document ships zero security headers** (assets-only worker, no `_headers`, no CSP me
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
| SEC-1 | 🟠 | **No Origin validation on the WS upgrade** (public GET, CSRF-exempt, CORS doesn't gate WS) + `SameSite=None` cookie = cross-site WebSocket-hijacking surface: a malicious page can open an authenticated socket as the victim (bounded by per-conversation membership + broadcast-time liveness). New-architecture surface (legacy was SSE/CORS-governed). Add an allowlist Origin check on the upgrade handler mirroring csrfProtection's set. Verified code / Inferred exploitability. |
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
- **INF-1** 🟡 verify `src/scheduled.ts` schedule-constant test asserts all 4 wrangler cron entries (claimed in comment, not confirmed).

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
