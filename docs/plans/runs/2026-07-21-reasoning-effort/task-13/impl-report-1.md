# T13 — Reasoning token count exposure — impl report 1

## Objective

Per plan §Task-T13: (a) message fetch responses carry the persisted reasoning token count
(`llm_completions.reasoningTokens` via the message-history read path, no new table writers);
(b) the live count reaches the optimistic message during streaming (finish/usage frame →
client accumulation); (c) `Message.reasoningTokens` populated in both paths, zero-reasoning
messages carry 0/absent and render no private-reasoning line; (d) `regenerateTurnBodySchema`
gains `reasoningEffort` with body-hash participation + validation parity, and the client
regenerate path carries the selection.

## Deviation of record — read-path location

The plan says "via the chat slice's published read path" and lists files
`apps/api/src/slices/chat/**`. Verified: **no message-fetch read exists in the chat slice**
(chat's barrel `apps/api/src/slices/chat/index.ts` publishes no history read; chat routes
expose no GET for messages). The actual message-fetch path is the **conversations** slice's
history read (`GET /conversations/:id/messages` → `getMessageHistory` →
`contentItemsByMessage`, `apps/api/src/slices/conversations/`), which already reads
chat-owned `messages`/`content_items` directly in its adapter (established precedent; the
arch rule `single-writer-per-table` constrains writes only). I implemented (a) there — the
only possible location — plus the client contract in `packages/shared/src/schemas/api/conversations.ts`
and the decrypt pipeline in `apps/web/src/hooks/crypto/use-decrypted-messages.ts`, all outside
the task's listed file set. No live task owns these files (T7's concurrent work is confined to
`workflows/nodes/smart-model-execution.ts`, untouched). "No new table writers" holds: the
read is a read-only `usage_records → llm_completions` join.

## Files changed

- `apps/api/src/slices/chat/routes.ts` — `regenerateTurnBodySchema` + `reasoningEffort`; `regenerateTurnBodyHash` spreads it (absent hashes pre-feature shape).
- `apps/api/src/slices/chat/routes.integration.test.ts` — 4 new regenerate tests (node threading, 2 validation-parity 400s, hash pin mirroring the startTurn pattern).
- `apps/api/src/slices/conversations/adapters/stores.ts` — `reasoningTokensByContentItem` (usage_records⋈llm_completions, summed per item) folded into `contentItemsByMessage`.
- `apps/api/src/slices/conversations/ports/stores.ts` — `ContentItemRow.reasoningTokens: number | null`.
- `apps/api/src/slices/conversations/domain/history.ts` — `historyContentItemViewSchema` + `reasoningTokens` (nullable int), projected in `historyContentItemView`.
- `apps/api/src/slices/conversations/domain/history.test.ts` / `shares.test.ts` — fixture field + 2 projection unit tests.
- `apps/api/src/slices/conversations/routes.integration.test.ts` — `seedLlmCompletion` helper + 4 history-read tests (count, multi-row sum, null, zero).
- `packages/shared/src/schemas/api/conversations.ts` — `contentItemResponseSchema.reasoningTokens` optional nonneg int (+3 schema tests).
- `apps/web/src/hooks/chat/chat.ts` — history view field + `toContentItemResponse` maps it (null → absent) (+2 tests in chat.test.tsx).
- `apps/web/src/hooks/crypto/use-decrypted-messages.ts` — `sumReasoningTokens`; `Message.reasoningTokens` set only when > 0 (+2 tests incl. reload-parity and zero-absent).
- `apps/web/src/lib/chat-run.ts` — finish frame's `usage.reasoningTokens` → new `onReasoningTokens` callback (`dispatchFinish` helper) (+2 tests).
- `apps/web/src/hooks/chat/use-chat-stream.ts` — `StreamOptions.onReasoningTokens` pass-through; `RegenerateStreamRequest.reasoningEffort` sent on the regenerate POST; `wireToken`/`wireMediaStart`/`handlers` extraction to satisfy the complexity rule (+3 tests).
- `apps/web/src/hooks/chat/use-optimistic-messages.ts` — `setOptimisticMessageReasoningTokens` (+1 test).
- `apps/web/src/hooks/chat/use-authenticated-chat.ts` — wires `onReasoningTokens` on both accumulation paths (optimistic store + create-mode localMessages); `handleRegenerate` carries `reasoningEffort` (+3 tests).
- `apps/web/src/lib/api.ts` — `Message.reasoningTokens` comment updated (now populated; was honestly-unpopulated).

## Tests added (name — behavior — criterion)

API regenerate (routes.integration.test.ts): threads reasoningEffort onto the regenerated
answer node (d); refuses explicit level on non-reasoning-model / Smart-Model regenerate, 400
(d parity); scopes reasoningEffort into the regenerate dedup body hash with exact
canonical-shape pins (d hash). History read (conversations routes.integration + history.test):
count served, multi-completion sum, null when no row, 0 when zero-spend (a). Shared schema:
accepts/absents/rejects-negative (c contract). Web: chat.test.tsx wire→response mapping incl.
null→absent (a); use-decrypted-messages populates on reload / absent at zero — reload parity
(c); chat-run surfaces finish count per tile / silent when absent (b); use-chat-stream
forwards to onReasoningTokens + regenerate body carries/omits reasoningEffort (b, d);
use-optimistic-messages setter stamps matching message (b); use-authenticated-chat stamps
live count onto streaming tile + regenerate request carries/omits effort (b, d). All watched
fail for the right reason before implementation (schema-strip, missing field, missing
callback/function).

## Self-gate (scoped per §Gate-policy-amendment)

- `tsc --noEmit` apps/api — pass. packages/shared — pass. apps/web — fails ONLY on the two recorded foreign errors (`../api/src/middleware/pipeline-bindings.ts` ExecutionContext; `model-list-body.test.tsx:41`) — both listed in §Known-foreign-failures, files untouched.
- `eslint <all touched files>` from each package dir, after the final edit — pass (0 problems).
- `apps/api/src/slices/chat/routes.integration.test.ts` full file — 184/184 pass.
- `apps/api/src/slices/conversations/routes.integration.test.ts` full file — 255/255 pass.
- `history.test.ts` + `shares.test.ts` — 68/68 pass.
- `packages/shared/.../conversations.test.ts` — 173/173 pass.
- Web scoped batch (chat-run, use-chat-stream, chat, use-optimistic-messages, use-authenticated-chat, use-decrypted-messages ×2, thinking-disclosure, message-item) — 403/403 pass (message-item run with env via with-env; it fails on env parse without it, pre-existing harness behavior).
- Coverage/full-package gates deliberately not run (§Gate-policy-amendment: Phase-4 close only).

## Acceptance criteria

- (a) fetch carries persisted count — **met** (history read + integration tests; sum across completion rows; null for none).
- (b) live count reaches optimistic message — **met** (finish frame → onReasoningTokens → optimistic setter; also create-mode localMessages path; tests pin it).
- (c) `Message.reasoningTokens` populated both paths; zero → 0/absent, no line — **met** (absent-at-zero normalization on both paths; ThinkingDisclosure already renders nothing at 0 — pinned by existing T10 tests).
- Fetch shape / live update / reload parity test-pinned — **met** (chat.test.tsx; use-authenticated-chat live test; use-decrypted-messages reload-parity test).
- (d) regenerate schema + hash + validation parity + client carries selection — **met** (schema+hash lines; 4 API tests mirroring startTurn's hash-pin pattern; client request field wired end-to-end with tests).

## Deviations

- Read path implemented in the conversations slice + shared schema + hooks/crypto (see "Deviation of record" above) — the plan's file list presumed a chat-slice read path that does not exist.
- The brief's cited hash-pin pattern location (routes.integration.test.ts:1218-1264) had drifted; the actual startTurn hash-pin test at ~1446 was mirrored.
- Zero counts are normalized to *absent* on the client (`> 0` gate) rather than carrying literal 0 — criterion allows "0/absent"; absent keeps the `Message` field's no-line semantics uniform with the live path (which never fires at 0 because providers omit the field).

## Concerns and limitations

- Foreign concurrent diff observed mid-task: `packages/config/vitest.config.ts` gained `sequence: { concurrent: true }, maxConcurrency: 12` (not mine, not in my start snapshot). Under subset filters (`-t 'reasoning'`) three PRE-EXISTING trial tests in chat routes.integration fail (403 vs 402 — trial quota contention under concurrency); they pass in isolation and the FULL file passes 184/184. Not caused by my diff; attributed to that foreign config change.
- The trial path does not surface the live count into the trial UI (its own hook); criteria name only the optimistic-message path — untouched.
- Public-share read row now carries `reasoningTokens` internally but the slim share view deliberately does not project it (consistent with cost/model stripping).
- `arch:check` not run (full gate, Phase-4 close); the only rule plausibly touched is single-writer, which checks writes — none added.

## Confidence

High — every behavior TDD-pinned red→green; full integration files for both touched routes green; lint/typecheck clean on all owned files; foreign failures match the recorded list exactly.
