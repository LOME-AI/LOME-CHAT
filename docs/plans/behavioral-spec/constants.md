# Constants inventory (T0.0)

Exact current values a rewrite could silently change, captured against source with
file:line citations. All entries **Verified** (read directly from source this session)
unless marked otherwise. Line numbers are as of the working tree at T0.0; spot-check by
opening the cited file.

## Fees and pricing

| Constant | Value | Source |
| --- | --- | --- |
| `HUSHBOX_FEE_RATE` | 0.06 (6%) | `packages/shared/src/constants.ts:44` |
| `CREDIT_CARD_FEE_RATE` | 0.045 (4.5%) | `packages/shared/src/constants.ts:47` |
| `PROVIDER_FEE_RATE` | 0.045 (4.5%) | `packages/shared/src/constants.ts:50` |
| `TOTAL_FEE_RATE` | sum = 0.15 (15%) — single source of truth for fee math | `packages/shared/src/constants.ts:60` |
| `EXPENSIVE_MODEL_THRESHOLD_PER_1K` | $0.10 / 1k tokens (expensive-model warning) | `packages/shared/src/constants.ts:66` |
| `STORAGE_COST_PER_CHARACTER` | derived = $0.0000003/char ($0.0003 per 1k chars) | `packages/shared/src/constants.ts:88-90` |
| `STORAGE_COST_PER_1K_CHARS` | derived = $0.0003 | `packages/shared/src/constants.ts:96` |
| `MEDIA_MONTHLY_COST_PER_GB` | $0.03/GB/month | `packages/shared/src/constants.ts:102` |
| `MEDIA_STORAGE_COST_PER_BYTE` | derived (~$0.000000018/byte, 50-yr retention) | `packages/shared/src/constants.ts:108-109` |

## Tiers, quotas, welcome credit

| Constant | Value | Source |
| --- | --- | --- |
| `FREE_ALLOWANCE_CENTS_VALUE` | 5 ($0.05/day free allowance) | `packages/shared/src/tiers.ts:12` |
| `FREE_ALLOWANCE_DOLLARS` | "0.05000000" (numeric column form) | `packages/shared/src/tiers.ts:15` |
| `TRIAL_MESSAGE_LIMIT` | 5 messages/day for trial users | `packages/shared/src/tiers.ts:18`; enforced in `apps/api/src/services/billing/trial-usage.ts:45,59` |
| `WELCOME_CREDIT_CENTS` | 20 ($0.20 welcome credit) | `packages/shared/src/tiers.ts:21` |
| `WELCOME_CREDIT_BALANCE` | "0.20000000" — granted at wallet provisioning | `packages/shared/src/tiers.ts:24`; consumed in `apps/api/src/services/billing/wallet-provisioning.ts:25,36-37` |
| Tier derivation | `paid` iff `balanceCents > 0`, else `free`; unauthenticated = `trial` or `guest` (link) | `packages/shared/src/tiers.ts:48-69` |
| Premium gating | premium models require `tier === 'paid'` | `packages/shared/src/tiers.ts:78-83` |
| Daily allowance reset | lazy idempotent `UPDATE … WHERE balance < FREE_ALLOWANCE_DOLLARS` (no reset job) | `apps/api/src/services/billing/balance.ts:145,177-181` |

## Budget constants

| Constant | Value | Source |
| --- | --- | --- |
| `MAX_ALLOWED_NEGATIVE_BALANCE_CENTS` | 50 ($0.50 cushion, paid tier only) | `packages/shared/src/constants.ts:173`; tier gating in `packages/shared/src/budget.ts:170-172` |
| `MAX_TRIAL_MESSAGE_COST_CENTS` | 1 ($0.01 max estimated cost per trial/guest message) | `packages/shared/src/constants.ts:180`; used in `packages/shared/src/budget.ts:189-192` |
| `MINIMUM_OUTPUT_TOKENS` | 1000 (minimum reserved output) | `packages/shared/src/constants.ts:186` |
| `LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD` | 10,000 (low-balance warning) | `packages/shared/src/constants.ts:192` |
| `CHARS_PER_TOKEN_CONSERVATIVE` | 2 (free/trial/guest input estimation) | `packages/shared/src/constants.ts:199` |
| `CHARS_PER_TOKEN_STANDARD` | 4 (paid input estimation; output storage is tier-inverted) | `packages/shared/src/constants.ts:205`; inversion at `packages/shared/src/budget.ts:461-464` |
| `CAPACITY_RED_THRESHOLD` / `CAPACITY_YELLOW_THRESHOLD` | 0.67 / 0.33 | `packages/shared/src/constants.ts:211,218` |
| `MAX_SEARCH_TOOL_CALLS` | 10 per text streaming request | `packages/shared/src/constants.ts:247` |
| `SEARCH_COST_PER_CALL` | $0.005 (pre-flight reservation only) | `packages/shared/src/constants.ts:254` |
| Effective budget (group) | `min(conversationRemaining, memberRemaining, ownerRemaining)` | `packages/shared/src/budget.ts:713-719` |

## Limits

| Constant | Value | Source |
| --- | --- | --- |
| `MAX_CONVERSATION_MEMBERS` | 100 (users + link guests per conversation) | `packages/shared/src/constants.ts:237`; enforced at `apps/api/src/routes/members.ts:224` and `apps/api/src/routes/links.ts:91` |
| `MAX_FORKS_PER_CONVERSATION` | 5 | `packages/shared/src/constants.ts:240`; enforced at `apps/api/src/services/forks/forks.ts:210-213` |
| `MAX_SELECTED_MODELS` | 5 (multi-model fan-out width) | `packages/shared/src/constants.ts:257` |
| `MAX_MEDIA_OBJECT_BYTES` | 250,000,000 (single-PUT R2 cap) | `packages/shared/src/constants.ts:126` |
| `MIN_VIDEO_DURATION_SECONDS` / `MAX_VIDEO_DURATION_SECONDS` | 1 / 8 | `packages/shared/src/constants.ts:129,132` |
| `MAX_AUDIO_DURATION_SECONDS` | 600 | `packages/shared/src/constants.ts:156` |
| `VIDEO_ASPECT_RATIOS` | `['16:9', '9:16']` | `packages/shared/src/constants.ts:142` |
| `VIDEO_RESOLUTIONS` | `['720p', '1080p', '4k']` | `packages/shared/src/constants.ts:145` |
| `IMAGE_ASPECT_RATIOS` | `['1:1', '4:3', '3:4', '16:9', '9:16']` | `packages/shared/src/constants.ts:148` |

## Sessions, tokens, payments

| Constant | Value | Source |
| --- | --- | --- |
| `SESSION_MAX_AGE_SECONDS` | 30 days (`60*60*24*30`) | `apps/api/src/lib/session.ts:4` |
| `EMAIL_VERIFY_TOKEN_EXPIRY_MS` | 24 h | `apps/api/src/constants/auth.ts:1` |
| `PAYMENT_EXPIRATION_MS` | 30 min | `packages/shared/src/constants.ts:99`; enforced at `apps/api/src/routes/billing.ts:194` |
| `billingLoginToken` TTL | 60 s (mobile → web billing token) | `apps/api/src/lib/redis-registry.ts:332-336` |
| `MEDIA_DOWNLOAD_URL_TTL_SECONDS` | 300 s presigned GET TTL | `packages/shared/src/constants.ts:123` |
| `STREAM_TIMEOUT_MS` | 90,000 ms client SSE gap timeout (no reconnection) | `packages/shared/src/constants.ts:264` |
| `KEEPALIVE_INTERVAL_MS` | 30,000 ms SSE `:keep-alive` comment cadence | `packages/shared/src/constants.ts:275` |

## Confirmation phrases

| Constant | Value | Source |
| --- | --- | --- |
| `DELETE_ACCOUNT_CONFIRMATION_PHRASE` | `'delete my account'` — compared trim+lowercased, no NFKC | `packages/shared/src/constants.ts:290` |

## Rate-limit registry — every `defineRateLimitKey` entry

All from `apps/api/src/lib/redis-registry.ts` (the only file defining rate-limit keys —
Verified via grep over the registry). `lockoutSeconds` is declared optional in the config
type (`redis-registry.ts:25`) but **no registry entry sets it**; lockouts are separate
`defineKey` entries whose TTL is the lockout duration (next table). Window algorithm:
fixed window keyed on `firstAttempt`, counted in Redis (`apps/api/src/lib/rate-limit.ts:57-120`).

| Key | maxAttempts | windowSeconds | TTL | Source line |
| --- | --- | --- | --- | --- |
| `loginUserRateLimit` | 5 | 900 | 900 | `redis-registry.ts:49-54` |
| `loginIpRateLimit` | 20 | 900 | 900 | `redis-registry.ts:55-60` |
| `registerEmailRateLimit` | 3 | 3600 | 3600 | `redis-registry.ts:63-68` |
| `registerIpRateLimit` | 10 | 3600 | 3600 | `redis-registry.ts:69-74` |
| `twoFactorUserRateLimit` | 10 | 900 | 900 | `redis-registry.ts:77-82` |
| `deleteAccountUserRateLimit` | 3 | 3600 | 3600 | `redis-registry.ts:85-90` |
| `recoveryUserRateLimit` | 3 | 3600 | 3600 | `redis-registry.ts:93-98` |
| `recoveryIpRateLimit` | 10 | 3600 | 3600 | `redis-registry.ts:99-104` |
| `recoveryGetKeyUserRateLimit` | 3 | 3600 | 3600 | `redis-registry.ts:105-111` |
| `recoveryGetKeyIpRateLimit` | 10 | 3600 | 3600 | `redis-registry.ts:112-117` |
| `verifyTokenRateLimit` | 10 | 3600 | 3600 | `redis-registry.ts:120-125` |
| `verifyIpRateLimit` | 30 | 3600 | 3600 | `redis-registry.ts:126-131` |
| `resendVerifyEmailRateLimit` | 1 | 60 | 60 | `redis-registry.ts:134-139` |
| `resendVerifyIpRateLimit` | 5 | 60 | 60 | `redis-registry.ts:140-145` |
| `chatStreamUserRateLimit` | 30 | 60 | 60 | `redis-registry.ts:151-156` |
| `mediaDownloadUserRateLimit` | 60 | 60 | 60 | `redis-registry.ts:159-164` |
| `shareGetIpRateLimit` | 30 | 60 | 60 | `redis-registry.ts:167-172` |
| `shareCreateUserRateLimit` | 20 | 60 | 60 | `redis-registry.ts:174-179` |
| `trialChatStreamIpRateLimit` | 20 | 60 | 60 | `redis-registry.ts:185-190` |
| `roadmapIpRateLimit` | 30 | 60 | 60 | `redis-registry.ts:196-201` |

## Lockout keys (separate `defineKey` entries; TTL = lockout duration)

| Key | Lockout duration (TTL) | Source |
| --- | --- | --- |
| `loginLockout` | 900 s (15 min) | `apps/api/src/lib/redis-registry.ts:204-208` |
| `twoFactorLockout` | 900 s (15 min) | `apps/api/src/lib/redis-registry.ts:209-213` |
| `recoveryLockout` | 3600 s (1 h) | `apps/api/src/lib/redis-registry.ts:214-218` |
| `deleteAccountLockout` | 86,400 s (24 h) | `apps/api/src/lib/redis-registry.ts:219-223` |

## Other Redis key TTLs worth preserving

| Key | TTL | Purpose | Source (`redis-registry.ts`) |
| --- | --- | --- | --- |
| `opaquePendingRegistration` | 300 s | OPAQUE handshake state, keyed by server-issued sessionId (race-avoidance rationale in comment) | `:225-244` |
| `opaquePendingLogin` | 120 s | login handshake | `:245-253` |
| `opaquePendingChangePassword` / `2FADisable` / `DeleteAccount` / `RecoveryReset` | 300 s each | other OPAQUE handshakes | `:254-284` |
| `totpPendingSetup` | 300 s | pending TOTP secret | `:287-294` |
| `totpUsedCode` | 120 s | TOTP replay guard | `:295-299` |
| `trialTokenUsage` / `trialIpUsage` | 86,400 s | trial daily counters | `:302-311` |
| `chatReservedBalance` / `groupMemberReserved` / `conversationReserved` | 180 s | speculative balance holds | `:314-329` |
| `roadmapCache` | 3600 s | public roadmap cache | `:341-346` |
| `sessionActive` / `passwordChangedAt` | `SESSION_MAX_AGE_SECONDS` (30 d) | session revocation tracking | `:349-358` |

## Smart Model constants

| Constant | Value | Source |
| --- | --- | --- |
| `SMART_MODEL_ID` | `'smart-model'` (synthetic id) | `packages/shared/src/constants.ts:41` |
| `CLASSIFIER_OUTPUT_TOKEN_CAP` | 2048 (covers hidden reasoning; drives worst-case reservation) | `packages/shared/src/smart-model/eligible-models.ts:21` |
| `LEVENSHTEIN_TOLERANCE` | 0.15 of output length (classifier output matching) | `packages/shared/src/smart-model/resolve.ts:10` |
| `MAX_CLASSIFIER_CONTEXT_CHARS` | 4000 chars (classifier context truncation budget) | `packages/shared/src/smart-model/truncate.ts:5` |

## Model pins

| Constant | Value | Source |
| --- | --- | --- |
| `STRONGEST_TEXT_MODEL_ID` / `VALUE_TEXT_MODEL_ID` | `anthropic/claude-opus-4.6` / `openai/gpt-5-nano` | `packages/shared/src/constants.ts:25-26` |
| `STRONGEST_IMAGE_MODEL_ID` / `VALUE_IMAGE_MODEL_ID` | `google/imagen-4.0-ultra-generate-001` / `google/imagen-4.0-fast-generate-001` | `packages/shared/src/constants.ts:28-30` |
| `STRONGEST_VIDEO_MODEL_ID` / `VALUE_VIDEO_MODEL_ID` | `google/veo-3.1-generate-001` / `google/veo-3.1-fast-generate-001` | `packages/shared/src/constants.ts:32-33` |

## Feature flags (current state)

`FEATURE_FLAGS` at `packages/shared/src/constants.ts:230-234`:
`PROJECTS_ENABLED: false`, `SETTINGS_ENABLED: true`, `AUDIO_ENABLED: false`.
