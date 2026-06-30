# Spec family: group

**v2 owner:** `conversations` slice (members, epochs, rotation, invites, budgets-config,
member limit) with `billing` (group budget resolution), `chat` (turn semantics in
groups), and realtime delivery via the ConversationRoom DO.

## e2e behaviors

### `e2e/group/group-chat-admin.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Sender labels render, consecutive messages group, and the per-conversation AI toggle works | `displays sender labels, groups consecutive messages, and AI toggle works` | chat + conversations |
| Member sidebar shows sections, privilege badges, and search | `member sidebar displays correctly with sections, badges, and search` | conversations |
| Member lifecycle: add, change privilege, remove | `member lifecycle: add, change privilege, remove` | conversations |
| Invite link lifecycle: create, rename, change privilege, revoke | `invite link lifecycle: create, rename, change privilege, revoke` | conversations |
| Budget settings: owner editable, non-owner read-only | `budget settings: owner editable, non-owner read-only` | conversations + billing |
| Sharing an AI message creates a shareable link | `share AI message creates shareable link` | conversations |
| Adding a member **without history** keeps the adder's access to old messages after refresh (rotation must not lock out existing members) | `add member without history: adder retains access to old messages after page refresh` | conversations |

### `e2e/group/group-chat-billing.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Owner-funded mode: with all budgets active, the owner pays for member sends | `owner-funded: all budgets active, owner pays` | billing |
| Member budget exhausted → member falls through to their personal free allowance | `personal free-allowance fallthrough » member budget exhausted: falls through to free allowance` | billing |
| Conversation budget exhausted → falls through to free allowance | `personal free-allowance fallthrough » conversation budget exhausted: falls through to free allowance` | billing |
| Owner balance exhausted → paid member uses personal balance | `owner balance exhausted: paid member uses personal balance` | billing |
| Budget visibility: footer and modal reflect spending | `budget visibility: footer and modal reflect spending` | billing (read) |

Funding resolution is `min(conversationRemaining, memberRemaining, ownerRemaining)` —
`packages/shared/src/budget.ts:713-719`; decision logic in
`packages/shared/src/resolve-billing.ts` (+ `resolve-billing.test.ts`,
`resolve-billing.consistency.test.ts`).

### `e2e/group/group-chat-leave.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Non-owner leave navigates to /chat | `non-owner leave navigates to /chat` | conversations |
| Owner leave warns about deletion and destroys the conversation | `owner leave shows deletion warning and destroys conversation` | conversations |
| Non-owner leave from the sidebar dropdown rotates the epoch and navigates | `non-owner leave from sidebar dropdown rotates epoch and navigates` | conversations |
| Leaving a non-active chat from the sidebar leaves the URL unchanged | `leave from sidebar of a non-active chat leaves URL unchanged` | conversations (web) |
| Cancelling leave keeps the user in the conversation | `cancel leave keeps user in conversation` | conversations |

### `e2e/group/realtime.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| A user-only message appears for the other member in real time | `user-only message appears for other member in real time` | chat + realtime |
| During AI streaming, the other member sees the user message immediately and the AI response progressively | `AI streaming: Bob sees Alice user message immediately and AI response progressively` | chat + realtime |
| Typing indicator shows for the other member | `typing indicator shows for other member` | realtime |

### `e2e/auth/auth-member-access.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Read-member lifecycle: history access, removal (loses access), no-history re-add (sees only new epoch), privilege elevation | `read member lifecycle: history access, removal, no-history re-add, privilege elevation` | conversations |

### `e2e/sharing/inbox-decline-invite.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| A pending invite can be declined from the inbox | `Bob declines a pending invite from Alice` | conversations |

## Integration behaviors — key rotation (the §19 "key-rotation gates")

### `apps/api/src/routes/members-rotation.integration.test.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Add-without-history triggers an epoch rotation | `add-without-history triggers rotation` | conversations |
| Removing a member triggers rotation | `remove member triggers rotation` | conversations |
| Non-owner leave triggers rotation; owner leave deletes the conversation (no rotation) | `non-owner leave triggers rotation`, `owner leave deletes conversation (no rotation)` | conversations |
| With-history members see all messages; without-history only the new epoch (`visibleFromEpoch`) | `new member with history sees all messages, without history sees only new epoch` | conversations |
| Concurrent rotation is first-write-wins | `concurrent rotation: first-write-wins` | conversations |
| Link revocation triggers rotation | `link revocation triggers rotation` | conversations |
| Rotation with mixed user + link members preserves both | `rotation with mixed user + link members preserves both` | conversations |
| Key-chain traversal works across three sequential rotations | `three sequential rotations with chain link traversal` | conversations |
| Add-without-history retries idempotently | `idempotent retry of add-without-history` | conversations |
| New member can decrypt the re-encrypted title | `new member can decrypt re-encrypted title` | conversations |
| Remove + re-add the same user works | `remove + re-add same user` | conversations |
| No-history members/guests **cannot** derive previous-epoch keys via chain links; with-history members/guests can traverse to epoch 1 | `no-history auth user cannot derive previous epoch key via chain links` (+ link-guest variants, with-history variants) | conversations |
| No-history member with later rotations can access from join epoch but not before | `no-history member with later rotations can access from join epoch but not before` | conversations |

### `apps/api/src/routes/members.test.ts` / `links.test.ts` / `keys.test.ts` (titles Verified, selected)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Member add requires admin+ privilege (write/read → 403); target already active → 409; member limit (100) → 400 | `returns 403 when requester has write privilege`, `returns 409 when target is already an active member`, `returns 400 when conversation has reached member limit` | conversations |
| Members are inserted with `acceptedAt` null and `invitedByUserId` set (invite-accept flow) | `inserts member with acceptedAt null and invitedByUserId set` | conversations |
| `giveFullHistory=false` requires rotation payload → 400 | `returns 400 when giveFullHistory=false without rotation` (members) / `returns 400 when giveFullHistory is false and rotation is missing` (links) | conversations |
| Link creation requires admin+; member limit applies; epoch-rotation race returns 409; rotation completion broadcasts `rotation:complete` | `returns 403 when privilege is below admin`, `returns 400 when conversation has reached member limit`, `returns 409 when epoch has rotated between query and transaction`, `broadcasts rotation:complete when creating no-history link with rotation` | conversations + realtime |
| Key-chain reads: wraps + chain links per epoch; wraps excluded before `visibleFromEpoch`; read-privileged members can still fetch member keys (needed to leave); batch endpoint caps at 100 ids and reports missing/unauthorized ids | `returns key chain with wraps and empty chainLinks for epoch 1`, `excludes wraps for epochs before visibleFromEpoch`, `allows read-privileged members to fetch keys (lowest tier can still leave)`, `rejects request with more than 100 conversation IDs` | conversations |
| Guest members surface displayName from the shared link; guest userId maps to linkId for sender resolution | `includes guest members with display name from shared link`, `maps guest userId to linkId for sender resolution` | conversations |

### Budgets — `apps/api/src/routes/budgets.test.ts`

Member/conversation budget CRUD and read surfaces (titles not captured this session —
read at port time). Period-keyed spending rows: `member_budgets` /
`conversation_spending` (v2 keeps period-keyed writes at settlement, no reset jobs).
