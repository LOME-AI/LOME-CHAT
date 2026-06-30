# Spec family: sharing

**v2 owner:** `conversations` slice (`shared_links`, `shared_messages`, link privileges,
the unauthenticated public share read endpoint) with `identity` (link-guest as a
first-class principal) and `media` (share-path presign carve-out).

## e2e behaviors

### `e2e/sharing/shared-content.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Invite link grants the shared-conversation view; a revoked link shows an error | `invite link: shared conversation view and revoked link error` | conversations |
| Shared message link shows decrypted content (share-key wrap, client-side decrypt) | `shared message link shows decrypted content` | conversations |
| Invalid share links show error states | `invalid share links show error states` | conversations |
| Shared image message: guest sees the rendered image (share-path presign) | `shared image message: guest sees the rendered image` | media (§12 carve-out) |
| Shared video message: guest plays the rendered video | `shared video message: guest plays the rendered video` | media |
| Share-create POST body stays small — no inline media bytes | `share-create POST body stays small (no inline media bytes)` | conversations |
| Revoked message share 404s on fetch (lazy enforcement at read) | `revoked message share returns 404 on fetch` | conversations |
| Group invite link surfaces generated image AND video to guests | `group invite link surfaces generated image and video to guests` | conversations + media |

### `e2e/sharing/link-guest-access.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| With-history link guests can view past messages and interact | `with-history link guests can view and interact` | conversations + identity |
| Without-history link guests see only post-link messages (`visibleFromEpoch`) | `without-history link guests see only post-link messages` | conversations |
| Read-privileged guest sees a read-only notice on a blank conversation | `read guest sees read-only notice on blank conversation` | conversations |
| Link guests do not see a leave button in the member sidebar | `link guest does not see leave button in member sidebar` | conversations (web) |

### `e2e/sharing/link-guest-chat.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Write-privileged guests can send messages and get AI responses (funded by delegated budget — Inferred from group-billing family) | `write-privileged guest can send messages and get AI responses` | chat + billing |

### `e2e/auth/auth-using-link.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| A **logged-in member** opening a history link sees decrypted messages (link use by authenticated users) | `logged-in member using history link sees decrypted messages` | conversations + identity |
| A logged-in member using a no-history link sees only new messages | `logged-in member using no-history link sees only new messages` | conversations |

## Integration behaviors

### `apps/api/src/routes/message-shares.test.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Share creation requires auth + conversation membership (`SHARE_FORBIDDEN` otherwise); missing message → 404 | `returns 401 when not authenticated`, `returns 403 with SHARE_FORBIDDEN when user is not a member of the conversation`, `returns 404 when message not found` | conversations |
| Share creation returns 201 with `shareId`; `wrappedShareKey` is base64-decoded before storage | `creates share and returns 201 with shareId`, `decodes wrappedShareKey from base64 before storing` | conversations |
| Public GET `/:shareId` requires **no** authentication; returns wrapped key + content items | `does not require authentication`, `returns share data with wrappedShareKey and content items` | conversations |
| Public share GET mints a presigned `downloadUrl` per media item and **strips `storageKey`**; text items get no URL | `mints a presigned downloadUrl for each media content item and strips storageKey`, `does not mint a downloadUrl for text content items` | media |
| Disallowed stored mimeType or presign failure → 500 `STORAGE_READ_FAILED` | `returns 500 with STORAGE_READ_FAILED when stored mimeType is not in the allowlist`, `returns 500 when presigned URL minting fails` | media |

### `apps/api/src/routes/links.test.ts` — link CRUD/authz (titles in `group.md`)

Link creation/revocation requires admin+ privilege; no-history links carry rotation and
compute `visibleFromEpoch`; revocation rotates the epoch (the rotation behaviors are in
`group.md` because they are member/epoch semantics).

### Crypto layer

`packages/crypto/src/sharing.test.ts` — share-key wrap/unwrap round-trip (owner:
`packages/crypto`, unchanged in v2).

## Rate limits this family pins

`shareGetIpRateLimit` 30/60 s (unauthenticated share lookup, anti-scraping),
`shareCreateUserRateLimit` 20/60 s — `apps/api/src/lib/redis-registry.ts:167-179`.
Shared-link expiry/revocation is enforced lazily at read (`shared_links.revokedAt`/
`expiresAt` — ARCHITECTURE.md data-model essentials; e2e revoked-link tests above).
