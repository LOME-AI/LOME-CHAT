# T9 — Maestro flow selector-resolution FIX (impl report 2)

## Objective

Fix the validated Critical finding on the T9 Maestro flow: the flow's navigation
`id:` selectors did not resolve to real HTML `id` attributes, so the flow failed at
its first `tapOn` and never reached the render-status assertion. Make every selector
reference a real attribute/text, applying the right primitive per element (literal
`id` for singletons; stable text for list items).

## Files changed

- `apps/web/src/components/document-panel/document-panel.tsx` — added a literal
  `id="document-panel"` on the panel root `<div>` (alongside its existing
  `data-testid`, an independent mechanism). The panel is a true singleton (one
  `DocumentPanel`, one active document; the root renders only when open — the exact
  element the flow's `extendedWaitUntil id: 'document-panel'` waits for).
- `mobile-tests/flows/14-document-renders.yaml` — reworked the four failing
  navigation selectors (below). Login subflow, `extendedWaitUntil`,
  `androidWebViewHierarchy: devtools`, no-screenshots, and the final
  `Preview rendered` assertion are all kept as authored. Step count unchanged (21),
  so harness weighting is unaffected.

## Selector fixes (primitive per element)

| Flow selector (before) | After | Backing attribute |
|---|---|---|
| `id: 'sidebar-trigger'` | `id: 'hamburger-button'` | real `id="hamburger-button"` on `HamburgerButton` (hamburger-button.tsx:18) — the mobile sidebar opener |
| `id: 'chat-link'` | text `'Mobile render proof'` | conversation **title** text (list item — no shared id) — **pends a seed-title change, see Concerns** |
| `id: 'document-card'` | text `'HTML'` | card's rendered title (`extractTitle`→`getLanguageDisplayName('html')` = `"HTML"`, verified) |
| `id: 'document-panel'` | `id: 'document-panel'` | now backed by the literal `id` I added |

Unchanged real selectors: `id: 'model-selector-button'` (real id, per research) and
the final `'Preview rendered'` assertion (T4's `#document-render-status` mirror).

## Why sidebar-trigger became hamburger-button (finding cause corrected)

The finding stated `sidebar-trigger` "carries only `data-testid`, not a literal id."
That is inaccurate: `SidebarFooterBase` already renders `id="sidebar-trigger"`
(sidebar-footer-base.tsx:40). The real failure cause is structural: `sidebar-trigger`
is the sidebar **footer account-menu** button, which lives *inside* the mobile drawer
(`SidebarPanel open={mobileSidebarOpen}`, sidebar.tsx) — it is not in the DOM until the
drawer opens, and it opens the account dropdown, not the conversation list. On mobile,
the element that opens the conversation sidebar is the hamburger button
(`setMobileSidebarOpen(true)`), which already carries a literal `id="hamburger-button"`.
So the flow now taps the hamburger; no new id was needed for that step.

## Why document-card is tapped by text, not a literal id

The brief permitted a literal id "if there is exactly one card in view." There is
exactly one in the seeded conversation, but the id would sit on the `DocumentCard`
**component**, so any message with ≥2 fenced ≥15-line blocks (or multiple document
messages) would emit duplicate `id="document-card"` — invalid HTML that breaks
`getElementById`/a11y app-wide. That is a global defect the flow's single-card context
does not bound, so I tapped the card by its rendered title text `"HTML"` instead
(verified end-to-end through the parser + shiki display-name map).

## Self-gate

- `eslint src/components/document-panel/document-panel.tsx` (from `apps/web`, after
  last edit) — **pass** (exit 0).
- `turbo typecheck --filter=@hushbox/web` — **pass** (1 successful).
- `document-panel.test.tsx` (via `with-env` wrapper) — **pass**, 46/46. (The
  `NetworkError … render.html` logs are pre-existing sandbox-fetch noise under
  happy-dom, not from this change; tests pass.)
- `vitest run scripts/mobile-test.test.ts` — **pass**, 144/144 (flow discovery +
  weighting over the real flows dir, incl. the edited flow).
- Flow YAML — valid: 2 docs (config + 21 steps), `androidWebViewHierarchy: devtools`,
  final step asserts `Preview rendered`. Every `id:` selector maps to a real literal
  HTML id; `'HTML'` and `'Preview rendered'` map to real rendered text.
- Full `turbo lint --filter=@hushbox/web` — did not complete cleanly: the process
  shut down at ~3 min emitting **zero eslint violations** (a resource/process
  shutdown under concurrent-work load, not a lint-rule failure on any file). The
  required gate — `eslint` on the owned file after the last edit — is exit 0
  (reconfirmed), and typecheck passed, so there is no lint regression from this change.

## Acceptance criteria

- **Flow `id:` selectors resolve to real HTML `id` attributes** — met.
  `hamburger-button`, `model-selector-button`, and `document-panel` are all literal
  ids in the DOM (the last one added here).
- **List/non-safe-singleton elements tapped by stable text** — met for the document
  card (`'HTML'`); met-by-construction for the chat row (`'Mobile render proof'`)
  **once the seed titles the conversation** — see Concerns.
- **Flow otherwise as-authored** — met (login subflow, `extendedWaitUntil`, devtools,
  no screenshots, `Preview rendered` assertion, 21 steps).
- **id additions don't regress apps/web** — met (typecheck, owned-file lint,
  document-panel test all green).

## Concerns and limitations

1. **BLOCKING (out of my bounds): the seeded conversation is untitled, so the chat
   row has no tappable text.** `documentSeedPayload()` (scripts/mobile-test.ts) sends
   no title; `seedConversationWork`→`createDevConversation` defaults `title: ''`
   (factories.ts:352); and an empty title renders as the permanent placeholder
   `"Decrypting..."` (chat.ts:291 — `!conv.title` ⇒ `DECRYPTING_TITLE`). There is no
   stable/unique text to tap on that row. The flow now taps the conversation by the
   title `'Mobile render proof'`; for that to match at runtime the harness must seed
   the conversation **with that title**, which requires (a) `conversationBodySchema`
   in the dev routes to accept a `title` and `seedConversationWork` to forward it
   (**apps/api — explicitly out of bounds**), and (b) `documentSeedPayload()` to pass
   `title: 'Mobile render proof'` (**scripts/ — not in my granted bounds**). Tapping
   the placeholder `"Decrypting..."` instead was rejected as papering over a UI/seed
   defect and being non-unique/fragile. Until the seed titles the conversation, the
   flow will fail at the chat-row step on the emulator run.
2. **The mobile persona has exactly one conversation.** `seedTestPersonas`
   (scripts/seed.ts) does not seed sample data (`hasSampleData` is only consumed by
   `seedDevData` for dev personas), so `tmu` owns only the seeded document
   conversation. The title-text tap is robust regardless of row count, so this is not
   relied upon — noted for context.
3. **No emulator run performed.** No Android emulator here; the founder's
   `pnpm mobile:test` at close remains the real acceptance gate. This fix addresses
   the static selector-resolution failure so the flow *can* pass once the seed-title
   dependency (Concern 1) lands.

## Confidence

medium — the in-bounds selector fixes are correct and verified against the actual
components/parser (typecheck, lint, unit + component tests green), but the flow cannot
pass end-to-end until the out-of-bounds seed-title change lands, and the emulator run
is the true gate.
