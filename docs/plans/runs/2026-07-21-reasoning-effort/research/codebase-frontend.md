# Frontend research: reasoning-effort feature (per-turn effort selector + live thinking display)

Read-only research. Facts only, exact `path:line` citations. Repo root:
`/workspace/popper-mobile/.superset/projects/HushBox`.

## 1. Chat screen layout

- Main chat screen: `apps/web/src/components/chat/layout/chat-layout.tsx`. Root
  container `flex min-h-0 flex-1 flex-col overflow-hidden` (line 331-336, dynamic
  `style={{height: viewportHeight}}` from `useVisualViewportHeight()`, imported from
  `@hushbox/ui`).
  - Header: `<div data-chat-header>` (line 337) renders `<ChatHeader>`.
  - Body row: `<div className="flex flex-1 overflow-hidden">` (line 363-364) contains
    `<ChatMainContent>` (message list), a lazy `<DocumentPanel>` (line 52-54, 388), and
    `<MemberSidebar>` (line 391-398, group chats only, via `buildMemberSidebarProps`).
  - Composer bar: `<div ref={inputContainerRef} data-chat-input data-chrome="" className="bg-background flex-shrink-0 border-t p-4" style={inputStyle}>` (line 401-406), wrapping an inner **`<div className="mx-auto w-full max-w-3xl">`** (line 408) that holds queued-message pills and `<ChatPromptInput>`. **This is the only confirmed "free space" location**: on any viewport wider than `max-w-3xl` (48rem/768px... actually `max-w-3xl` = 48rem = 768px, so viewports wider than that), the full-width `data-chat-input` bar has empty space on both sides of the centered composer column — a vertical rail could dock into that space, inside the same flex-shrink-0 bar, without new layout scaffolding. No such rail exists today.
  - `chat-main-content.tsx` (full file read) is a plain `flex min-w-0 flex-1 flex-col`
    wrapping `<MessageList>` — no reserved right-edge gutter there; message rows are
    full-width within it (`message-item.tsx` assistant rows: `w-full px-4`, per §2).
- Composer: `apps/web/src/components/chat/input/chat-prompt-input.tsx` (thin prop-mapping
  wrapper) → `apps/web/src/components/chat/input/prompt-input.tsx` (~860 lines, the actual
  composer). Structure: outer `border-border-strong bg-background dark:border-input flex
  flex-col rounded-md border`, `AnimatedHeight` (edit-mode banner), `Textarea`,
  `MorphHeight`-wrapped `BottomRows`. `BottomRows` dispatches per active modality:
  `TextBottomRow` (CapacityBar + `PromptToolbar` + send button), `ImageBottomRow` /
  `VideoBottomRow` / `AudioBottomRow` (media config controls). `PROMPT_INPUT_DEFAULTS`
  holds prop defaults.
- Model selector: `apps/web/src/components/chat/model-selector/model-selector-button.tsx`
  opens `<ModelSelectorModal>` (`.../model-selector-modal.tsx`, not fully read this pass);
  rendered centered in the header (`chat-header.tsx`, see below).
- Per-turn options chosen today (all live in the composer toolbar,
  `PromptToolbar` inside `prompt-input.tsx`): web-search toggle (via `useWebSearch()`),
  the modality picker (text/image/video/audio icons), and (group chats) an AI on/off
  toggle. Media modalities get inline config controls (`ImageAspectRatioControl`,
  `VideoAspectRatioControl`, `VideoResolutionControl`, `VideoDurationControl`,
  `AudioFormatControl`, `AudioDurationControl`, `MediaCostLine`) or, on mobile, a
  `MobileGenerationRow` → `GenerationSummaryChip` + bottom-sheet `GenerationConfigSheet`
  pattern instead of inline controls. **No effort/reasoning-level option exists
  anywhere in the composer today.**
- Reusable toggle pattern: `ToggleButtonWithTooltip` in `prompt-input.tsx` — an
  accessibility-aware toggle (renders a `role="button"` span wrapper when disabled so the
  tooltip stays focusable/announced). This is the established precedent for adding a new
  toggle-style control (e.g., an effort selector trigger).
- `chat-header.tsx` (full file read): `<PageHeader center={<ModelSelectorButton/>}
  right={<div className="flex items-center gap-2"><EncryptionBadge/><ThemeToggle/>
  {MemberFacepile}</div>}>`. The header's right slot has room for one more icon-sized
  control but is not a vertical rail.
- Mobile / Capacitor layout differences: `chat-layout.tsx` uses `useIsMobile()`
  (`packages/ui/src/hooks/use-is-mobile.ts:8-28`, matches `MOBILE_BREAKPOINT` from
  `@hushbox/shared`, currently 768px per `MOBILE_BREAKPOINT - 1`), `useKeyboardOffset()`
  (`apps/web/src/hooks/ui/use-keyboard-offset.ts:23-94` — Visual Viewport API based,
  `isKeyboardVisible` flips at a 150px height-delta threshold, exposes
  `{bottom, isKeyboardVisible, viewportHeight}`), and a `getMobileInputStyle()` helper
  (in `chat-layout-helpers.ts`, not fully read, referenced from `chat-layout.tsx`) that
  computes the composer's position under `keyboardOffset`/`isKeyboardVisible`.
- Safe-area/notch handling: exactly one hit repo-wide —
  `apps/web/src/components/chat/layout/chat-layout-helpers.ts:19`:
  `paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))'`. No
  `safe-area-inset-{top,left,right}` usage was found anywhere in `apps/web/src`, so a
  right-edge vertical rail has no existing precedent for right-side notch/inset handling
  to follow — it would be new.

## 2. Streaming message rendering

- Token delivery path (wire → React): `packages/shared/src/inference.ts` (lines 120-180
  read) defines `InferenceEvent` as a Zod discriminated union on `kind`, including
  side-by-side siblings:
  ```ts
  z.object({ kind: z.literal('text-delta'), index: z.number(), content: z.string() }),
  z.object({ kind: z.literal('reasoning-delta'), index: z.number(), content: z.string() }),
  ```
  plus `stream-start` (carries `outputModality`), `tool-call`/`tool-result`,
  `step-start`/`step-finish` (per-step `generationId` + `providerCostUsd`),
  `media-start`/`media-done`/`media-progress` (server-paced synthetic progress, video
  only).
- `apps/web/src/lib/chat-run.ts` (~405 lines, full read) is where wire frames are
  dispatched to callbacks. `ChatRunCallbacks` interface (line 32) already declares
  `onReasoningToken?: ((token: string, assistantMessageId: string) => void) | undefined;`
  (line 39). `dispatchDelta()` (~line 198):
  ```ts
  if (event.kind === 'text-delta') {
    callbacks.onToken?.(event.content, tile.assistantMessageId);
    return true;
  }
  if (event.kind === 'reasoning-delta') {
    callbacks.onReasoningToken?.(event.content, tile.assistantMessageId);
    return true;
  }
  ```
  `dispatchBoundEvent()`'s default case is a documented no-op for
  `tool-call`/`tool-result`/`step-start`/`step-finish` ("surfaced only through telemetry
  today; they must never crash rendering") — so those four kinds are silently ignored by
  design, not a gap. `processFrame()` also handles `run-started`, `stream-gone` (buffer
  overflow / run-over, explicit no-op relying on post-run refetch), `run-finished`.
- `apps/web/src/hooks/chat/use-chat-stream.ts` (~650 lines, full read): `StreamOptions`
  interface (~line 151) already declares `onReasoningToken?: (token, assistantMessageId)
  => void` alongside `onToken`, `onModelResolved`, `onRestart`, `onModelDone`, etc.
  `wireCallbacks()` (~line 342) threads `onReasoningToken: options?.onReasoningToken`
  straight through into `ChatRunCallbacks`.
- **Gap: `apps/web/src/hooks/chat/use-authenticated-chat.ts` (~1500 lines, full read)
  never supplies `onReasoningToken` in any `StreamOptions`/`ChatRunCallbacks` object it
  builds** (`createOptimisticStreamCallbacks`, nor the hand-written new-chat-flow
  callbacks in the `isCreateMode` effect). So today a `reasoning-delta` frame is received
  by `executeChatRun`, dispatched to `callbacks.onReasoningToken?.()`, which is
  `undefined` — **silently dropped**. The wire schema → dispatch plumbing is complete;
  the state/UI wiring to consume it is entirely absent.
- Message component tree: `apps/web/src/components/chat/message/message-item.tsx`
  (~820 lines, full read). `AIMessageContent()` (~line 510): error text if
  `primaryMessage.errorCode`; `<StreamingPlaceholder>` if `isStreaming &&
  primaryMessage.content === ''`; otherwise a lazy `<MarkdownRenderer content={...}
  isStreaming={isStreaming}/>` in `<React.Suspense fallback={<MarkdownTextFallback/>}>`.
  **Exactly one text blob (`content`) is rendered per assistant message; no separate
  reasoning/thinking region exists in this component.**
  `StreamingPlaceholder`/`ThinkingPlaceholder` (~lines 458-508): media-in-flight backdrop
  wins unless `classifyingStageId` is set (pre-inference stage wins over media); otherwise
  renders `<ThinkingIndicator>`.
- `message-body.tsx` (full read, small file): shared bubble frame
  (`BUBBLE_VARIANT_CLASS`: assistant/user-own/user-other) + `<MessageMediaList>`.
  `data-reading=""` flips the subtree to the editorial serif per `data-chrome`-style
  convention. Shared between `MessageItem` and the public share view.
- `apps/web/src/lib/api.ts` (lines 1-110 read): the `Message` interface (line 54) is the
  frontend's canonical display-message shape — `id`, `conversationId`,
  `role: 'user'|'assistant'`, `content: string`, `createdAt`, `cost?: string`,
  `senderId?`, `modelName?: string|null`, `parentMessageId?`, `batchId?`, `errorCode?`,
  `isSmartModel?: boolean`, `classifyingStageId?: 'smart-model'|undefined`,
  `resolvedModelName?: string`, `wrappedContentKey?: string`, `epochNumber?: number`,
  `mediaItems?: MessageMediaItem[]`. **No `reasoning`/`thinking` field anywhere on this
  type.**
- `apps/web/src/lib/chat-messages.ts` (lines 1-90 read): `createUserMessage`,
  `createAssistantMessage`, `createTrialMessage` are minimal object builders.
  `appendTokenToMessage<T extends {id:string; content:string}>()` (line 62) operates
  **only** on `content` — no reasoning-token equivalent exists; a reasoning accumulator
  would need a parallel field and a parallel append helper (or a generalized one).
- Markdown rendering: `apps/web/src/components/chat/message/markdown-renderer.tsx` (full
  read). Wraps `streamdown`'s `<Streamdown>` with `plugins={{ code: safeCode, mermaid,
  math }}`, `controls={{ code: true, mermaid: {...} }}`, `isAnimating={isStreaming ??
  false}`, `animated`. Custom `pre` component override intercepts large/mermaid code
  blocks into `<DocumentCard>` (via `document-parser.ts` helpers); otherwise defers to
  default `MarkdownCode` handling. Wrapped in `<ErrorBoundary
  fallback={<MarkdownRenderFallback content={content}/>} resetKey={content}>`.
  `MarkdownRenderFallback` renders raw pre-wrap text plus "Message formatting
  unavailable." No reasoning-specific rendering path.
- React Virtuoso constraints: `apps/web/src/components/chat/message/message-list.tsx`
  (~560 lines, full read).
  - `MessageRow` interface deliberately bakes `isStreaming`/`isError` into the data array
    itself, documented as a WebKit-closure-staleness workaround — a fresh array reference
    is required to force re-render under Safari virtualization.
  - `initialItemCount={1}` — documented as load-bearing/fragile: Virtuoso's initial-paint
    seed renders forward from the `LAST` anchor at `initialItemCount - 1` offset; any
    value >1 would read out of bounds and crash `computeItemKey`.
  - `increaseViewportBy={{top: 800, bottom: 800}}` — 800px overscan, explicitly for
    accessibility (screen readers, find-in-page) *and* to avoid unmounting a growing tile
    before it's fully rendered — directly documents the exact class of risk a
    dynamically-growing reasoning-token block during rapid streaming would hit if not
    handled carefully.
  - `followOutput` returns `!userScrolledAwayRef.current` — auto-scroll-to-bottom,
    decoupled from raw scroll position via a `USER_SCROLL_DECAY_MS = 250` sticky-with-decay
    heuristic (wheel/touchmove/keydown listeners).
  - A late-growth re-pin `useEffect` (~line 228) explicitly handles post-stream content
    growth (example cited in comments: "cost true-up badge inflating the final reply")
    that can leave the viewport short of bottom — re-scrolls only when not streaming, not
    user-scrolled-away, and not already at bottom. Any reasoning-block collapse/expand
    that changes row height post-stream should be expected to interact with this same
    effect.
  - `components = { Header, Footer, Scroller }`; Footer height `10dvh` is the
    scroll-to-bottom threshold anchor.
  - E2E-facing DOM attributes: `data-message-count`, `data-decrypted-count`,
    `data-streaming-count`, `data-streams-completed`, `data-pre-inference-stages-seen`,
    `data-at-bottom`, `data-messages-ready`.

## 3. Existing thinking-indicator component

`apps/web/src/components/chat/indicators/thinking-indicator.tsx` (full file, verbatim):
```tsx
interface ThinkingIndicatorProps {
  modelName: string;
  stageLabel?: string;
}
export function ThinkingIndicator({
  modelName,
  stageLabel,
}: Readonly<ThinkingIndicatorProps>): React.JSX.Element {
  const displayName = shortenModelName(modelName) || 'AI';
  const label = stageLabel ?? `${displayName} is thinking`;
  return (
    <div role="status" aria-label={label} data-testid={TEST_IDS.thinkingIndicator}
         className="text-muted-foreground flex items-center gap-1 text-sm">
      <span>{label}</span>
      <DotPulseIndicator />
    </div>
  );
}
```
It is a purely pre-token status pulse — shown only while `primaryMessage.content === ''`
(from `message-item.tsx`'s `StreamingPlaceholder`, see §2). It has no live reasoning-token
display, no expand/collapse state, no timer. `stageLabel` is used to override the label
during pre-inference stages (e.g., Smart Model classification via `classifyingStageId`).

`DotPulseIndicator` (`apps/web/src/components/chat/indicators/dot-pulse-indicator.tsx`,
full file): three `aria-hidden="true"` spans with staggered `animationDelay` (`0s,
0.16s, 0.32s`) and a Tailwind `animate-dot-pulse` class (CSS-only animation, not
Framer/rAF-driven).

## 4. Collapsible/disclosure patterns, glass/blur styling, docs/DESIGN.md

- Only collapsible primitive in `packages/ui`:
  `packages/ui/src/components/marketing/accordion.tsx` (full file). `Accordion({trigger,
  defaultOpen, className, children})`: local `React.useState` for `open`; trigger button
  has `aria-expanded={open}` and a rotating `▾` glyph (`rotate-180` on open); content div
  uses `max-h-[2000px] pb-4 opacity-100` (open) vs `max-h-0 opacity-0` (closed) plus an
  inline `style={{visibility: open ? 'visible' : 'hidden'}}` — a CSS-transition
  height-collapse pattern (`transition-all duration-200`), not Framer Motion. Lives under
  `marketing/`, named/positioned as marketing-page content, but is a generic, reusable
  disclosure primitive with no marketing-specific logic — directly reusable for an effort
  panel's expand/collapse if relocated or imported as-is.
- `backdrop-blur` usages (repo-wide grep, `apps/web/src` + `packages/ui/src`):
  - `apps/web/src/components/shared/offline-overlay.tsx:31` —
    `bg-background/95 z-overlay fixed inset-0 flex flex-col items-center justify-center backdrop-blur-sm`
  - `apps/web/src/components/shared/page-header.tsx:63` —
    `bg-background/95 supports-backdrop-blur:bg-background/60 sticky top-0 z-10 min-h-[var(--app-header-height)] shrink-0 overflow-hidden border-b px-4 py-2 backdrop-blur`
  - `packages/ui/src/components/overlay-bottom-sheet.tsx:85` —
    `z-modal fixed inset-0 bg-black/50 backdrop-blur-sm`
  - `packages/ui/src/components/overlay-dialog.tsx:52` —
    `z-modal fixed inset-0 bg-black/50 backdrop-blur-sm`
  - (Corresponding assertions in `page-header.test.tsx:29`, `overlay.test.tsx:68`,
    `overlay-bottom-sheet.test.tsx:223`.)
  - All existing blur usage is on full-screen or full-bleed overlay scrims (`inset-0`),
    never on an in-flow panel. A "glazed-glass panel" for an effort rail would be a new
    pattern (no in-flow translucent-panel precedent exists in the codebase today).
- z-index / overlay conventions (from the grep above): named Tailwind z-tokens
  `z-overlay` (offline overlay) and `z-modal` (dialogs/bottom sheets); `page-header.tsx`
  uses a raw `z-10` for its sticky header. These are the only overlay z-index tokens
  observed in this pass.
- `docs/DESIGN.md` (full file read) — identity rules relevant to a glazed-glass rail:
  - **The Flat-by-Default Rule** (§4 Elevation): "Surfaces are flat at rest. A shadow
    appears only as a response to state (hover, active elevation, focus), and it is soft
    and warm, never decorative." Depth comes from warm surface layering + hairline
    borders, not heavy shadow.
  - **The Warm-Surface Rule** (§2): no pure-white/pure-black canvas; surfaces are warm
    paper (light) / warm charcoal (dark). A glass panel would need a warm-tinted blur
    background (e.g. `bg-background/95` matching existing overlay usage), never a neutral
    gray or black-tinted glass.
  - **The One Red Rule** (§2): brand red (`#ec4755`) is reserved as a small-fraction
    signal only (action/selection/focus/heading) — an effort-level "active" state should
    use it sparingly, not as a fill.
  - **Cards / Containers** (§5): "Paper-cream background, large radius (8px), hairline
    border, generous internal padding. Flat at rest. Never nested." A rail/panel should
    follow this radius/border/padding convention, not introduce a new one.
  - **The Reading-versus-Chrome Rule** (§3): reading surfaces use the serif
    (Merriweather); product UI chrome (including any effort-selector labels/controls)
    uses the sans (Hanken Grotesk).
  - Do's/Don'ts (§6): "gate every animation through the motion-aware helper so it
    degrades to a no-op"; don't ship "the generic AI-chat look" (gray bubbles, sparkle
    empty states, purple gradients); don't use em/en-dash in user-facing copy.
  - No explicit mention of a "vertical rail" pattern or glass panels by name anywhere in
    `docs/DESIGN.md` — a reasoning-effort rail would be new UI vocabulary, constrained by
    but not prescribed in this doc.

## 5. Animation conventions

- `useAnimationFrame` wrapper: `packages/ui/src/hooks/use-animation-frame.ts` (full file).
  Signature: `useAnimationFrame(callback: (timestamp: number) => void, options?:
  {respectMotion?: boolean; paused?: boolean})`. When `respectMotion` (default `true`),
  the internal rAF loop pauses whenever the merged reduced-motion signal
  (`shouldReduceMotion()` / `subscribeReducedMotion()` from `./use-reduced-motion`, not
  read this pass) is on, and resumes when it turns off — single source of truth shared
  with `useReducedMotion()` and the `html.reduced-motion` class. This is the mandatory
  wrapper for any JS-driven animation (raw `requestAnimationFrame` is ESLint-banned per
  `docs/CODE-RULES.md`).
- `DotPulseIndicator` (§3) uses a pure CSS keyframe animation
  (`animate-dot-pulse` Tailwind utility + staggered `animationDelay` inline styles — note:
  `animationDelay` is not one of the ESLint-banned inline style properties
  `color/backgroundColor/borderColor/fontFamily/fontSize/fill/stroke`, so this is
  compliant), not `useAnimationFrame` or Framer Motion — CSS animation is an accepted
  alternative for existing "typing"-style indicators.
- `MarkdownRenderer` passes `isAnimating={isStreaming ?? false}` and `animated` to
  Streamdown (`markdown-renderer.tsx:164-165`) — Streamdown owns its own internal
  streaming-text animation; no custom token-reveal animation exists in this codebase for
  regular assistant text.
- Accessibility-widget interaction with backdrop-blur/animation: not directly located
  this pass beyond DESIGN.md's "gate every animation through the motion-aware helper" and
  "make every surface survive the accessibility widget: contrast, inversion, scaling,
  loosened spacing, and stopped motion" (§6 Do's). No specific CSS override rule for
  `backdrop-blur` and the accessibility widget was found in the files read this pass —
  **gap, not swept**: the accessibility-widget implementation file itself (its
  stopped-motion / contrast CSS override mechanism) was not located/read in this session.

## 6. Model capabilities reaching the UI

- Models query hook: `apps/web/src/hooks/models/models.ts` (full file). `useModels()` →
  `useQuery(modelsQueryOptions())`, `ModelsData = {models: Model[]; premiumIds:
  Set<string>}`, 1-hour `staleTime`. `modelKeys = {all, list, detail}`.
  `getAccessibleModelIds()` (lines 55-94) computes "Strongest"/"Value" quick-select pins
  for **text modality only**, from `popularityRank` (top half) and combined BASE nano
  pricing (`pricing.inputPerToken + pricing.outputPerToken`); media modalities get no
  pins.
- Wire `Model` type: `packages/shared/src/schemas/api/models.ts` (full file,
  `modelSchema`, line 164-251). Fields: `id`, `name`, `provider`, `modality` (`text |
  image | audio | video`), `contextLength`, `pricing` (`WireModelPricing`:
  `inputPerToken?`, `outputPerToken?`, `perImage?`, `perSecondByResolution?`, all
  optional nano-USD decimal strings), `capabilities: ModelCapability[]` (the only
  member of `modelCapabilitySchema` is `'internet-search'`, explicitly noted as unused —
  "No code currently produces 'internet-search'; search runs via a Perplexity tool
  universally, not as a per-model capability" — kept only as a placeholder enum member),
  `description`, `supportedParameters: string[]` (default `[]`, doc comment: "AI Gateway
  API parameters supported by this model... Example: ['tools', 'temperature', 'top_p',
  'max_tokens']"), `created?`, `isSmartModel?`, `minPricing?`/`maxPricing?` (Smart Model
  pool price-range), `supportedAspectRatios?`, `supportedVideoResolutions?`,
  `supportedVideoDurationsSeconds?`, `popularityRank?`. **No effort/reasoning field of any
  kind exists on this schema.**
- `ModelFeatureId` (a distinct, narrower concept from `ModelCapability` above):
  `packages/shared/src/capabilities/types.ts` (full file). `export type ModelFeatureId =
  'python-execution' | 'javascript-execution' | 'vision'` (line 9), each with a
  `requiredParameters: string[]` gate checked against the model's `supportedParameters`.
  `packages/shared/src/capabilities/model-capabilities.ts` exports `getModelFeatures(model:
  Model): ModelFeatureId[]` and `modelHasFeature(...)`, deriving high-level UI-facing
  capability flags from `supportedParameters` membership. **This is the exact precedent
  mechanism an "effort supported" flag would follow**: OpenRouter/AI-Gateway
  `supportedParameters` commonly includes a `'reasoning'` or `'include_reasoning'` entry
  for reasoning-capable models — a new `ModelFeatureId` member (e.g. `'reasoning-effort'`)
  gated on that parameter name would be the idiomatic, zero-schema-migration way to
  surface "this model supports an effort selector" to the UI, consistent with
  `TECH-STACK.md`'s auto-discovery-from-OpenRouter-metadata model. No such member exists
  today.
- Composer feature gating by model: `use-prompt-budget.ts` (§8) takes
  `capabilities: ModelFeatureId[]` as an input and threads it into
  `buildSystemPrompt(input.capabilities, customInstructions)` — confirming
  `ModelFeatureId[]` is the live wire used to conditionally shape prompt/composer
  behavior per selected model today. The call site that computes this array (likely
  `use-selected-model-capabilities.ts`, filename found earlier but not read this pass) was
  not directly inspected — **gap**.

## 7. Zustand state

- Model/turn-option store: `apps/web/src/stores/model.ts` (full file). `useModelStore`
  (Zustand `create` + `persist`, key `hushbox-model-storage`, `version: 1`). State:
  `activeModality`, `selections: Record<ChatModality, SelectedModelEntry[]>`,
  `pickerMode: Record<ChatModality, PickerMode>`, `imageConfig: ImageConfig`,
  `videoConfig: VideoConfig`, `audioConfig: AudioConfig`. Actions: `setActiveModality`,
  `setSelectedModels`, `toggleModel`, `removeModel`, `clearSelection`, `setPickerMode`,
  `resetForUnauthenticated`, `setImageConfig`/`setVideoConfig`/`setAudioConfig`.
  `partialize` persists only `activeModality`, `selections`, `pickerMode` — the
  per-modality config objects (`imageConfig` etc.) are explicitly **not** persisted
  (reset to in-memory defaults every load; a `migrate()` function actively strips any
  legacy persisted config keys, line 309-322, "Carrying those across a model switch could
  leave the stored value invalid for the newly selected model"). **This is the closest
  existing precedent and the most natural home for a selected-effort value**: a sibling
  `effortConfig` (or a `reasoningEffort` field alongside `imageConfig`/`videoConfig`)
  would follow the same non-persisted, `set*Config`-action pattern — though the
  "config objects aren't persisted" precedent argues against persisting a chosen effort
  level across sessions unless a product decision says otherwise.
- Other chat-UI Zustand stores present (`apps/web/src/stores/`, not all fully read this
  pass): `ui.ts` (full file — `useUIStore`: `sidebarOpen`, `mobileSidebarOpen`, persisted
  key `hushbox-ui-storage`, only `sidebarOpen` partialized), `ui-modals.ts`,
  `streaming-activity.ts`, `pre-inference-activity.ts`, `stream-cycle-activity.ts`,
  `websocket-inbound-activity.ts`, `chat-edit.ts`, `chat-error.ts`, `search.ts`,
  `message-queue.ts`, `trial-chat.ts`, `pending-chat.ts`, `fork.ts`, `document.ts`,
  `network.ts`, `touch-override.ts`, `app-version.ts`, `create-counter-store.ts` (a
  factory helper, not a store itself). None of these were confirmed (this pass) to hold
  per-modality generation config the way `model.ts` does — `model.ts` is the correct
  slice for an effort selection given its existing `imageConfig`/`videoConfig`/
  `audioConfig` sibling pattern.
- Per-conversation UI-state persistence: no per-conversation-scoped Zustand persistence
  was found — `model.ts`'s `persist` is global (one `hushbox-model-storage` key for the
  whole app, not keyed by conversation id), and its own per-modality configs are
  explicitly *not* persisted at all (see above). No evidence of any existing
  per-conversation UI preference storage mechanism (localStorage-keyed-by-conversation-id
  or a `conversation_ui_state` table) was found in this pass — **gap: not exhaustively
  searched for a per-conversation persistence mechanism outside the stores listed above**.

## 8. Client-side cost display / estimator usage

- Canonical shared estimator: `packages/shared/src/estimate/` — barrel
  `packages/shared/src/estimate/index.ts` re-exports `types`, `storage-rate`,
  `pre-adapters`, `media-pricing`, `search-reservation`, `classifier-line-item`,
  `price-request`, `reducers`, `format`. (Per user memory: this is the 2026-07-20
  "canonical cost estimator" SDD deliverable — one nano-USD estimator core shared by
  client display/affordability, server admission holds, and settlement.)
- Client import/usage site: `apps/web/src/hooks/billing/use-prompt-budget.ts` (full file,
  394 lines). Imports from `@hushbox/shared`: `buildSystemPrompt`, `generateNotifications`,
  `nanoUsdToCents`, `Model`, `ModelFeatureId`, `BudgetError`, `FundingSource`,
  `MemberPrivilege`. Delegates the actual math to
  `apps/web/src/hooks/billing/use-budget-calculation.ts` (`useBudgetCalculation`, imported
  but not read this pass) and `apps/web/src/hooks/billing/use-media-cost-estimate.ts`
  (`useMediaCostEstimate`, same). `usePromptBudget(input: PromptBudgetInput):
  PromptBudgetResult` returns `{fundingSource, notifications, capacityPercent,
  capacityCurrentUsage, capacityMaxCapacity, estimatedCostCents, isOverCapacity,
  hasBlockingError, hasContent}`. Pulls per-model BASE nano rates straight off the live
  `Model` catalog (`buildModelTokenPricing`, `buildMediaRateArrays`) — never hardcodes
  pricing. `estimatedCostCents` is exposed to the composer as the live running estimate
  (this hook is invoked from `prompt-input.tsx`, confirmed by an earlier grep hit, though
  the exact call site line wasn't captured this pass — gap).
- Settled/persisted cost display: `apps/web/src/components/chat/message/message-cost.tsx`
  (full file). `<MessageCost cost: string>` — safe-parses a `NanoUSD` wire string via
  `NanoUSD.safeParse(cost).success` (renders nothing if invalid, rather than throwing
  inside the virtualized list), then `formatNanoUsdCost(cost)` for display. Rendered
  inline in the message actions row: `message-item.tsx`'s `MessageActions` (per prior-turn
  finding) shows `primaryMessage.cost` via `<MessageCost>` when present. This is the
  **final, settled** cost display; `usePromptBudget`'s `estimatedCostCents` is the
  **pre-send estimate** shown in the composer (`CapacityBar`/`MediaCostLine` per §1) — two
  distinct display sites for two distinct numbers (estimate vs. settled actual), both
  ultimately sourced from `packages/shared/src/estimate/`.
- A reasoning-effort selector that changes provider cost (higher effort → more reasoning
  tokens → higher cost) would need to feed into `usePromptBudget`'s estimate path — no
  existing hook parameter for this exists; `PromptBudgetInput` today has no effort field.

## 9. Accessibility conventions constraining a one-touch vertical rail

- From `docs/CODE-RULES.md` (Accessibility-friendly Conventions section, loaded via
  `CLAUDE.md`):
  - No inline `color`/`backgroundColor`/`borderColor`/`fontFamily`/`fontSize`/`fill`/
    `stroke` styles — ESLint-banned; use Tailwind classes/CSS variables so the
    accessibility widget's contrast/font-scaling overrides remain effective. (Verified
    compatible pattern in use: `dot-pulse-indicator.tsx`'s inline `animationDelay` is
    *not* one of the banned properties.)
  - `useAnimationFrame` (not raw `requestAnimationFrame`) for any JS-driven animation —
    ESLint-banned otherwise, respects `prefers-reduced-motion` (§5 above).
  - Prefer semantic HTML over ARIA roles (`<button>` not `<div role="button">`, except
    the documented `ToggleButtonWithTooltip` disabled-state exception in
    `prompt-input.tsx` which wraps a disabled control in a `role="button"` span
    specifically to keep the tooltip focusable/announced).
  - Chrome wrappers (sidebar/header/footer/panels surrounding main content) get
    `data-chrome=""` for future focus-mode opt-out behaviors — a vertical rail, being
    chrome around the composer rather than message content, should carry this attribute
    (existing precedent: `chat-layout.tsx`'s composer bar itself is tagged
    `data-chat-input data-chrome=""` at line 403-404).
  - Test ids: only via the `TEST_IDS`/`TEST_ID_BUILDERS` registry in `@hushbox/shared`
    (confirmed pervasively: `TEST_IDS.thinkingIndicator`, `TEST_IDS.messageCost`,
    `TEST_IDS.markdownRenderer`, etc.) — literal `data-testid` strings are lint-banned
    (`apps/web/CLAUDE.md`).
  - `<Img>`/`<Logo>` wrappers required over raw `<img>` (not directly relevant unless the
    rail uses iconography beyond `lucide-react` SVG icons, which are exempt).
- `ThinkingIndicator` itself models the expected a11y shape for a status-type control:
  `role="status" aria-label={label}` (§3) — a live-region pattern any reasoning-token
  display should likely extend or parallel, given `aria-label` content changes need
  `role="status"`/`aria-live` semantics to be announced without stealing focus.
- Touch target sizing: no explicit minimum-touch-target-size token or lint rule was found
  in the files read this pass (`docs/DESIGN.md`'s `rounded`/`spacing` tokens define radii
  and spacing scale — `spacing.sm = 8px`, `spacing.md = 16px` — but no explicit `44px`/
  `48px` touch-target rule was located). `ToggleButtonWithTooltip` in `prompt-input.tsx`
  is the closest existing icon-toggle-button implementation to model touch-target sizing
  from, but its exact className/dimensions were not captured in this pass — **gap: no
  direct touch-target-size citation found; would need to inspect
  `ToggleButtonWithTooltip`'s className and any existing icon-button size tokens in
  `packages/ui` (e.g. `Button` variant `size="icon"`) directly.**
- Keyboard access: no rail-specific keyboard pattern exists (nothing to model, since no
  rail exists). The `Accordion` primitive (§4) is keyboard-operable via a native
  `<button type="button">` trigger with `aria-expanded`; a vertical-rail control should
  follow the same native-button baseline per the "prefer semantic HTML" rule.

## Gaps (not swept, or only partially swept, in this pass)

- `apps/web/src/components/chat/model-selector/model-selector-modal.tsx` and
  `use-filtered-models.ts` — found but not read; would show full model-selector UI
  detail and any existing per-model badge/icon patterns a "reasoning-capable" badge could
  reuse.
- `apps/web/src/hooks/models/use-selected-model-capabilities.ts` and
  `use-resolve-default-model.ts` — found but not read; the exact call site that computes
  the `ModelFeatureId[]` array passed into `usePromptBudget` (§6/§8) was not confirmed.
- The accessibility-widget's own implementation (contrast/inversion/font-scaling/
  stopped-motion CSS override mechanism) was not located or read — §5's claim about its
  interaction with `backdrop-blur` rests only on `docs/DESIGN.md` prose, not the
  implementation.
- `apps/web/src/components/chat/budget/budget-messages.tsx` — not read (likely renders
  the `BudgetError[]` notifications from `usePromptBudget`, tangential to cost display).
- Touch-target minimum size: no lint rule or design token confirmed; `Button` component
  variants in `packages/ui` and `ToggleButtonWithTooltip`'s exact classes were not
  inspected for concrete pixel sizing.
- Per-conversation UI-state persistence: only a negative result (no mechanism found) —
  not exhaustively searched beyond the `apps/web/src/stores/` directory listing and
  `model.ts`'s persistence shape.
- `chat-layout-helpers.ts` (`getMobileInputStyle()`, referenced from `chat-layout.tsx`)
  was not read in full — only the one `safe-area-inset-bottom` line was grepped.
- Backend/wire-side confirmation of what `supportedParameters` values OpenRouter actually
  sends for reasoning-capable models (e.g. `'reasoning'`, `'include_reasoning'`,
  `'reasoning_effort'`) was **not** investigated — this is frontend-only research; a
  companion backend/API research pass would need to confirm the exact parameter name(s)
  and whether `apps/api`'s model-catalog ingestion already captures them into
  `supportedParameters` today.
