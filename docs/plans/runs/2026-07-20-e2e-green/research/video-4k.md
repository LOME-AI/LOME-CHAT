# e2e-green — video-generation.spec.ts:373 "cost preview increases 1080p→4k" — root cause

## Verdict: NOT an app bug. INTENT CONFLICT (founder ruling).

The test is a deliberately-RED canary pinned to a model that does not offer 4K in
the live ZDR catalog. The app correctly hides the 4K tier; the test then fails
waiting for a 4K pill that (by design) never renders.

## Failure trace
- Spec: `e2e/chat/video-generation.spec.ts`
  - `:373` (JSDoc): "Runs RED until a 4k-capable video model is ZDR-exposed in the
    live catalog (veo-3.1-lite surfaces 720p/1080p, kling-video-o1 only 720p) —
    kept live rather than dark…". The author documents it fails on purpose.
  - `:387` pins `selectSingleModel('google/veo-3.1-lite')`.
  - `:400` `selectResolution('4k')` is where it dies.
- Helper: `e2e/pages/chat.page.ts:808-813` — `selectResolution('4k')` asserts the
  pill `getByRole('button',{name:'4k',exact:true})` is `toBeVisible()`; it never
  renders → assertion times out.

## Why the 4K pill never renders (app is correct)
- `apps/web/src/components/chat/media/modality-config-panel.tsx:157-168`
  `videoResolutionsFor()` intersects each selected model's live-catalog
  `supportedVideoResolutions` (fallback: `pricePerSecondByResolution` keys). Only
  resolutions the model actually prices are shown (`:214-249` VideoResolutionControl).
- `google/veo-3.1-lite` (default since Task-16) advertises only 720p/1080p, so 4K
  is filtered out. Product behaviour is correct: it must not offer a tier the
  backend would reject.
- Capability source `packages/shared/src/models/capabilities.ts` — `VEO_CAPABILITY`
  (`:42-63`) marks only `veo-3.1-generate-001` / `veo-3.1-fast-generate-001` as 4K
  (`resolutions: ['720p','1080p','4k']`). It has NO `veo-3.1-lite` entry at all;
  those two 4K models are not ZDR-exposed in the live catalog today.
- `google/veo-3.1-lite` appears only in tests, never in production source — confirming
  no live ZDR video model currently offers 4K.

## Classification
- Not (a) an app/product bug — the resolution gate works as intended.
- Not simply (b) a stale test — the author *intentionally* left it live as a
  "lights up when 4K appears" canary.
- Effectively (c): 4K is legitimately unsupported by every available ZDR video
  model right now, and this is a permanently-RED canary sitting inside a suite
  whose contract is "green ⇒ prod works".

## INTENT CONFLICT for founder ruling
Green-suite discipline (no permanently-red tests) vs. the author's canary intent.
Options:
  1. Gate it: `test.fixme`/tag so it doesn't block e2e-green but reactivates the
     day a 4K ZDR model lands (closest to author intent; recommended for unblocking).
  2. Accept 4K as unsupported and delete/dark the test.
  3. If 4K is a product goal, expose a 4K-capable ZDR video model (veo-3.1 /
     veo-3.1-fast) so the differential can actually be proven.
Do NOT silently "fix" by picking a resolution the model does price — that guts the
test's purpose (asserting a per-resolution cost differential).
