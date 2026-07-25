# T6 — iOS first-listen audio unlock — implementation report 1

## Objective

Make iOS Safari first-listen audio unlock reliably for the blog reader: create and prime
the playing `AudioContext` synchronously inside the click gesture (in the island, from the
browser global), then inject that instance into the shared engine so it is the context that
actually plays. Option B from `research/ios-audio-unlock.md`, under the founder-approved
additive reversal of G1/G8. Plus the folded comment-only `~80 MB` → `~90 MB` fix.

## Files changed

- `packages/ui/src/components/accessibility/lib/tts-engine.ts` — `unlockAudio(existing?: AudioContext)`:
  one optional parameter on the interface and the implementation; the body's single
  `new AudioContext()` becomes `existing ?? new AudioContext()`. Nothing else in the engine
  moved (no pool, protocol, playback-chain, or model-config change).
- `packages/ui/src/components/accessibility/lib/tts-engine.test.ts` — two new tests plus an
  `audioContextConstructor()` helper that reads back the stubbed global so a test can assert
  the engine never constructed a context of its own.
- `packages/ui/src/components/accessibility/lib/document-reader.ts` — `start(audioCtx?: AudioContext)`
  threads the caller's context to `tts.unlockAudio(audioCtx)`; file-header and `start()` doc
  comments updated to state the new second way of satisfying the iOS-gesture requirement.
- `packages/ui/src/components/accessibility/lib/document-reader.test.ts` — the fake TtsService
  now records each `unlockAudio` argument (`unlockContexts`); two new tests.
- `packages/ui/src/components/blog-reader/blog-read-aloud.tsx` — module-level `primeAudioContext()`
  (create-once + silent-buffer prime), an `audioCtxRef`, the prime call as the first statement
  of `handleStart`'s `try` (before the dynamic `import`), `audioCtx` on `RunContext`, and
  `documentReader.start(ctx.audioCtx)`.
- `packages/ui/src/components/blog-reader/blog-read-aloud.test.tsx` — global `AudioContext`
  stub (recording contexts and primed sources, restored in `afterEach`), three new tests.
- `packages/ui/src/components/accessibility/lib/tts.worker.ts` — comment only: `~80 MB` → `~90 MB`
  on the q8 line, fp32 `~330 MB` contrast kept. Verified by diff to be the only line I touched
  in that file (the `env.wasmPaths` block in its diff-vs-HEAD is T1's pre-existing work).

## The additive engine API

```ts
// interface TtsService
unlockAudio(existing?: AudioContext): void;

// implementation
unlockAudio(existing?: AudioContext): void {
  if (this.audioCtx !== null) return;
  const ctx = existing ?? new AudioContext();
  this.audioCtx = ctx;
  // …unchanged silent-buffer prime…
}
```

Backward compatibility, evidenced:

- The zero-argument form is unchanged at the call level and in behavior — an optional
  parameter is source- and type-compatible with every existing caller and with every fake
  implementing `TtsService` (a `() => void` remains assignable to `(existing?: AudioContext) => void`).
- The two pre-existing engine tests that pin the zero-arg contract
  (`unlockAudio() creates an AudioContext and primes it with a 1-sample buffer`,
  `unlockAudio() is idempotent …`) pass **unmodified**, as do the six later engine tests that
  call `service.unlockAudio()` before driving playback.
- There is no production chat call site of `unlockAudio` to update: repo-wide, the only
  non-test caller is `document-reader.ts`. Chat's TTS paths reach the engine through
  `getTtsService().load(…)` / `.stop()` (`apps/web/src/lib/prewarm-tts.ts:18`,
  `apps/web/src/lib/chat-tts-stream.ts:63,99`) and through `tts-stream-feeder.ts`; none of
  those files was touched. `apps/web` typecheck passes and the three chat-TTS test files
  (`chat-tts-stream`, `prewarm-tts`, `tts-dom-observer`, 41 tests) pass unmodified, as do
  `accessibility-panel.test.tsx` and `tts-stream-feeder.test.ts` inside the full `test:ui` run.

## Tests added

Each was watched fail before the corresponding implementation edit (see TDD evidence below).

| Test | Behavior | Criterion |
| --- | --- | --- |
| `unlockAudio(existing) adopts the supplied context instead of constructing one` (tts-engine.test.ts) | the passed context is primed and no new one is constructed | (1) |
| `plays through the adopted context rather than a context of its own` (tts-engine.test.ts) | a full load → speak → speakReady flow schedules its buffer on the adopted context (`createBuffer(1, 100, 24_000)`, `connect(supplied.destination)`, `start()`), the global constructor never called | (2) |
| `hands start()'s AudioContext to the engine so the gesture-unlocked one plays` (document-reader.test.ts) | `start(ctx)` forwards to `unlockAudio(ctx)` | (2), (3) |
| `leaves the engine to create its own context when start() is given none` (document-reader.test.ts) | `start()` still calls `unlockAudio(undefined)` — the old path | (1), (5) |
| `creates and primes the AudioContext inside the click, before the import resolves` (blog-read-aloud.test.tsx) | after a synchronous `fireEvent.click` with **no** intervening await: one context exists, its silent source is connected + started, and `createDocumentReader` has not yet been called (the dynamic import has not resolved) | (3), (4) |
| `hands the primed context to the reader so the engine adopts it` (blog-read-aloud.test.tsx) | `reader.start` is called with the exact instance primed in the gesture | (2), (3) |
| `re-primes the one context on a later listen instead of creating another` (blog-read-aloud.test.tsx) | second listen re-primes the same instance (2 primed sources, 1 context) | (2) — see note |

Note on the third island test: the engine keeps the **first** context it adopts, so a second
listen must re-prime *that* instance rather than build a new one — otherwise the second run
would play through a context that was never re-unlocked inside the second gesture. It also
avoids leaking one AudioContext per click against Safari's per-page cap.

## TDD evidence (red before green)

- Engine: `vitest run tts-engine.test.ts -t 'adopt'` → **2 failed**, both
  `expected "vi.fn()" to not be called at all, but actually been called 1 times` — i.e. the
  engine ignored the argument and constructed its own context. After the 3-line engine
  change: 61/61 pass.
- Document reader: `vitest run document-reader.test.ts -t 'AudioContext'` → **1 failed**,
  `expected [ {} ] received [ undefined ]` — `start()` dropped the argument. After threading:
  26/26 pass. (The companion "given none" test passed from the start by design: it pins the
  unchanged old path for criterion (1)/(5) rather than driving new code.)
- Island: `vitest run blog-read-aloud.test.tsx -t 'audio unlock'` → **3 failed**, the first
  on `expected [] to have a length of 1` — today's code touches no audio inside the click.
  After the island change: 29/29 pass.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:ui` | pass — 94 files, 1851 tests, coverage gate green |
| `npx turbo typecheck lint --filter=@hushbox/ui --filter=@hushbox/marketing --force` | pass — 4/4 tasks |
| `npx eslint <7 owned files>` (from `packages/ui`, after the final edit) | pass — exit 0 |
| `npx jscpd --threshold 2 <owned source files>` | pass — 0 clones (4 files, 1418 lines) |
| `npx turbo typecheck --filter=@hushbox/web --force` (extra sanity) | pass |
| `vitest run` on the three `apps/web` chat-TTS test files (extra sanity) | pass — 41 tests |

Per-file coverage of owned files (from the `pnpm test:ui` report):

- `blog-read-aloud.tsx` — 100 / 100 / 100 / 100
- `document-reader.ts` — 100 / 100 / 100 / 100
- `tts-engine.ts` — 99.31 stmts / 100 branch / 100 func / 99.25 lines, uncovered `381-382`
  (pre-existing, inside `speak()`'s scheduling catch; untouched by this task)
- `tts.worker.ts` — 100 / 100 / 100 / 100

The jscpd run writes `packages/ui/reports/`; it was deleted afterwards (no stray artifact).

## Acceptance criteria

1. **Engine exposes an additive, optional way to adopt an external context; the no-arg call
   behaves exactly as today — met.** `unlockAudio(existing?: AudioContext)`; the only body
   change is `existing ?? new AudioContext()`. Zero-arg behavior is pinned by two
   pre-existing unmodified tests, and by the new `document-reader` test asserting the reader
   still calls it with no context when given none.
2. **The adopted context is the one that actually plays — met.** `scheduleAudio`'s
   `this.audioCtx ??= new AudioContext()` now finds the adopted instance already set. Pinned
   end-to-end by `plays through the adopted context rather than a context of its own`, which
   asserts the speak buffer is created/connected/started on the supplied context and that the
   global `AudioContext` constructor is never invoked.
3. **Island creates + primes the context synchronously in the click, before any await, and
   passes it through — met.** `primeAudioContext()` runs as the first statement inside
   `handleStart`'s `try`, ahead of `await Promise.all([import(...), import(...)])`; the
   instance is carried on `RunContext` into `documentReader.start(ctx.audioCtx)` →
   `tts.unlockAudio(audioCtx)`. Placing it inside `try` (still synchronous) means a
   construction failure surfaces as the existing inline error state instead of an unhandled
   rejection from the `void handleStart()` call site.
4. **Unit test pins ordering — met.** The load-bearing test dispatches `fireEvent.click`
   and asserts, with no `await` between the dispatch and the assertions, that the context
   exists and was primed *and* that `createDocumentReader` has not been called — the dynamic
   import provably has not resolved yet. It failed red on today's code.
5. **Chat read-aloud unaffected — met.** See "The additive engine API" above: no chat file
   touched, no chat test modified, all chat-TTS tests green, `apps/web` typecheck green.

Also, per constraint checks:

- **G1 model config untouched.** `tts.worker.ts` diff is one comment line; `MODEL_ID`
  (`onnx-community/Kokoro-82M-v1.0-ONNX`), `DTYPE` (`q8`), device, voices, `env.wasmPaths`,
  and the worker protocol are byte-identical. `WORKER_POOL_SIZE` and the pool logic untouched.
  The /chat model-cache dedup therefore still holds.
- **G2 re-verified from a fresh marketing build** (`turbo build --filter=@hushbox/marketing --force`):
  the island chunk `dist/_astro/blog-reader.*.js` contains **0** occurrences of `getTtsService`,
  `unlockAudio`, `tts.worker`, `af_heart`, or `KokoroTTS`/`onnx-community`; its only audio
  reference is the one `new AudioContext` I added (a browser global). `kokoro` appears only in
  `dist/_astro/tts.worker-*.js`, reached from `dist/_astro/tts-engine.*.js`, which in turn is
  reached only through the island's two lazy `import(\`./document-reader.*.js\`)` /
  `import(\`./chunk-highlighter.*.js\`)` calls emitted in the island chunk.
- **Amended comment fix.** `tts.worker.ts` q8 line now reads `~90 MB (vs ~330 MB at fp32)`.

## Deviations

None from the plan's approach. Two judgment calls worth naming:

- **`document-reader.ts` was edited** (the plan allowed it "only if the context must thread
  through its `start()`"). It must: the island cannot reach the engine except through the
  reader it constructs after the dynamic import.
- **The context is created once and re-primed**, rather than constructed per click. Rationale
  in the "Tests added" note; it is required for correctness on a second listen, not just
  hygiene.

## Concerns and limitations

- The load-bearing claim — that iOS unlock is per-`AudioContext`-instance — remains
  *Inferred (high)* per the research doc. happy-dom cannot reproduce gesture semantics, so
  the tests pin ordering and instance identity, not real audio. A real-device iOS Safari
  first-listen check stays a manual acceptance step for the close phase.
- `primeAudioContext` repeats the engine's five-line silent-buffer prime. This is not a
  sync contract: the two primings unlock different contexts at different moments (the island's
  inside the gesture, the engine's after adoption) and need not stay identical for correctness.
  Sharing it would require a new module, which T6's Files list excludes; jscpd reports no clone.
- The island never `close()`s its context. One context per page for the lifetime of the
  island, matching the engine's own singleton lifetime; closing it would break the engine's
  adopted reference.

## Confidence

**High** — the mechanism is a three-line engine change over a code path (`this.audioCtx ??=`)
that already funnels all playback, every criterion has a test that was watched fail first, and
the regression surface (chat) is provably untouched by diff, typecheck, and unmodified tests.
The residual risk is the un-device-tested iOS premise, which the design doc already flags.
