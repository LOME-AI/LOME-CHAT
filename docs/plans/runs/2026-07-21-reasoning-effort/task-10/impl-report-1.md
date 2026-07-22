# T10 — Glazed thinking disclosure — impl report 1

## Objective

Implement the glazed thinking disclosure per plan §Task-T10 / D-UI: parse reasoning
from the assistant message's text field via the shared parser (through the
`@hushbox/shared` barrel), render a default-closed disclosure above the answer with a
fixed-height mask-gradient glazed preview while streaming, honest states (streaming
deltas / o-series "Reasoned privately (N tokens)" / no reasoning → nothing), real
disclosure button, `aria-hidden` preview, Virtuoso-safe row heights, zero JS
animation, reduced-motion identical, duration-label rule; built through the
`frontend-design` skill plus a design-review pass.

## Files changed

- `apps/web/src/components/chat/message/thinking-disclosure.tsx` — NEW: the
  disclosure component (all honest states, glaze, a11y wiring).
- `apps/web/src/components/chat/message/thinking-disclosure.test.tsx` — NEW: 24
  behavior tests (TDD).
- `apps/web/src/components/chat/message/message-item.tsx` — mounts the disclosure
  slot (outside the aria-live region), feeds only the parsed answer to the markdown
  renderer and its Suspense fallback, keys the streaming placeholder on the parsed
  answer being empty (ThinkingIndicator stays the live announcement surface while
  thoughts stream).
- `apps/web/src/components/chat/message/message-item.test.tsx` — new "reasoning
  disclosure" describe (8 tests).
- `apps/web/src/lib/api.ts` — optional `reasoningTokens?: number` on the client
  `Message` display shape (see Deviations: nothing populates it yet).
- `packages/shared/src/test-ids.ts` — five registry entries (`reasonedPrivately`,
  `thinkingDisclosure`, `thinkingDisclosureContent`, `thinkingDisclosurePreview`,
  `thinkingDisclosureToggle`); literal `data-testid` strings are lint-banned, so unit
  tests require registry ids.

## Tests added (name — behavior — criterion)

`thinking-disclosure.test.tsx` (all through `serializeReasoningText` from the shared
barrel; no literal delimiters except one test simulating raw native model output):

- renders nothing when no reasoning / empty message / bare native open tag — honest
  state (d).
- renders the disclosure when reasoning present — D-UI core.
- collapsed by default with a real `<button aria-expanded>` — real disclosure button.
- wires `aria-controls` button→panel — D-UI.
- hides the collapsed preview from assistive tech (`aria-hidden`) — criterion.
- shows reasoning text in the collapsed preview — D-UI.
- glazes preview with mask gradient, never blur — criterion (mask-image asserted,
  `filter` empty, no blur class).
- fixed-height preview class (`h-[4.75rem]` + `overflow-hidden`) while streaming —
  fixed-height preview / Virtuoso.
- expands on click, swaps preview for readable content; collapses on second click —
  row height changes only on user toggle.
- bounds expanded view (`max-h-60` + `overflow-y-auto`) — expanded-while-streaming
  height-bounded.
- does not glaze the expanded view.
- label "Thinking…" while reasoning streams; "Thoughts" once answer streams /
  settled; "Thoughts (1,204 tokens)" when count known; never a count while thinking —
  duration-label rule (no duration stored; no elapsed label shipped, which the rule
  permits: live elapsed *may* show, it is not required).
- "Reasoned privately (1,204 tokens)" quiet line when tokens billed with no visible
  text; nothing when count is 0 — honest state (b).
- visible inset focus ring classes (design-review finding, see below).
- header chrome `font-sans` inside the serif reading region — Reading-versus-Chrome.

`message-item.test.tsx` › reasoning disclosure:

- renders disclosure for embedded reasoning — integration.
- feeds only the parsed answer to the markdown renderer — storage doctrine
  (parse-on-demand; raw `<think>` text never hits markdown).
- disclosure stays outside the aria-live region — sole-announcement-surface rule.
- ThinkingIndicator remains while reasoning streams (answer empty) and swaps for the
  answer once tokens arrive — honest state (a) + live announcement surface.
- no disclosure without reasoning; none alongside an error message.
- reasoned-privately line renders from `message.reasoningTokens`.
- Suspense plain-text fallback shows the parsed answer, not the raw text.

## Self-gate

- `vitest run src/components/chat/message/` (apps/web) — pass, 13 files / 316+ tests
  (includes the 32 new ones).
- `pnpm test:web` (scoped check) — **360 test files / 5900 tests, ALL passed**;
  exit 1 solely from the pre-recorded foreign coverage failure
  `src/hooks/models/use-resolve-default-model.ts` branches 87.09% < 95% (plan
  §Known-foreign-failures; committed, unmodified code; attributed, not fixed).
  A FIRST full run additionally flagged `markdown-renderer.tsx` branches 78.57%;
  it did not reproduce on the immediate identical rerun and the file measures 100%
  branches under its own suites in isolation — I never touched that file or its
  tests (it carries a concurrent workstream's `@vitest-environment jsdom` pragma
  edit, present in my start snapshot). Attributed: non-deterministic coverage
  merge on foreign-modified code; raised for awareness.
- `tsc --noEmit` (apps/web) — two errors, both foreign and pre-existing on
  committed, unmodified code:
  - `apps/api/src/middleware/pipeline-bindings.ts` `ExecutionContext` — listed in
    plan §Known-foreign-failures; attributed, not fixed.
  - `apps/web/src/components/chat/model-selector/model-list-body.test.tsx(41)`
    `getPinnedLabel: () => {}` return-type error — NOT listed in the plan; file is
    committed and unmodified (`git status` clean for that dir, last touched by
    commit 92785bc4 "fixes"); reproduces with zero relation to my changes.
    Attributed, raised.
- `eslint` (run from `apps/web` and `packages/shared` package dirs, AFTER the final
  edit) on all six changed files — exit 0.
- Coverage on `thinking-disclosure.tsx` in isolation — 100% statements / branches /
  functions / lines.
- `frontend-design` detector (`detect.mjs`) on both components — `[]` clean.
- shared `test-ids.test.ts` — 41 passed (kebab/camel/uniqueness gates green).

## Acceptance criteria

- **All D-UI mechanics and honest states** — met with one carve-out:
  - (a) streaming deltas → live glazed preview — met (fixed-height, bottom-anchored
    `justify-end`, newest lines visible, emergent flow, zero JS).
  - (b) o-series "Reasoned privately (N tokens)" — component met; **data plumbing
    absent** (see Deviations 1 — the count reaches the client on no path today).
  - (c) summarized reasoning labeled as summary — **not implementable honestly**:
    no signal exists anywhere client-side (wire `reasoning-delta` events and the
    canonical inline format carry no summary marker). Summarized text renders as
    state (a). Raised for orchestrator ruling.
  - (d) no reasoning → nothing rendered — met.
- **Parses via T3 parser through the barrel; live and persisted paths identical** —
  met: the component consumes only `parseReasoningText` from `@hushbox/shared`; T8's
  always-closed accumulation means the streaming message text parses identically to
  its persisted serialization, so reload works by construction (persisted content is
  E2E-encrypted and decrypted client-side into the same field).
- **Fixed-height preview while streaming** — met (`h-[4.75rem]`, rem-based so it
  scales with the a11y font-scaling widget).
- **Row height changes only on user toggle** — met for the toggle; the preview keeps
  the same fixed height streaming and settled. Bounded exceptions inherent to
  content arrival (first reasoning delta mounts the box; expanded-while-streaming
  grows up to `max-h-60`) are the same class as normal streaming-text growth the
  list already handles (research §2: 800px overscan + late-growth re-pin).
- **Zero JS animation; reduced-motion identical** — met: no JS animation exists at
  all; the only CSS transition (chevron rotate) is globally zeroed by
  `html.reduced-motion` (`packages/ui/.../styles/motion.css`); preview "scroll" is
  emergent content flow.
- **Mask-gradient glaze, no blur filters** — met (`mask-image`/`-webkit-mask-image`
  linear-gradient inline style, cipher-wall precedent; no `filter`/`backdrop-filter`
  anywhere).
- **`aria-hidden` preview + real disclosure button** — met; additionally the whole
  disclosure is mounted OUTSIDE the message's `aria-live` region so expanded
  thoughts are never announced token-by-token; the `role="status"`
  ThinkingIndicator remains the sole live announcement surface (placeholder now
  keys on parsed-answer-empty instead of raw-content-empty, so it persists through
  the reasoning phase).
- **"Reasoned privately (N tokens)" uses persisted reasoning token count** — partial
  (Deviations 1).
- **Duration labels per approved rule** — met: no duration is stored or shown; no
  live elapsed timer shipped (rule is permissive "may"); settled label derives from
  the reasoning token count when known ("Thoughts (N tokens)") and is static
  ("Thoughts") otherwise.
- **Built through `frontend-design` + design-review pass** — skill loaded before UI
  work (context, product register, DESIGN.md, dials "chat thread / privacy-conscious
  users / warm-quiet": 5/4/4); detector run to `[]`. The design-review **subagent**
  could not be spawned (implementer runs cannot spawn subagents) and no live
  screenshot was possible (stack down; and no UI path can produce a reasoning
  message yet — rail T9 absent, trial unwired). Substituted a manual adjudicated
  audit; findings and fixes below. Raised as a deviation.

## Design-review audit (manual, adjudicated)

- Tokens only: `border-border`, `bg-muted/30`, `text-muted-foreground`,
  `hover:text-foreground`, `focus-visible:ring-ring/50`; no hex (mask gradient's
  `transparent→black` is an alpha ramp, not a palette color). Dark mode via tokens.
- One Red Rule: no red used; the disclosure is quiet chrome. Flat at rest, hairline
  border, `rounded-lg` = card radius convention.
- Reading-versus-Chrome: header button `font-sans`; thought text inherits the
  editorial serif from the bubble's `data-reading` region (thoughts are reading
  content) — deliberate.
- **Finding fixed:** raw `<button>` inside an `overflow-hidden` frame would have its
  UA focus outline clipped → added `outline-none focus-visible:ring-2
  focus-visible:ring-inset focus-visible:ring-ring/50` (inset ring cannot clip),
  pinned by test.
- A11y widget survival: mask (not blur) keeps contrast/inversion overrides
  effective; rem-based heights scale with font scaling; loosened spacing degrades
  to fewer visible preview lines (overflow hidden, bottom-anchored); stopped motion
  is a no-op by construction.
- Copy: no long dashes; ellipsis matches existing "Choosing the best model…"
  precedent; count formatted `en-US` ("1,204").
- Touch target: the toggle is a full-width row ~30px tall (matches the proposal's
  visual and the h-7 action-button precedent). Below a 44px strict target; the
  full-width hit area mitigates. Flagged for the auditor's judgment.

## Deviations (with reasons)

1. **`reasoningTokens` is a typed-but-unpopulated field.** The count reaches the
   client on NO path today: (a) live — the WS `finish` event carries
   `metadata.usage.reasoningTokens` but `chat-run.ts` drops it (`finishTile` reads
   only `finishReason`), and wiring it means editing `lib/chat-run.ts` +
   `hooks/chat/use-authenticated-chat.ts` (T8-owned files, outside my ownership);
   (b) persisted — `messageResponseSchema` / `contentItemResponseSchema`
   (`packages/shared/src/schemas/api/conversations.ts`) carry no reasoning token
   count; the server stores it on `llm_completions` only, so exposing it is an
   apps/api change (NEEDS_CONTEXT-level detail per brief: server would need to
   project `llm_completions.reasoningTokens` into the message/content-item view,
   then the client mapper stamps `Message.reasoningTokens`). Per the brief I
   implemented the state behind the minimal client-side field and raise the
   plumbing for sequencing. Until wired, o-series messages render nothing (honest
   state (d)) rather than a wrong count.
2. **State (c) "summary" label not implemented** — no client-detectable signal (see
   criteria section). Needs a protocol/wire decision, out of my scope.
3. **Design-review subagent replaced by manual audit** — cannot spawn subagents;
   stack down and no reasoning-capable UI path exists to screenshot. All other
   skill steps (context load, register, dials, detector loop to clean) followed.
4. **One line added outside listed file ownership** in `apps/web/src/lib/api.ts`
   (Message field) and five registry entries in `packages/shared/src/test-ids.ts` —
   both explicitly anticipated by the brief/plan (test-id registry is the mandated
   mechanism; literal testids are lint-banned). Both files were untouched by
   concurrent work at my `git status` snapshot.
5. **TDD process note:** the focus-ring test and its two classes were added in the
   same step (class absent when the test was written, so it was red by
   construction, but I did not execute the red run). Everything else followed
   strict red-green.

## Concerns and limitations

- **Public share view leaks raw delimiters:** `routes/share.m.$shareId.tsx` renders
  `item.content` straight into `MarkdownRenderer` — a shared assistant message with
  embedded reasoning will show raw `<think>` text on the share page. Outside my
  ownership (routes). Suggest a micro-task (parse there too, or strip at share
  time).
- **Copy button copies the raw field** (including reasoning) — `handleCopy` joins
  `m.content`. Arguably wrong UX post-T10; not in criteria, left untouched.
- Trial-chat rendering path (`TrialMessage`) not integrated — plan already routes
  this via the T8 flag → T11 follow-up.
- `MessageBody`'s share-modal preview (`share-message-modal.tsx`) shows
  `message.content` raw in its confirmation dialog — same class as the share-view
  concern, minor.

## Confidence

**High** — behavior pinned by 32 new tests (100% coverage on the new component, all
120 message-item tests green, full message-dir suite green), detector clean, lint
and typecheck clean for owned files, and the two remaining check failures are
attributed foreign failures with evidence.
