# Spec family: regeneration

**v2 owner:** `chat` slice (regenerate is a turn variant; group-aware blocking rules).

## e2e behaviors

### `e2e/chat/regeneration.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Retrying a user message deletes the AI response and streams a new one | `retry user message deletes AI response and streams new one` | chat |
| Regenerating an AI response keeps the user message | `regenerate AI response keeps user message` | chat |
| Editing a user message pre-fills the input and streams a new response | `edit user message pre-fills input and streams new response` | chat |
| Cancelling an edit returns to normal state | `cancel edit returns to normal` | chat (web) |
| Retrying the **first** message clears the entire conversation | `retry first message clears entire conversation` | chat |
| Action buttons (retry/edit/regenerate) are hidden during streaming | `action buttons not visible during streaming` | chat (web) |
| Retry on a failed multi-model tile regenerates only the failed model, not the primary | `retry on a failed multi-model tile regenerates the failed model, not the primary` (driven by `x-mock-failing-models`) | chat |

### Group rules — same file, `Group Chat Regeneration` block (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Retry own message allowed when no other user replied after it | `retry own message works when no other user replied after` | chat |
| Retry blocked when another user replied after | `retry blocked when other user replied after` | chat |
| Cannot retry/edit other users' messages | `cannot retry/edit other user messages` | chat |
| Regenerate AI blocked when another user replied after | `regenerate AI blocked when other user replied after` | chat |
| Regenerate AI allowed when no other user replied after | `regenerate AI works when no other user replied after` | chat |

### Smart Model regeneration

Regenerate re-runs classification (fresh classifier call + bill) — captured in
`smart-model.md` (`e2e/chat/smart-model.spec.ts` :: `regenerate re-runs classification
and records a fresh response`).

### Media regeneration

Regenerate/edit/retry on image and video prompts replace the media with a fresh
generation — captured in `media.md`
(`e2e/chat/image-generation.spec.ts`, `e2e/chat/video-generation.spec.ts`).

### Fork interaction

Regeneration × fork semantics (regenerate-on-fork isolation, pre-fork-point
preservation) — captured in `forking.md` (`e2e/chat/fork-regeneration.spec.ts`); the
persistence mechanism is the `batchId` orphan-preservation rule
(`packages/db/src/schema/messages.ts:22-35`).

## Integration behaviors

| Behavior area | Source | v2 slice |
| --- | --- | --- |
| Regenerate request path through the chat route (delete-and-replace semantics, parent-chain updates) | `apps/api/src/routes/chat.test.ts`, `apps/api/src/routes/chat.parent-chain.integration.test.ts` | chat |

Gap (explicit): no dedicated integration test file for the group "blocked when other
user replied after" rule was identified this session — the rule is encoded in e2e only.
The v2 chat slice must port it into integration tests (the e2e titles above are the
source contract).
