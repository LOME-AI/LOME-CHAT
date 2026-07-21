# impl-report-1 — Task-25: 4k-video canary → green cost-differential test

## Objective

Turn the deliberately-RED 4K canary (video-generation.spec.ts:373 "cost preview
increases 1080p→4k") into a green, meaningful test that still proves cost scales with
resolution, per founder standing ruling "nothing may be intentionally red". No 4K tier
is offered by any live ZDR video model (app correctly filters it), so the assertion is
re-pointed to the two resolutions veo-3.1-lite actually offers: 720p → 1080p. Remove the
RED-canary JSDoc marker. No app code (app behavior is correct).

## Files changed

- `e2e/chat/video-generation.spec.ts` — rewrote the C17 test (only lines 364-407,
  confirmed by `git diff` hunks `@@ -364,18 +364,15 @@` and `@@ -393,11 +390,11 @@`):
  - Test title `…switching from 1080p to 4k…` → `…switching from 720p to 1080p…`.
  - `selectResolution('1080p')` (lower) then `selectResolution('4k')` (higher) →
    `selectResolution('720p')` (lower) then `selectResolution('1080p')` (higher).
  - Differential assertion unchanged in spirit: capture cost preview at the lower
    resolution, switch to the higher, wait for the preview text to change
    (`not.toHaveText`), assert `higherCents > lowerCents`. It still FAILS if the preview
    does not change between the two resolutions (not neutered).
  - JSDoc rewritten: removed the "Runs RED until a 4k-capable video model is
    ZDR-exposed…" canary comment and the "kept live rather than dark" marker. New JSDoc
    states the preview formula basis (`pricePerSecondByResolution[resolution] × duration`
    from use-prompt-budget.ts) and that veo-3.1-lite's ZDR entry surfaces 720p and 1080p.

- `e2e/pages/chat.page.ts` — NOT changed. `selectResolution` is already parameterized
  (`resolution: '720p' | '1080p' | '4k'`); it does not hardcode '4k'. The '4k' union
  member is left intact (harmless; a valid pill string for the day a 4k ZDR model lands).
  Minimal-change / surgical rule → no edit.

## Tests added

None new. Task rewrites one existing e2e test (the test IS the artifact). There is no
closer unit layer for a Playwright spec; per plan §Global-Constraints e2e proofs are
centralized and the orchestrator runs the consolidated suite. Local verification is
logic-correctness against the app's cost-preview behavior + e2e lint/typecheck (below).

## Self-gate

- `npx eslint chat/video-generation.spec.ts` (from e2e dir) — pass — exit 0.
- `pnpm typecheck` (from e2e dir, `tsgo --noEmit`) — pass — exit 0.
- `npx jscpd e2e/chat/video-generation.spec.ts` — exit 1, 2 clones. Both clones are
  between the two request-payload tests (lines 255-260 vs 308-313) — PRE-EXISTING and
  entirely outside my edited block (364-407; git-diff-confirmed). Bare single-file jscpd
  uses defaults, not the repo `lint:duplication` config/ignores. My change introduced no
  new duplication. Not fixing pre-existing dup (surgical-changes rule).

## Acceptance criteria

1. Rewrite to per-resolution cost differential between two resolutions the default
   (veo-3.1-lite) actually offers — MET. 720p vs 1080p, strict-increase assertion
   preserved; RED-canary JSDoc + title marker removed.
2. Must still FAIL if preview does not change / not neutered — MET. Retains
   `not.toHaveText(lower)` change-gate + `higherCents > lowerCents`. If 720p and 1080p
   were priced equally the preview text never changes and both the change-gate and the
   `>` assertion fail.
3. Verify logic locally against app cost-preview behavior without e2e — MET.
   Preview = `pricePerSecondByResolution[videoResolution] × durationSeconds`
   (use-prompt-budget.ts:167-181, buildMediaPriceArrays) and re-renders on
   `videoConfig.resolution` change (modality-config-panel VideoResolutionControl). So a
   catalog that prices 1080p/sec above 720p/sec yields a strictly higher preview at fixed
   6s duration. Logically correct.
4. e2e eslint + typecheck pass — MET (above).
5. Full e2e run deferred to orchestrator (centralized proof) — not run here.

## Deviations

None from the brief. Did not touch chat.page.ts because it does not hardcode '4k'
(the brief made that edit conditional on a hardcoded '4k').

## Concerns and limitations

- **Load-bearing pricing-equality risk (RAISED).** The rewritten differential is green
  ONLY IF the live OpenRouter catalog prices veo-3.1-lite's 1080p/sec strictly above its
  720p/sec. I could not verify this from the repo: the E2E video catalog is live-fetched
  from OpenRouter at `e2e:prepare` (`catalog:refresh --require-e2e-models`); there is no
  pinned/recorded veo pricing in-repo to inspect. Two in-repo sources assert the OPPOSITE
  — that available video models (incl. veo-3.1-lite) may price 720p and 1080p the SAME,
  which is exactly why the original author used 4K:
  - original C17 JSDoc: "some video models price 720p and 1080p the same (real provider
    pricing — not a mock bug), so a per-resolution differential only shows up against
    models that surface 4k";
  - research/video-4k.md:369-371 restates the same.
  The founder standing ruling (2026-07-20) directs the 720p/1080p differential and states
  veo-3.1-lite "actually offers" it — an authoritative dated real-API fact that overrides
  the older author note. I implemented per the ruling. If the orchestrator's central e2e
  run shows this test red because the live catalog prices 720p == 1080p for veo-3.1-lite,
  that is NOT a code defect in this task — it is the pricing-equality condition; escalate
  to founder (options: pin/inject a synthetic veo catalog row with distinct per-res
  pricing, or assert against a model/tier that genuinely differs). Flagging because its
  blast radius (a still-red test) exceeds my local verification ability.
- `pricePerSecondByResolution` fallback to `?? 0` (use-prompt-budget.ts:177) means a
  missing resolution price would render `$0.000` for that tier — the change-gate would
  still fire (0 vs non-zero) so this does not mask the assertion, but it is why the test
  pins the concrete model with `selectSingleModel`.

## Confidence

medium — the rewrite is logically correct against the app's cost-preview code and passes
lint+typecheck, but final green/red depends on live veo-3.1-lite per-resolution pricing I
could not verify in-repo, and two in-repo notes suggest 720p/1080p may be equally priced.
Founder ruling is authoritative and I followed it; risk raised for the central e2e run.
