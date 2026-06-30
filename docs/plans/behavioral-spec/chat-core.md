# Spec family: chat-core

**v2 owner:** `chat` slice (the turn: messages, content, orchestration, persistence),
with `conversations` (CRUD, titles), `account` (custom instructions), `billing`
(settlement), `models` (nametag attribution).

## e2e behaviors

### `e2e/chat/chat.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| New chat: UI renders, conversation is created, response received, appears exactly once in sidebar | `New Chat » displays UI, creates conversation, receives response, appears once in sidebar` | chat + conversations |
| Existing conversation displays messages and accepts a follow-up | `Existing Conversation » displays messages and accepts followup` | chat |
| Send button re-enables after streaming completes | `Existing Conversation » send button re-enables after streaming completes` | chat (web) |
| Conversation shows in sidebar; rename and delete via dropdown; delete confirmation can be cancelled | `Sidebar Actions » shows conversation in sidebar`, `can rename conversation via dropdown menu`, `can delete conversation via dropdown menu`, `can cancel delete confirmation` | conversations |
| Streaming AI response displays progressively after sending | `AI Response Streaming » displays streaming AI response after sending message` | chat |
| Long unbroken strings and long messages wrap without pushing layout/horizontal overflow | `Message Layout » long unbroken strings do not push previous messages off screen`, `long messages wrap properly without horizontal overflow` | web (frontend-only) |

### `e2e/chat/custom-instructions.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Settings page renders all sections; custom-instructions lifecycle (set/edit/clear, encrypted at rest — Inferred from architecture) | `settings page renders all sections, custom instructions lifecycle` | account |

### `e2e/chat/model-nametag.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Every AI response shows the producing model's name | `shows model name on every AI response` | chat + models |
| Nametag persists after page reload (model attribution is persisted per message) | `nametag persists after page reload` | chat |
| Multi-model responses each show a distinct nametag | `multi-model responses each show distinct nametag` | chat |

## Integration behaviors (apps/api) — the streaming/settlement core

These files are the dense spec for the turn pipeline; v2's single-settlement redesign
(`settle()`) must preserve the **observable** behaviors they encode even though the
mechanism changes:

| Behavior area | Source files | v2 slice |
| --- | --- | --- |
| Chat route contract (validation, SSE event sequence, persistence, error codes) | `apps/api/src/routes/chat.test.ts` | chat |
| Billing scenario matrix (tiers, cushion, races, minimum-token boundary) | `apps/api/src/routes/chat.billing-integration.test.ts` (titles in `payments-wallets.md`) | chat + billing |
| Parent-chain integrity of message history | `apps/api/src/routes/chat.parent-chain.integration.test.ts` | chat |
| Stream pipeline orchestration (slot fan-out, persist inputs, cost finalization, Smart Model staged persistence) | `apps/api/src/lib/stream-pipeline.test.ts` | chat |
| Billing-mismatch evidence row when gateway cost deviates from reservation estimate | `apps/api/src/lib/stream-pipeline.billing-mismatch.test.ts` | billing |
| Stream error classification (error→code buckets) | `apps/api/src/lib/classify-stream-error.test.ts` (see also `grounding-deltas.md` (a)/(b)) | chat |
| Multi-stream per-slot SSE multiplexing | `apps/api/src/lib/multi-stream.test.ts` | chat |
| SSE writer/stream handler mechanics (incl. keep-alive) | `apps/api/src/lib/stream-handler.test.ts` | chat |
| Conversation CRUD service + routes (create-or-get idempotency, pagination cursors, serialization) | `apps/api/src/routes/conversations.test.ts`, `apps/api/src/services/conversations/conversations.test.ts` | conversations |
| WebSocket route/auth | `apps/api/src/routes/websocket.test.ts`, `apps/api/src/lib/broadcast.test.ts` | realtime (DO) |
| Crypto round-trip of message blobs (encrypt/compress/decrypt) | `packages/crypto/src/message-codec.integration.test.ts`, `packages/crypto/src/integration.test.ts` | packages/crypto (unchanged owner) |

Key persisted-shape facts (code Verified):

- `messages` has a unique `(conversationId, sequenceNumber)` index — `packages/db/src/schema/messages.ts:39-41`.
- `batchId` groups every message persisted in a single `saveChatTurn`; defaults to a fresh uuid so legacy rows are their own batch — `packages/db/src/schema/messages.ts:22-35` (full semantics in `multi-model-batchId.md`).
- Client stream timeout 90 s with 30 s server keep-alives — `packages/shared/src/constants.ts:264,275`.

## Out-of-scope siblings

`e2e/chat/chat-scroll.spec.ts`, `e2e/ui/document-panel.spec.ts`,
`e2e/mobile/viewport.spec.ts`, `e2e/ui/viewport-edges.spec.ts` are frontend-only and
marked out-of-scope in `mapping.json` (preserved via Phase-4 re-pointing, not ported).
