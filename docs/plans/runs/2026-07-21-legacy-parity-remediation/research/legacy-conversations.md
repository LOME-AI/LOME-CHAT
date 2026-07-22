# Legacy → New research: conversations slice (R2, R12, R14, R15, R20)

Grounding for `docs/history/2026-07-21-legacy-parity-audit.md`. All snippets read this
session, `file:line` verbatim.

---

### R2 — media `width`/`height`/`durationMs` dropped from history + public-share wire shapes

**LEGACY** `legacy/LEGACY-BEHAVIOR-REPORT.md:850-853` (conversation/message history read):

```
- Content item fields exposed in the conversation/message view (unlike the public-share view,
  which strips generation metadata): `id`, `contentType`, `position`, `encryptedBlob` (base64 or
  null), `storageKey`, `mimeType`, `sizeBytes`, `width`, `height`, `durationMs`, `modelName`,
  `cost`, `isSmartModel`.
```

**LEGACY** `legacy/LEGACY-BEHAVIOR-REPORT.md:1225-1227` (public-share read):

```
- Response fields: `shareId`, `messageId`, `wrappedShareKey` (base64), `contentItems[]`,
  `createdAt` (ISO). Each content item: `id`, `contentType`, `position`, `encryptedBlob` (base64
  or null), `mimeType`, `sizeBytes`, `width`, `height`, `durationMs`, `downloadUrl`, `expiresAt`.
```

Legacy field names/types (both reads): `width: number | null`, `height: number | null`,
`durationMs: number | null` — plain nullable integers, alongside the other content-item
fields each read already serves.

**CURRENT** — base view omits all three, `apps/api/src/slices/conversations/domain/content-item-view.ts:11-18`:

```ts
export const contentItemViewSchema = z.object({
  id: z.string(),
  position: z.number().int(),
  contentType: contentTypeSchema,
  mimeType: z.string().nullable(),
  byteLength: z.number().int().nullable(),
  encryptedBlob: z.string().nullable(),
});
```

`contentItemView()` mapper (same file, `:22-31`) reads only `row.sizeBytes` → `byteLength`;
never reads `row.width` / `row.height` / `row.durationMs`.

`apps/api/src/slices/conversations/domain/history.ts:20-26` — the history view extends the
same slim base with settled display metadata only (`modelName`, `cost`, `isSmartModel`), not
dimensions:

```ts
export const historyContentItemViewSchema = contentItemViewSchema.extend({
  modelName: z.string().nullable(),
  cost: z.string().nullable(),
  isSmartModel: z.boolean(),
});
```

Comment at `history.ts:12-18` states the split is deliberate: the public-share read reuses the
same slim base, so widening the base view for history would leak fields into the share read too
— any fix must widen `contentItemViewSchema` itself (both reads legitimately carried dimensions
in legacy) or add the fields to both extension points independently.

DB columns exist and are populated, `packages/db/src/schema/content-items.ts:37-39`:

```ts
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
```

(columns 34-39 span `storageKey`/`mimeType`/`sizeBytes`/`width`/`height`/`durationMs`; only
`width`/`height`/`durationMs` are the ones never read out — `storageKey`/`mimeType`/`sizeBytes`
already flow through, per `mimeType`/`byteLength` above).

Client types them (nullable, optional in one spot), `apps/web/src/lib/api.ts:140-146`:

```ts
export type MessageMediaItem = Pick<ContentItemResponse, 'id' | 'position'> & {
  contentType: 'image' | 'audio' | 'video';
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
```

Client consumes persisted dims as aspect-ratio tier 2 (now permanently dead —
`aspectRatio` tier-1 or square-fallback tier-3 are the only reachable paths today),
`apps/web/src/components/chat/media/media-preview.tsx:50-73`:

```ts
/**
 * Resolve a media item's aspect ratio. Precedence:
 *   1. An explicit requested ratio (`"16:9"`), known during generation before
 *      any pixel dimensions exist.
 *   2. Persisted pixel dimensions (decrypt-load path).
 *   3. Square fallback when nothing is known.
 */
export function mediaRatio(
  aspectRatio: string | undefined,
  width: number | null | undefined,
  height: number | null | undefined
): MediaRatio {
  ...
  if (width && height) {
    return { value: width / height, css: `${String(width)} / ${String(height)}` };
  }
  return { value: 1, css: '1 / 1' };
}
```

Adapters hardcode nulls with an explicit acknowledgment comment,
`apps/web/src/hooks/chat/chat.ts:88-113` (history adapter `toContentItemResponse`):

```ts
/**
 * Adapt the slim history content-item view to the `ContentItemResponse` the
 * decrypt pipeline (`useDecryptedMessages`) consumes. Fields the history view
 * does not carry (storageKey, dimensions) are null — ...
 */
function toContentItemResponse(item: HistoryContentItem): ContentItemResponse {
  return {
    id: item.id,
    contentType: item.contentType,
    position: item.position,
    encryptedBlob: item.encryptedBlob,
    storageKey: null,
    mimeType: item.mimeType,
    sizeBytes: item.byteLength,
    width: null,
    height: null,
    durationMs: null,
    modelName: item.modelName,
    cost: item.cost,
    isSmartModel: item.isSmartModel,
  };
}
```

`apps/web/src/hooks/chat/use-shared-message.ts:91-103` (public-share adapter, media branch):

```ts
  return {
    type: 'media',
    position: item.position,
    contentItemId: item.id,
    contentType: item.contentType,
    mimeType: item.mimeType ?? '',
    sizeBytes: item.byteLength ?? 0,
    width: null,
    height: null,
    durationMs: null,
    downloadUrl: grant.downloadUrl,
    expiresAt: grant.expiresAt,
  };
```

Stale dead schema, `packages/shared/src/schemas/api/message-shares.ts:69-88`
(`publicShareContentItemSchema`, full legacy-shaped fields still declared):

```ts
export const publicShareContentItemSchema = z.object({
  id: z.string(),
  contentType: contentTypeSchema,
  position: z.number().int().nonnegative(),
  encryptedBlob: z.string().nullable(),
  mimeType: ALLOWED_MEDIA_MIME_TYPES.nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  downloadUrl: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
```

Verified zero external references (repo-wide grep): only self-referenced within
`message-shares.ts` itself (`:95` as an array member of `publicShareResponseSchema`, `:100` as
its own type export) — no importer anywhere else in the tree.

**DELTA**: widen `contentItemViewSchema` (or both call sites independently, given the
deliberate-split comment) to carry `width: number | null`, `height: number | null`,
`durationMs: number | null`; populate them in `contentItemView()` from `row.width` /
`row.height` / `row.durationMs` (`ContentItemRow` port — not read in this session, but the DB
row already carries them per the schema above); thread through both client adapters
(`chat.ts:88-113`, `use-shared-message.ts:98-100`) to stop hardcoding `null`; either wire
`publicShareContentItemSchema` to a real consumer or delete it as dead code (report already
flags it as stale, zero refs).

**NOTES**: the history view and public-share view are two independent Zod extension points
sharing one slim base (`contentItemViewSchema`) — the base itself has no dimension fields, so
either both callers need the fields added to the base (simplest, matches legacy where both reads
carried them) or each extends independently, matching the existing `historyContentItemViewSchema`
pattern. Did not open `ports/index.ts`'s `ContentItemRow` type this session to confirm whether
`width`/`height`/`durationMs` are already present on the port row (the DB schema has the columns;
the store's `select` projection was not inspected) — that read is needed before implementing.

---

### R12 — Link/guest display-name cap silently changed 100 → 200

**LEGACY** `legacy/LEGACY-BEHAVIOR-REPORT.md:935-936` (create link body):

```
- Body: `linkPublicKey` (base64), `memberWrap` (base64), `privilege` (string), `giveFullHistory`
  (boolean), optional `displayName` (`min(1).max(100)`), optional `rotation`.
```

Report also cites L994 (rename link, admin) and L1002 (a third display-name site — not opened
verbatim this session beyond the L936 citation, but the audit's cross-reference implies the same
`min(1).max(100)` cap applies uniformly across all three legacy display-name fields).

**CURRENT** — single shared constant, `apps/api/src/slices/conversations/domain/schemas.ts:31`:

```ts
export const SHARE_DISPLAY_NAME_MAX_LENGTH = 200;
```

All three consumers, same file:

- `:185` — `createLinkBodySchema.displayName`:
  `z.string().min(1).max(SHARE_DISPLAY_NAME_MAX_LENGTH).optional()`
- `:238` — `changeLinkNameBodySchema.displayName` (admin-driven link rename):
  `z.string().min(1).max(SHARE_DISPLAY_NAME_MAX_LENGTH)`
- `:243` — `setMyNameBodySchema.displayName` (link-guest renaming own label):
  `z.string().min(1).max(SHARE_DISPLAY_NAME_MAX_LENGTH)`

Repo-wide grep confirms these three (plus the constant's own declaration) are the only
`SHARE_DISPLAY_NAME_MAX_LENGTH` references in the tree — no test currently pins the 100/200/201
boundary (`schemas.test.ts` only boundary-tests `renameForkBodySchema` at `:143`;
`my-name.test.ts` / `shares.test.ts` use short literal names like `'old'`, `'new'`, `'x'`, none
near the 100–200 boundary), so no test needs adjusting for the length value itself.

**DELTA**: change `SHARE_DISPLAY_NAME_MAX_LENGTH` from `200` to `100` at
`schemas.ts:31` — single edit, all three consumers pick it up automatically since they all
reference the shared constant already (no per-site duplication to fix).

**NOTES**: none — this is a clean single-constant restoration with no independent copies to
find.

---

### R14 — Member-removal refusal code inconsistent with sibling privilege-change path

**LEGACY** `legacy/LEGACY-BEHAVIOR-REPORT.md:1071-1073` (remove member):

```
- Requester privilege check via `canRemoveMember` → `403 PRIVILEGE_INSUFFICIENT` if requester
  isn't strictly senior target (e.g. admin cannot remove admin; write-privilege user can
  never remove anyone).
```

**LEGACY** `legacy/LEGACY-BEHAVIOR-REPORT.md:1085-1086` (change member privilege):

```
- `canChangePrivilege` gate → `403 PRIVILEGE_INSUFFICIENT` otherwise (e.g.
```

(line 1086 truncates at the read window boundary but the code before it, `:1080-1085`, is the
`PATCH /api/members/:conversationId/privilege` handler; both legacy refusal branches use the
identical `403 PRIVILEGE_INSUFFICIENT` code.)

**CURRENT** — removal uses the generic `'forbidden'` refusal,
`apps/api/src/slices/conversations/domain/members.ts:370`:

```ts
if (!canRemoveMember(caller.privilege, target.privilege)) return { refusal: 'forbidden' };
```

which resolves through `apps/api/src/slices/conversations/domain/outcomes.ts:55-57`:

```ts
.with(
  { refusal: 'forbidden' },
  (): WireRefusal => ({ code: ERROR_CODES.FORBIDDEN, status: 403 })
)
```

Privilege-change keeps the distinct code, with an explicit comment citing the legacy split,
`members.ts:643-648`:

```ts
      if (!canChangePrivilege(caller.privilege, target.privilege, privilege)) {
        // Legacy returns the distinct PRIVILEGE_INSUFFICIENT (403) for an
        // over-grant / not-strictly-below refusal, not the generic FORBIDDEN
        // the non-admin-caller rung above uses.
        return okAsync<ChangePrivilegeOutcome>({ refusal: 'privilege-insufficient' });
      }
```

resolving through `outcomes.ts:104-106`:

```ts
.with(
  { refusal: 'privilege-insufficient' },
  (): WireRefusal => ({ code: ERROR_CODES.PRIVILEGE_INSUFFICIENT, status: 403 })
)
```

Current `PRIVILEGE_INSUFFICIENT` copy is narrowed to privilege-*setting* wording,
`packages/shared/src/error-codes.ts:197`:

```ts
  PRIVILEGE_INSUFFICIENT: "You can't set a privilege at or above your own level.",
```

(sits in `ERROR_MESSAGES`, the source `friendlyErrorMessage()` reads from —
`error-codes.ts:250`; `packages/shared/src/error-messages.ts` holds only the branded
`UserFacingMessage` type, not the message table itself, per its own header comment at `:6`).
For comparison, the generic `FORBIDDEN` copy is `error-codes.ts:136`:
`"You don't have permission to do this."` — accurate but not removal-specific, same as legacy's
problem (legacy used the *same* specific code for both cases, this repo split them and only
half-restored the specific wording).

The `refusalSchema` discriminated union already has a slot pattern to add a sibling literal if
chosen — `outcomes.ts:14-31` lists 16 refusal variants including `privilege-insufficient` (`:27`)
right next to `cannot-remove-owner` (`:24`) / `cannot-remove-self` (`:25`), i.e. the
removal-specific refusals already live beside where a new removal-privilege refusal would go.

**DELTA options** (both restore parity with legacy's single `PRIVILEGE_INSUFFICIENT` code on
both paths; task asks to record both, note which is cleaner):

1. **Broaden `PRIVILEGE_INSUFFICIENT` copy + reuse it for removal.** Change
   `members.ts:370`'s `{ refusal: 'forbidden' }` to `{ refusal: 'privilege-insufficient' }`, and
   reword `error-codes.ts:197` to cover both actions (e.g. "You don't have sufficient privilege
   over this member."). One code, one copy, matches legacy's actual behavior (legacy used one
   code for both). Requires touching the shared error-message table (a copy a `friendlyErrorMessage`
   consumer already reads) but no new refusal variant, no new `ERROR_CODES` entry, no new
   `STATUS_BY_DOMAIN_CODE`/`DOMAIN_ERROR_CODE_TO_WIRE_CODE` wiring.
2. **Add a sibling code** (e.g. `REMOVAL_PRIVILEGE_INSUFFICIENT`) with its own copy, its own
   refusal literal in `refusalSchema`, its own `.with()` arm in `refusalToWire()`, its own
   `ERROR_CODES` + `ERROR_MESSAGES` entries. Preserves the current narrowed
   privilege-*setting* copy untouched but is more surface area for a distinction legacy itself
   did not make (legacy's `PRIVILEGE_INSUFFICIENT` was already shared across both routes).

Option 1 is the closer parity restoration (legacy never had two codes here) and is the smaller
diff — no new `ERROR_CODES` entry, no new refusal-union member, no new match arm; only the
`members.ts:370` refusal literal and the `error-codes.ts:197` copy change. Option 2 only makes
sense if product wants the two messages to read differently going forward, which would be a
new decision, not a restoration.

**NOTES**: `friendlyErrorMessage()` and the `ERROR_MESSAGES` table both live in
`packages/shared/src/error-codes.ts` (not `error-messages.ts`, which is comment-only re: holding
just the branded type) — CODE-RULES.md's "`packages/shared/src/error-messages.ts`" reference for
"all user-facing error messages" does not match current file layout; flagging as an ambiguity
only, not resolving it (doc vs. code drift is out of scope for this research task).

---

### R15 — WS-upgrade non-member 403 vs. sibling 404

**LEGACY** `legacy/LEGACY-BEHAVIOR-REPORT.md:3462-3465` (authenticated-user path):

```
**Authenticated user path** (when `c.get('user')` set):
- Queries `conversationMembers` row matching `conversationId = :conversationId AND userId =
  :user.id AND leftAt IS NULL`, selecting only `{ id, privilege }`, `.limit(1)`.
- If no row found → `404` error code `CONVERSATION_NOT_FOUND` (`ERROR_CODE_CONVERSATION_NOT_FOUND`).
- On success, sets `userId` query param on internal upgrade URL to `user.id`.
```

I.e. legacy's WS upgrade hides conversation existence behind a `404` for a non-member, exactly
mirroring how a plain `GET` would look to an outsider.

**CURRENT** — both upgrade-principal resolvers answer `403 FORBIDDEN` instead,
`apps/api/src/slices/conversations/routes.ts:366-374` (user path):

```ts
async function userUpgradePrincipal(
  deps: ConversationsRouteDeps,
  c: Context<AppEnv>,
  conversationId: string,
  userId: string
): Promise<UpgradePrincipal | Response> {
  const member = await deps.stores(c.var.db).members.activeByUser(conversationId, userId);
  if (member.isErr()) return respondDomainError(c, member.error);
  if (member.value === null) return c.json(createErrorResponse(ERROR_CODES.FORBIDDEN), 403);
  ...
```

`routes.ts:385-400` (guest/link path — same shape, same status):

```ts
async function guestUpgradePrincipal(
  deps: ConversationsRouteDeps,
  c: Context<AppEnv>,
  conversationId: string,
  linkId: string
): Promise<UpgradePrincipal | Response> {
  const guest = await deps.stores(c.var.db).members.activeLinkGuest(conversationId, linkId);
  if (guest.isErr()) return respondDomainError(c, guest.error);
  if (guest.value === null) return c.json(createErrorResponse(ERROR_CODES.FORBIDDEN), 403);
  ...
```

Both call sites build the response inline via `c.json(createErrorResponse(...), 403)` — there is
no shared refusal-mapping helper on this path (unlike the domain-refusal flow below), so the fix
is a direct literal swap at each site (`403` → `404`, `ERROR_CODES.FORBIDDEN` →
`ERROR_CODES.NOT_FOUND` or conversation-specific 404 code, matching whatever the sibling GET
emits).

**Sibling GET route** (existence-hiding 404 pattern to mirror) —
`apps/api/src/slices/conversations/domain/conversations.ts:158-167`:

```ts
export function getConversation(
  stores: ConversationsStores,
  params: { readonly conversationId: string; readonly caller: ConversationCaller }
): ResultAsync<Outcome<GetConversationResult>, DomainError> {
  return resolveCallerMember(stores, params.conversationId, params.caller).andThen((member) =>
    member === null
      ? okAsync<Outcome<GetConversationResult>>({ refusal: 'not-found' })
      : loadConversationView(stores, params.conversationId, member)
  );
}
```

A non-member caller (member `=== null` from `resolveCallerMember`) gets the exact same
`{ refusal: 'not-found' }` as a genuinely nonexistent conversation
(`loadConversationView`'s own `record === null` branch at `:176`) — existence is never leaked by
privilege level. This resolves through the shared refusal mapper,
`apps/api/src/slices/conversations/domain/outcomes.ts:49-54`:

```ts
export function refusalToWire(refusal: Refusal): WireRefusal {
  return match(refusal)
    .with(
      { refusal: 'not-found' },
      (): WireRefusal => ({ code: ERROR_CODES.NOT_FOUND, status: 404 })
    )
```

**DELTA**: at `routes.ts:374` and `routes.ts:393`, replace
`c.json(createErrorResponse(ERROR_CODES.FORBIDDEN), 403)` with the `NOT_FOUND`/404 equivalent
(literally, or by routing through the same `refusalToWire({ refusal: 'not-found' })` shape the
sibling GET uses, for consistency) — both a nonexistent conversation and a non-member's socket
attempt must be indistinguishable to the caller, exactly as the sibling `GET` already is.

**NOTES**: the WS routes build their error `Response` directly inline
(`c.json(createErrorResponse(...), status)`), not via the `Outcome`/`refusalToWire` domain-refusal
machinery the GET route uses — so this fix does not need to touch `outcomes.ts` or add a refusal
variant; it is a literal two-site status/code swap in `routes.ts`. Did not verify whether
`ERROR_CODES` has a conversation-specific 404 code (legacy used
`CONVERSATION_NOT_FOUND`) vs. the generic `ERROR_CODES.NOT_FOUND` the sibling GET emits — that
choice (match legacy's specific code, or match the sibling route's generic one) is left for
implementation; the sibling route emitting the generic `NOT_FOUND` (per `outcomes.ts:52-54`
above) is the more direct in-repo precedent to mirror.

---

### R20 — Unique-violation (23505) cause-chain walk, conversations copy

`apps/api/src/slices/conversations/adapters/stores.ts:38-51`:

```ts
/** Postgres unique-violation (23505) on the named constraint, chain-walked. */
function isUniqueViolationOn(error: unknown, constraintName: string): boolean {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === '23505') {
      return (
        candidate.constraint === constraintName ||
        (candidate.constraint === undefined &&
          current instanceof Error &&
          current.message.includes(constraintName))
      );
    }
    current = candidate.cause;
  }
  return false;
}
```

Unbounded `while` walk of `.cause` chain (no depth cap — report notes the cap is
defensive-only since Drizzle wraps exactly once), with a message-substring fallback when
`candidate.constraint` is `undefined`. Sole caller context: `FORK_NAME_UNIQUE` constant at
`:36` (`'conversation_forks_conversation_name_unique'`). This is one of four independent
copies per R20 (`identity/adapters/stores.ts:46-56`, `chat/domain/user-message.ts:78-88`,
`admin/adapters/stores.ts:10-25` — not opened this session; consolidation is out of scope
here per the task).
