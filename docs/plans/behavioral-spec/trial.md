# Spec family: trial

**v2 owner:** `chat` slice — "trial mode as an explicit no-persist/no-charge variant of
the same pipeline (5/day quotas)" per the v2 slice map. Quota state is Redis
(`trialTokenUsage` / `trialIpUsage`, 86,400 s TTLs —
`apps/api/src/lib/redis-registry.ts:302-311`).

## e2e behaviors

### `e2e/chat/trial-chat.spec.ts` (titles Verified; `@chromium-only`)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| New chat page shows trial UI with focused prompt input | `New Chat Page » displays new chat UI with focused prompt input` | chat (web) |
| Unauthenticated trial user can send a message and receive a streamed response | `Chat Streaming » trial user can send message and receive response` | chat |
| Trial users can hold multi-turn conversations (within quota) | `Chat Streaming » trial user can have multi-turn conversation` | chat |
| The 6th message in a day shows the rate-limit message (limit = 5/day, `TRIAL_MESSAGE_LIMIT`, `packages/shared/src/tiers.ts:18`) | `Rate Limiting » shows rate limit message after 5 messages` | chat |
| Input is disabled after the daily limit is hit | `Rate Limiting » input is disabled after rate limit` | chat (web) |
| Clicking a premium model as a trial user opens the signup modal | `Premium Model Access » shows signup modal when trial user clicks premium model` | models + chat |

### `e2e/chat/trial-media-blocked.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Unauthenticated POST to `/api/chat/:id/stream` with image modality is rejected | `unauthenticated POST to /api/chat/:id/stream with image modality is rejected` | chat |
| A link-guest session with write privilege is rejected with `MEDIA_TRIAL_BLOCKED` on an image stream (guests can chat but not generate media) | `link-guest write-privileged session is rejected with MEDIA_TRIAL_BLOCKED on image stream` | chat + media |

## Integration behaviors — `apps/api/src/routes/trial-chat.test.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Trial requests need no authentication; SSE response with token events and a start event carrying the message ID | `accepts trial requests without authentication`, `streams SSE response with token events`, `returns start event with message ID` | chat |
| Request validation: missing messages/model → 400; last message must be from user → 400 | `returns 400 when messages are missing`, `…model is missing`, `…last message is not from user` | chat |
| Premium models are forbidden for trial (403) | `returns 403 when trying to use premium model` | models |
| Web search is auth-only: `webSearchEnabled=true` → 403 `FEATURE_REQUIRES_AUTH`; omitted/false still streams | `returns 403 with FEATURE_REQUIRES_AUTH when trial requests webSearchEnabled=true`, `still streams when webSearchEnabled is omitted or false on a trial request` | chat |
| Daily limit exceeded → 429 (`DAILY_LIMIT_EXCEEDED`); enforced per trial token AND per IP; works without `X-Trial-Token` (IP only) | `returns 429 when trial user has exceeded daily limit`, `works without X-Trial-Token (uses IP only)` (counters: `apps/api/src/services/billing/trial-usage.ts:45,59`) | chat |
| Per-IP burst limit independent of the daily cap: 21st request in 60 s → 429 `RATE_LIMITED`; window expiry restores; daily cap still applies | `per-IP rate limit (trialChatStreamIpRateLimit, 20/60s)` block: `returns 429 RATE_LIMITED on the 21st request from the same IP`, `allows requests again after the 60s window expires`, `still applies the daily cap (DAILY_LIMIT_EXCEEDED) independently of the IP burst limit` | chat + platform (rate-limit registry) |
| Authenticated users may NOT use the trial endpoint (400) | `returns 400 when authenticated user tries to use trial endpoint` | chat |
| Cost ceiling: message whose estimate exceeds the $0.01 trial cap → 402; within cap allowed (`MAX_TRIAL_MESSAGE_COST_CENTS`, `packages/shared/src/constants.ts:180`) | `returns 402 when message exceeds trial cost limit`, `allows messages within trial cost limit` | chat + billing |
| **Trial messages are never persisted** | `does not persist messages to database` | chat |

Constants pinned: `TRIAL_MESSAGE_LIMIT` 5/day, `MAX_TRIAL_MESSAGE_COST_CENTS` 1,
`trialChatStreamIpRateLimit` 20/60 s, trial counters TTL 86,400 s — see `constants.md`.
