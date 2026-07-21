# Regenerate wire-shape research (IC-5 / RC-5) — RULED: pick best from legacy

(Persisted by orchestrator from the read-only Explore return.)

## Current contract (active codebase)
- Send schema `startTurnBodySchema` (chat routes.ts:98): `models: array().min(2).max(5).optional()`, `model` required. Server derives `body.models ?? [body.model]` (routes.ts:471,549,733).
- Regenerate schema `regenerateTurnBodySchema` (routes.ts:130-171, bound at :982): `model` required (:133), `models` optional `.min(2).max(5)` (:142), `targetMessageId`, `action:'retry'|'edit'`, `replaceAssistantId` optional (:148). Same `body.models ?? [body.model]` derivation.
- `replaceAssistantId` set = regenerate-one (delete only that tile); unset = retry-all. Semantics in packages/shared/src/schemas/api/conversations.ts:415-421, guarded in chat/domain/regenerate-guard.ts.
- Client builder use-chat-stream.ts:601-616: sends `model: request.models[0]`, spreads `models` ONLY when length ≥ 2. So single-model regenerate-one / retry-failed-tile send `{model, replaceAssistantId}` and OMIT `models`. List resolved in apps/web/src/lib/chat-regeneration.ts:202-213.
- CONFLICT: server forbids 1-element `models` (min 2), so client can't send `models:[x]`; tests assert `body.models[1]` / `models.length===1`.

## Legacy (deployed monolith)
- `POST /chat/:conversationId/regenerate` (legacy/apps/api/src/legacy/routes/chat.ts:969) validates with shared `regenerateRequestSchema` = `models: array().min(1).max(5)`, NO singular `model`; `replaceAssistantId` optional. Handler destructures `{models, replaceAssistantId}` (chat.ts:980-1000).
- Legacy represented EVERY regenerate (incl. single) as `models[]` (len 1 or N), distinguishing regenerate-one from retry-all purely via `replaceAssistantId` set/unset (tree-action.ts:25-34,88-90,176-180).

## Failing tests (assert the legacy shape)
- multi-model-regeneration.spec.ts: retry-all (82-86) `action:'retry'`, `models.length===2`, `replaceAssistantId` undefined; regenerate-one (146-150) `models.length===1`, `replaceAssistantId===toReplace.id`.
- regeneration.spec.ts:236 retry-failed multi-model tile asserts `body.models` toEqual `[failModelId]`.

## RECOMMENDATION — adopt legacy shape (option b). App-only changes, tests unchanged:
1. Schema chat routes.ts:142 — regenerate `models` `.min(2)`→`.min(1)` (regenerate path ONLY; send-side startTurnBodySchema:98 keeps `.min(2)`). Make `models` required; drop reliance on singular `model` (or keep `model` optional as anchor derived from `models[0]`). Downstream `body.models ?? [body.model]` already tolerates it.
2. Client use-chat-stream.ts:609 — remove the `>= 2` conditional; always send `models: request.models` (len ≥ 1). chat-regeneration.ts:202-213 already returns a correct 1-element array; no change.
3. Enforcement: Rung 1 — type the regenerate wire body so `models` is a required non-empty array. Rung 3 — shared contract test asserting regenerate accepts `models.min(1)` while send requires `.min(2)` (bounds intentional, not accidentally symmetric). The e2e body-shape assertions stay green as Rung 4.

## Orchestrator note
Implementation (Task-18) edits chat routes.ts (Task-07's file) and use-chat-stream.ts (possibly Task-08's area). SERIALIZE Task-18 after Task-07 lands; check use-chat-stream.ts isn't mid-edit by Task-08 before dispatch.
