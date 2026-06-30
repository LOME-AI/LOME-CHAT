# Spec family: forking

**v2 owner:** `conversations` slice (`conversation_forks` table, fork CRUD, limits)
with `chat` (fork-aware message filtering and regeneration interaction).

## e2e behaviors

### `e2e/chat/forking.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Creating the first fork shows tab UI with "Main" and "Fork 1" | `create first fork shows tab UI with Main and Fork 1` | conversations |
| Switching fork tabs shows different message sets | `switch between fork tabs shows different messages` | conversations + chat |
| A second fork can be created | `create second fork` | conversations |
| Fork rename via three-dot menu | `rename fork via three-dot menu` | conversations |
| Fork delete via three-dot menu | `delete fork via three-dot menu` | conversations |
| Deleting the last fork reverts the conversation to linear (no tabs) | `delete last fork reverts to linear` | conversations |
| Fork limit (5 — `MAX_FORKS_PER_CONVERSATION`, `packages/shared/src/constants.ts:240`) is enforced | `fork limit enforced` | conversations |
| `?fork=` URL param loads the correct fork on page load; refresh preserves the active fork; invalid fork id falls back gracefully | `fork URL param loads correct fork on page load`, `page refresh preserves active fork`, `invalid fork ID in URL falls back gracefully` | conversations (web) |
| In group chats, write+ members can fork and tabs are visible to both users | `Group Chat Forking » write+ member can fork, tabs visible to both users` | conversations |
| Fork preserves all message history in both branches; messages before the fork point are visible on both branches | `Fork History Preservation » fork preserves all message history in both branches`, `messages before fork point visible on both branches` | chat |
| Forking from a generated image preserves the image in both branches | `fork from a generated image preserves the image in both branches` | chat + media |
| Forking from a multi-model response preserves sibling AI messages | `fork from multi-model response preserves sibling AI messages` | chat (batchId semantics) |

### `e2e/chat/fork-regeneration.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Regenerating on a fork only affects that fork | `regenerate on fork only affects that fork` | chat |
| Regenerating before the fork point preserves messages shared with other branches (fork-preserved orphans — see `batchId` comment, `packages/db/src/schema/messages.ts:22-35`) | `regenerate before fork point preserves shared messages` | chat |
| A fork can be created from a fork (nesting) | `nested fork from a fork` | conversations |
| Deleting a fork preserves messages shared with other forks | `delete fork preserves shared messages for other forks` | conversations + chat |

## Integration behaviors — `apps/api/src/routes/forks.test.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Fork creation requires membership; non-members get 404 | `returns 404 for non-member` | conversations |
| First fork creates "Main" + "Fork 1" pair | `creates fork with Main + Fork 1 when no forks exist` | conversations |
| Fork creation is idempotent on the client-supplied fork id | `returns existing forks idempotently when same fork ID provided` | conversations |
| Custom fork names are accepted; duplicate names rejected (create and rename → 409) | `creates fork with custom name`, `returns error for duplicate fork name`, `returns 409 for duplicate name on rename` | conversations |
| Write-privileged members can create forks | `write member can create fork` | conversations |
| Fork delete returns remaining forks and is idempotent | `deletes fork and returns remaining forks`, `returns 200 idempotently when fork already deleted` | conversations |
| Solo conversation owner forks via their conversationMembers row; non-member rejected | `allows owner to create fork via conversationMembers row`, `rejects non-owner non-member on solo conversation` | conversations |

Service-level coverage: `apps/api/src/services/forks/forks.test.ts` (fork limit
enforcement at `apps/api/src/services/forks/forks.ts:210-213`).
