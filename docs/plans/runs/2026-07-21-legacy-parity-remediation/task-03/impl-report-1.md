# T03 impl-report-1 — R2: thread width/height/durationMs through history + public-share wire

**STATUS: DONE** — both blockers ruled by the orchestrator (scope + full-cluster deletion);
implemented TDD. Server serves the three media fields on both reads; web adapters stop
hardcoding null; the full dead public-share cluster is deleted.

## Objective

Re-serve media `width`/`height`/`durationMs` on the conversation-history AND public-share
read wire shapes (columns exist + populated) so non-square media renders at true aspect ratio
from history and share links; delete the dead public-share schema cluster.

## Legacy anchor (G1)

Quoted from `legacy/LEGACY-BEHAVIOR-REPORT.md` via research/legacy-conversations.md:10-24:
- History read (`:850-853`): content-item fields exposed include `... width, height, durationMs ...`.
- Public-share read (`:1225-1227`): "Each content item: `id`, `contentType`, `position`,
  `encryptedBlob` ..., `width`, `height`, `durationMs`, `downloadUrl`, `expiresAt`."
Legacy served all three as plain nullable integers on both reads. New code now reproduces this:
`z.number().int().nullable()` on `contentItemViewSchema` (shared by both reads).

## Files changed

Server (scope-expanded per orchestrator ruling):
- `apps/api/src/slices/conversations/ports/stores.ts` — added `width`/`height`/`durationMs`
  (`number | null`) to the `ContentItemRow` port so the mapper can read them.
- `apps/api/src/slices/conversations/adapters/stores.ts` — added the three columns to the
  single `contentItemsByMessage` SELECT projection (the one place feeding BOTH the history
  read and the public-share read).
- `apps/api/src/slices/conversations/domain/content-item-view.ts` — added the three
  nullable-int fields to `contentItemViewSchema` and populated them in `contentItemView()`
  from `row.width`/`row.height`/`row.durationMs`. (The history view `historyContentItemViewSchema`
  extends this base and its mapper spreads `contentItemView(row)`, so it inherits the fields
  with no edit to `history.ts`.)

Shared:
- `packages/shared/src/schemas/api/message-shares.ts` — deleted the entire dead public-share
  cluster (`publicShareContentItemSchema`, `publicShareResponseSchema`, and the
  `PublicShareContentType`/`PublicShareContentItem`/`PublicShareResponse` type exports).

Web:
- `apps/web/src/hooks/chat/chat.ts` — `HistoryContentItem` interface gains the three fields;
  `toContentItemResponse` maps them from the item instead of hardcoding null; adjusted the
  now-inaccurate docstring (dimensions ARE served; only `storageKey` is absent).
- `apps/web/src/hooks/chat/use-shared-message.ts` — `SharedItemView` interface gains the three
  fields; the media branch of `buildSharedContentItem` maps them instead of hardcoding null.

Not changed (in Files list but surgically unnecessary):
- `apps/web/src/lib/api.ts` — `ContentItemResponse`/`MessageMediaItem`/`SharedContentItem`
  already declare width/height/durationMs; no change needed.
- `apps/web/src/components/chat/media/media-preview.tsx` — `mediaRatio` already reads
  width/height (aspect tier 2); it was dead only because the adapters fed null. It goes live
  automatically now that the adapters pass real values. No code change.
- `apps/api/.../domain/history.ts` — inherits fields via the base view; no edit.

## Tests added (TDD, RED verified before GREEN)

- `conversations/domain/history.test.ts`:
  - "surfaces persisted pixel dimensions and duration for a media content item" — history read
    (base view) serializes width/height/durationMs (covers criterion a, history).
  - "serializes null dimensions and duration for a non-media content item" — null passthrough.
  - Updated the `contentItemRow` fixture to include the three fields (port now requires them).
- `conversations/domain/shares.test.ts`:
  - "surfaces persisted pixel dimensions and duration on a media content item" — public-share
    read (`readSharedMessage`) serializes the three fields (covers criterion a, share). Added a
    `contentItemRow` fixture + imported `ContentItemRow`.
- `apps/web/src/hooks/chat/chat.test.tsx`:
  - "maps persisted pixel dimensions and duration for a media content item" — history adapter
    passes real values through (covers criterion b, history). Updated the existing full-`toEqual`
    text fixture to carry the now-served keys.
- `apps/web/src/hooks/chat/use-shared-message.test.ts`:
  - Extended the media-presign test to assert width/height/durationMs flow through the share
    adapter (covers criterion b, share). Added width/height/durationMs to the `ShareItem` fixture type.

RED confirmed: server tests failed with `expected undefined to be 800/1920/...`; web tests
failed with `expected null to be 1920` and object-shape mismatch — all for the right reason
(fields not yet threaded). GREEN after the schema/mapper/adapter changes.

## Self-gate

- `pnpm exec vitest run` history.test.ts + shares.test.ts (api) — pass (66/66).
- `pnpm exec vitest run` message-shares.test.ts (shared) — pass (2/2).
- `pnpm exec vitest run` chat.test.tsx + use-shared-message.test.ts + media-preview.test.tsx
  (web) — pass (76/76).
- Typecheck: `@hushbox/shared` clean; `@hushbox/api` clean; `@hushbox/web` — one error only:
  `apps/api/src/middleware/pipeline-bindings.ts(59,29): Cannot find name 'ExecutionContext'`.
  Pre-existing and unrelated (a Cloudflare Workers ambient type in a file I never touched;
  nothing to do with content items) — attributed out per brief.
- ESLint owned files (exit 0, run from each package dir after the last edit):
  api EXIT 0, shared EXIT 0, web EXIT 0.

## Acceptance criteria

1. `contentItemViewSchema` + history view include the three fields, populated from the DB
   columns — **MET** (schema + mapper + port + projection; history inherits via base).
2. Web adapters stop hardcoding nulls; media-preview aspect tier live — **MET** (`chat.ts` +
   `use-shared-message.ts` map real values; `mediaRatio` tier 2 now reachable).
3. Dead `publicShareContentItemSchema` removed — **MET** (full cluster `:69-101` deleted per
   ruling; grep confirms zero refs to all five symbols repo-wide, excluding node_modules + /legacy/).
4. Tests: server serializes the fields (both reads); non-square item yields correct aspect
   data through the adapter — **MET** (RED→GREEN on all four test files).

## Deviations / notes

- Did NOT edit `api.ts` or `media-preview.tsx` (in Files list) — their types/logic already
  supported the fields; touching them would be non-surgical (G7).
- Deleted the whole dead cluster (`:69-101`), not just `:69-88`, per the orchestrator's
  BLOCKER-2 ruling — deleting only the content-item schema would have left
  `publicShareResponseSchema` referencing an undefined symbol.
- `routes.integration.test.ts` (real-DB history route) would give end-to-end DB evidence that
  the projection selects the columns, but it is out of my granted scope. Coverage here is:
  additive+typechecked SELECT change + unit serialization tests on both reads. Phase-4
  integration/E2E confirms the full DB path (share/media render E2E is already listed in the
  plan's Related-E2E for T03).

## Concerns / limitations

- The demo mock-backend `apps/web/src/demo/mock-backend/store.ts` builds its own history/share
  wire objects (out of scope) and does not populate the new fields; its media will render
  square in the demo. No runtime break (the typed client does not Zod-validate responses;
  `mediaRatio` handles `undefined`). Flagging as a follow-up if demo-fidelity for persisted
  media dimensions is wanted — not part of this parity finding.

## Confidence

high — every criterion has a RED→GREEN test; the only non-green check is the pre-existing,
unrelated `pipeline-bindings.ts` error the brief instructed me to attribute out.
