# iOS first-listen audio unlock — feasibility analysis

Analyst, 2026-07-24. Question: the G2-safe way to make iOS Safari first-listen audio reliably unlock for blog "Listen", and whether any workable option requires changing the shared TTS engine's public API.

## Bug chain (Verified against code)
- `blog-read-aloud.tsx:252` `handleStart` is async; on click it does `setStatus('loading')` (sync) then `await Promise.all([import('document-reader'), import('chunk-highlighter')])` (`:271`) — an `await` — before anything touches audio.
- Only after that await does `documentReader.start()` → `tts.unlockAudio()` run (`document-reader.ts:225`).
- `unlockAudio()` (`tts-engine.ts:314-323`) does `new AudioContext()` + silent-buffer play and stores `this.audioCtx`; `scheduleAudio` reuses it via `this.audioCtx ??= new AudioContext()` (`:655`). Engine contract comment (`:61-63`): "must be called inside a user gesture (click) on iOS to unlock." The blog island breaks that contract — the dynamic-import await sits between gesture and `new AudioContext()`.

## iOS behavior
- Verified (converging secondary sources: WebAudio discussion #2604, mattmontag, Apple Forums 126136, WebKit bug 180522): on iOS Safari the reliable pattern is to create/resume the ONE context that will play, synchronously in the gesture, before any `await`. An `await` drops WebKit's call-stack user-activation token; a context created/resumed after it starts suspended.
- Inferred (high): unlock is per-AudioContext-instance on iOS — unlocking a throwaway standalone context does NOT confer running state on a different context the engine creates later. Cheap conversion to Verified = one real-device iOS Safari test.

## Options
- **A — standalone pre-unlock helper in the island.** iOS: DOES NOT WORK (per-context unlock; helper's context ≠ engine's). Engine change: none. (The completeness critic's proposal; rests on a false page-global-unlock model.)
- **B — create the AudioContext in-gesture in the island (a platform global, not an engine import), play silent buffer, inject it into the engine as its `this.audioCtx`.** iOS: WORKS. Engine change: YES — additive, backward-compatible (`unlockAudio(existing?: AudioContext)` or `adoptAudioContext(ctx)`); chat's existing `unlockAudio()` call untouched and chat inherits a more robust path. `scheduleAudio` already funnels through `this.audioCtx ??= …`, so adoption is a one-line assignment. (The T4 auditor's position.)
- **C — eagerly call `getTtsService().unlockAudio()` on the island.** Works only with a STATIC engine import → breaks G2; the dynamic-import variant re-creates the pre-unlock await. Rejected.
- **D — accept the limitation.** Sacrifices accessibility (silent first-click failure on iOS). Rejected.

## Recommendation: Option B (high confidence on ranking; med on the per-context iOS claim until a device test).
It is the only approach that is simultaneously G2-safe and actually unlocks first-listen on iOS. A/D fail accessibility, C fails G2. **B requires reversing G1/G8** (engine public-API freeze) — this is the founder's gate; there is no G2-safe fix that avoids it, because unlocking synchronously needs an in-gesture context, the engine owns the playing context, and its current API gives no way to supply one.

## Reproduction (bug spec for the implementer)
Unit test (packages/ui, fake TtsService): assert `handleStart` causes the AudioContext/unlock to be created/invoked synchronously within the click task, BEFORE the dynamic-import await resolves (spy call precedes the import promise `.then`). Red today. iOS gesture semantics aren't reproducible in happy-dom, so the load-bearing assertion is ordering, not real audio output; real-device iOS stays a manual acceptance check.

## Assumptions / verification gap
- Per-AudioContext-instance unlock on 2025-2026 iOS Safari — Inferred (high). If a device test showed a standalone context globally unlocks later contexts, Option A becomes viable and no engine change is needed — so that test is the highest-value cheap disambiguation before implementing B.
