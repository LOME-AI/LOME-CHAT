# T14 — Raw-text consumers strip reasoning — impl report 1

## Objective

No user-facing surface shows literal think-delimiters: the public share view and copy-to-clipboard emit the parsed answer; sweep apps/web for every other raw message-text consumer and parse or justify each (plan §T14).

## Files changed

- `apps/web/src/routes/share.m.$shareId.tsx` — text content items render `parseReasoningText(item.content).answer` instead of raw content (share API has no role field; parse is a no-op without a leading delimiter).
- `apps/web/src/routes/share.m.$shareId.test.tsx` — new test pinning the parsed-answer render for a reasoning-bearing text item.
- `apps/web/src/components/chat/layout/chat-layout-helpers.ts` — `sharedMessageContent` (the share-modal preview feed) parses assistant content to its answer; user content stays verbatim. This fixes the share-modal preview leak at its assembly point without touching the T10-owned modal file.
- `apps/web/src/components/chat/layout/chat-layout-helpers.test.ts` — two new tests: assistant preview stripped, user preview verbatim.
- `apps/web/src/components/chat/message/message-item.tsx` — `handleCopy` emits `parseReasoningText(m.content).answer` for assistant messages, verbatim for user messages. Edited AFTER the orchestrator released the T10 bound (T10 audit CLEAN, mid-task coordinator message 2026-07-22).
- `apps/web/src/components/chat/message/message-item.test.tsx` — two new copy tests: parsed answer for reasoning-bearing assistant message (RED verified — clipboard received raw delimited text — then GREEN), user content verbatim.

All test fixtures build delimited text via `serializeReasoningText` from the `@hushbox/shared` barrel — no literal delimiter appears in any edited file (G7 honored; repo grep for `<think` outside the shared module is clean in apps/web).

## Tests added

- `share.m.$shareId.test.tsx` — "renders only the parsed answer for a reasoning-bearing text item" — share render criterion. RED verified (raw `<think>…` rendered), then GREEN.
- `chat-layout-helpers.test.ts` — "strips embedded reasoning from an assistant shared-message preview" — share-modal preview. RED verified, then GREEN.
- `chat-layout-helpers.test.ts` — "leaves a user shared-message preview verbatim" — pins the role conditional (passes before AND would fail if parsing were unconditional; it pins the deliberate user-verbatim branch added in the same edit).

## Self-gate

- `eslint <all 6 changed files>` from `apps/web` after the final edit — pass (exit 0). Prettier check also pass.
- `npx tsc --noEmit` (apps/web) — only the two plan-known foreign errors (`../api/src/middleware/pipeline-bindings.ts` ExecutionContext; `model-list-body.test.tsx:41`), matching §Known-foreign-failures; none in my files.
- Focused suites — `share.m.$shareId.test.tsx` + `chat-layout-helpers.test.ts` 37/37 pass; `message-item.test.tsx` 122/122 pass.
- `pnpm test:web` (full, with coverage) — see "Full-suite result".

## Sweep — every raw `content` consumer in apps/web, disposition

Fixed:

1. `routes/share.m.$shareId.tsx:90` — public share view rendered raw text → parsed (this task).
2. `components/chat/layout/chat-layout-helpers.ts:86` — share-modal preview feed (renders at `share-message-modal.tsx:74`) → parsed at assembly point (this task). The modal file itself is T10-dir and was not edited; the helper is its only production feed.

3. `components/chat/message/message-item.tsx` — `handleCopy` wrote raw `m.content` to the clipboard. Initially flagged-not-fixed (T10-owned dir under audit per brief bounds); after the orchestrator's mid-task message that T10 is CLEAN and the dir is freed, fixed in this task (assistant messages parsed, user messages verbatim) with RED-verified tests.

Justified (no change needed):

- `components/chat/message/**` display path (`message-item.tsx:563`, `thinking-disclosure.tsx`, `markdown-renderer` feed) — T10 already parses; expected-clean per brief. `message-list.tsx:411` compares a decryption-failure prefix, not display.
- User-message rendering (`message-item.tsx:600,607`) and edit handler (`:212`) — user content displays and edits verbatim by design; the doctrine covers assistant text.
- `routes/share.c.$conversationId.tsx` — renders via `AuthenticatedChatPage` → `MessageList` → `MessageItem`, which parses. No raw text path.
- TTS (`use-chat-stream.ts:351-356` feeder; `lib/tts-dom-observer.ts`) — feeder consumes `onToken` only (`onReasoningToken` is a separate callback, chat-run.ts:203-207), so spoken text is answer-channel only; the DOM observer reads rendered (already-parsed) `[data-tts-stream]` text.
- Document panel / document-parser (`document-panel.tsx` copy/download, `document-card.tsx`) — documents are extracted inside `markdown-renderer.tsx`, which receives the parsed answer; `document.content` cannot contain reasoning.
- `hooks/realtime/use-remote-streaming.ts` — consumes only `text-delta` frames (other kinds ignored) and phantom content renders through `MessageItem` (parsed) via `authenticated-chat-page.tsx:50`.
- Chat state plumbing (`stores/trial-chat.ts`, `stores/chat-error.ts`, `lib/chat-messages.ts`, `lib/chat/auth-chat-helpers.ts`, trial/auth page content passthroughs) — state assembly, not display; rendering happens in `MessageItem`. `chat-messages.ts` already accumulates via the shared serializer (T8).
- History builders (`use-chat-stream.ts` `toHistory` + trial history, `lib/chat-regeneration.ts:261`) — not display surfaces. They DO send assistant content (potentially with embedded reasoning) to the server as inference history; stripping there is G8's concern, assigned to the server-side history-build seam (T6, not yet implemented). See Concerns.
- `demo/mock-backend/**` — canned demo fixtures, not model output; demo messages render through the normal parsed components anyway.
- Sidebar search (`sidebar-content.tsx`) — filters conversation titles only; no message-text preview surface exists. No export or notifications-preview surface renders message text (export feature was dropped by founder ruling).

## Acceptance criteria

- Share view emits parsed answer — **met** (fix + pinning test, RED→GREEN).
- Copy-to-clipboard emits parsed answer — **met** (fix + pinning tests, RED→GREEN; done after the orchestrator freed the T10 dir mid-task).
- Grep-level sweep, each consumer parsed or justified — **met** (table above).
- No literal delimiters outside the shared module — **met** (grep clean; all test fixtures build delimited text via the shared serializer).
- Tests pin share render and copy output — **met**.

## Deviations

- Share-modal preview fixed in `chat-layout-helpers.ts` (layout dir) rather than in the modal component — same rendered outcome; chosen while the T10 bound was still in force and kept (it is the tighter fix: the helper is the modal's only production feed).
- Role-conditional parsing in the modal-preview feed (assistant only); the public share route parses unconditionally because its API payload carries no role. Divergence is deliberate and commented in both files.

## Concerns / limitations

- G8 client-side observation: the authenticated and trial run bodies send client-built `history` containing raw assistant content; once reasoning-bearing messages exist, thoughts ride the wire back unless T6's server seam strips incoming history (E2EE means the server cannot rebuild history itself — T6's "existing history-build seam" must be the one processing this client-supplied history). Flagged so T5/T6 verify the seam covers client-supplied history.
- (Verified clean, read-only) T10's `thinking-disclosure.tsx` renders reasoning as plain text, not through `MarkdownRenderer` — no document extraction from thoughts.

## Full-suite result

Three `pnpm test:web` runs:

1. First run — crashed in the coverage merge: "Something removed the coverage directory apps/web/coverage/.tmp … Make sure you are not running multiple Vitests with the same coverage.reportsDirectory" + ENOENT on a `.tmp/coverage-*.json`. No test failures printed. Attributed to concurrent work sharing the machine (other agents run in this repo) and/or the previously-investigated intermittent coverage-ENOENT crash; not caused by my changes (reproduced nowhere else, and the rerun was clean).
2. Rerun (before the copy fix) — 360/360 test files pass, 0 test failures; exit 1 SOLELY from the plan-known foreign per-file coverage gap `src/hooks/models/use-resolve-default-model.ts` (branches 87.09% < 95%; §Known-foreign-failures — note the plan writes the path as `hooks/chat/…`, the actual file is `hooks/models/…`, same known item). No other coverage errors — all files I touched meet per-file thresholds.
3. Final run (after the copy fix) — 360/360 test files pass, 0 test failures; exit 1 solely from the same attributed foreign coverage error (`use-resolve-default-model.ts` branches 87.09%). No coverage error on any file I touched (message-item components stay at their T10-audited thresholds; `chat-layout-helpers.ts` 100%).

## Confidence

High — both fixes are one-expression presentation changes behind RED-verified tests; the sweep was grep-driven and each consumer traced to its render path.
