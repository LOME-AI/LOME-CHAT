# Blog read-aloud pause/resume — design analysis

Analyst, 2026-07-25 (written up by the orchestrator; the analyst has no write tools).

## Today (Verified)
- `stopRead` acts only from `loading`/`speaking`, sets `stopped`, calls `service.stop()` (`document-reader.ts:28,293-297`).
- `playChunks` always iterates `ctx.chunks` from index 0 — no cursor survives a run (`:229`).
- The prefetch window refills only on the ordered `await current.speaking` (`:227-235,258`).
- Engine `stop()` rejects queued + in-flight speaks, stops every scheduled source, resets `nextStartTime = 0` (`tts-engine.ts:413-462`).
- Scheduling: `startTime = Math.max(nextStartTime, ctx.currentTime)` (`:702`).
- **`scheduleAudio` auto-resumes a suspended context** (`:689-691`) — load-bearing below.
- The island owns the AudioContext and injects it; `primeAudioContext` plays a silent buffer but **never calls `resume()`** (`blog-read-aloud.tsx:125-132,381`).
- Component clears `lastChunkRef` + highlight on `idle`/`stopped`/`error`; `handleStop` also bumps `runIdRef` and nulls `readerRef`/`highlighterRef` (`:335-360`).
- Esc handler acts only on `loading`/`speaking` (`:406-419`). No idle/teardown timers anywhere.
- Chunk ≈ 25 words ⇒ roughly 4–10 s of speech (`sentence-splitter.ts:2`).
- Layout budget: reader stack is `md:w-72` (288 px) inside a band whose height is the byline+tags block (~70 px), content already ~73 px.

## Options
- **A — AudioContext `suspend()`/`resume()` (true mid-sentence).** The scheduling math *does* hold: `currentTime` freezes, so `Math.max` stays correct. **But `scheduleAudio:689-691` auto-resumes the context the moment a windowed speak lands**, so A cannot be built from the island alone — it needs an engine-owned `pause()`/`resume()` or a `paused` flag gating that auto-resume, i.e. a **second G1/G8 reversal**. That auto-resume is chat's existing recovery for browser-initiated suspension, so it must be gated, never removed. Every exit from paused must then call `ctx.resume()` **in-gesture**. In-flight exposure while suspended is bounded at pool size (≤4 speaks / ≤4 MB buffers).
- **B — chunk-index checkpoint (recommended).** Pause = record the painted chunk index, set `paused`, call `tts.stop()`. Resume = re-enter `playChunks` at that index. **No engine change**; ~30 lines in `document-reader.ts`. Costs: re-hear up to one chunk (4–10 s) and one synthesis gap (~0.3–1.5 s, Assumed), plus ≤4 window chunks re-synthesized (on-device CPU only).
- **C — sample-offset resume in the engine.** Same reversal as A plus hand-rolling what `suspend()` already does. Rejected.
- **D — park the loop at a chunk boundary.** Factually broken: chunks N+1..N+3 are already `start()`ed at future times, so audio keeps playing up to ~30 s past the click. Rejected.
- **E — `<audio>`/MediaStream playback (native transport, iOS lock-screen controls).** Replaces the engine's entire scheduler; wholesale G1/G2/G8 reversal. Rejected — record as the re-entry option if lock-screen transport becomes a requirement.

**Recommendation: B (med-high).** Resume is literally "start from index k" — the same single playback path, holding nothing in the audio graph across the pause. Identical behavior after 5 seconds or 30 minutes, on any browser, immune to WebKit's `interrupted` state. Needs no founder API gate and touches nothing chat depends on. **Decisive: A is strictly additive on top of B** — A still needs the same `paused` state, the same retained index (as its failure recovery), and the same UI, so B is never throwaway work and leaves the mid-sentence upgrade open behind a real-device iOS test.

What would change the call: the founder ruling that "where it left off" means literal mid-word; or a measurement showing per-chunk synthesis latency ≫1.5 s.

## iOS
- `resume()` needs gesture authority, and must be **synchronous in the handler before any `await`** (same rule as `research/ios-audio-unlock.md`). In the resume path no dynamic import remains, so the chain is synchronous — safe if built that way, trivially broken if made `async`.
- **WebKit has a fourth state, `interrupted`** (tab switch, backgrounding, screen lock, competing audio). It does **not** auto-resume, and `resume()` while interrupted does not resume playback; some reports show a promise that never settles. (WebKit layout test `audiocontext-state-interrupted.html`; WebKit 263627, 273511; WebAudio #2585.) Verified as documentation, no device test run.
- Mild point for A: MDN notes an interruption arriving while the context is *already suspended* does not transition it to `interrupted`.

## Highlight while paused
Keep it painted — it is the only on-screen marker of position. Requires: a `paused` branch in `applyReaderState` that does **not** clear `lastChunkRef` or call `highlighter.clear()`; **pause must not bump `runIdRef`** or null `readerRef`/`highlighterRef` (bumping the run token silently drops every callback from the resumed read — the highest-risk bug in this change); `stopRead` and the Esc handler must both act from `paused`.

## Control shape
Bounds: one row only, 288 px wide, no borders/background, no appearing/floating chrome.
- **U2 (recommended)** — two-segment transport pill + the existing highlight toggle. Segment 1 cycles Listen → Pause → Resume with a fixed `min-w` so the label change causes no reflow; segment 2 is a square Stop, always rendered, `disabled` while idle. ≈185 px of 288 px, **zero layout shift in any state**.
- U1 (Stop appears only while active) shifts the centred row ~22 px on every start/stop. U3 (Esc-only stop) fails accessibility. U4 (two rows) exceeds the band height.

## Edge cases
Pause only from `speaking` (`load()` has no cancel); Stop stays available in `loading`/`speaking`/`paused`. Unmount must act from `paused`. Stop-from-paused resets the cursor to chunk 0. Rapid pause/resume guarded by state. Pause with a full window: `tts.stop()` rejects up to 3 pending speaks — `absorbRejectionNow` claims them and the ordered loop's `catch` must observe `state !== 'speaking'` and break **without** transitioning to `error`. Voice is captured per run; resume keeps the starting voice. No idle timeout exists, so a long pause holds only the model weights.

## Free adjacent fix (recommended regardless of mechanism)
`primeAudioContext` never calls `ctx.resume()`, and the engine's only recovery matches `'suspended'` (never `'interrupted'`) and runs outside the gesture — so **a Listen after backgrounding the tab can be silently mute on iOS today**. Two lines, in-gesture, no API change.

## Scope (Option B)
- **P1 — `document-reader.ts` (+ test):** index cursor replacing the iterator; `currentIndex` recorded where `onChunk` fires; `paused` state; `stopRead` acts from `paused` and resets the cursor; window-rejection path proven not to error. Auditors: 1.
- **P2 — `blog-read-aloud.tsx` (+ test):** `paused` UiStatus, U2 control row, refs retained across pause, Esc/unmount handle `paused`, in-gesture `ctx.resume()` in the primer. Depends on P1. Auditors: 1.
- No marketing change, no engine change, no new dependency. (Option A would add a P0 on `tts-engine.ts` with 2 auditors.)

## Reproduction as spec (first failing test)
`document-reader.test.ts`, existing `makeFakeTts({ perCallSpeakGate: true })` harness:
`it('resumes at the chunk that was playing, not at the first chunk')` — ≥6 chunks; `void reader.start()`; flush; resolve `speakDeferreds[0]` so chunk 1 becomes current; `reader.pause()`; assert last state `'paused'`; `reader.resume()`; **assert the first text spoken after resume is chunk 1's, not chunk 0's**. RED today twice over: `pause`/`resume` don't exist, and the equivalent (`stop()` then `start()`) speaks chunk 0 because the iterator rebuilds from index 0.
Companions: pause with a full window never transitions to `error`; stop-from-paused resets to chunk 0; the paused chunk stays highlighted through a highlight toggle; Esc while paused stops and clears; resume calls `ctx.resume()` synchronously inside the click.

## Assumptions
Per-chunk synthesis latency ~0.3–1.5 s — Assumed, inherited from `research/tts-throughput.md`, still unmeasured; it sizes B's resume gap.
