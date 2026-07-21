# video-resolution-pricing — veo-3.1-lite 720p vs 1080p per-second (Task-25)

## VERDICT: YES — 1080p is priced strictly HIGHER than 720p. Task-25's 720p→1080p differential works against the live E2E catalog.

## Cost-preview trace
- Preview formula: `pricePerSecondByResolution[videoResolution] × duration`, arrays built in
  `apps/web/src/hooks/billing/use-prompt-budget.ts:167-181` (`buildMediaPriceArrays`,
  `pricesPerVideoSecond = findModel(id).pricePerSecondByResolution[videoResolution] ?? 0`).
  Re-renders on `videoConfig.resolution` change (modality-config-panel VideoResolutionControl).
- Descriptor pricing built by the video normalizer
  `apps/api/src/slices/models/domain/normalize.ts` → `pricing.perSecondByResolution`
  (`interpretVideoSkus` / `pickResolutionRate`, precedence: res+audio → res → flat+audio → flat).

## Live OpenRouter SKUs for google/veo-3.1-lite (fetched 2026-07-20, /videos/models)
- `duration_seconds_with_audio`        = 0.08  (flat, audio)
- `duration_seconds_without_audio`     = 0.05  (flat, bare)    — SKIPPED (`videoSkuMarker` drops any `_without_audio` key)
- `duration_seconds_with_audio_720p`   = 0.05  (720p, audio)
- `duration_seconds_without_audio_720p`= 0.03  (720p, bare)    — SKIPPED (`_without_audio`)
- supported_resolutions: 720p, 1080p

## Normalizer result (only the with_audio SKUs survive; without_audio ones are dropped)
- 720p  → resAudio['720p'] = 0.05
- 1080p → no direct rate → falls through to `flatAudio` (0.08); NOT flagged as a substitution fallback
  because flatAudio is defined.
- perSecondByResolution = { "720p": 0.05, "1080p": 0.08 }  (in nano-USD)

## Consequence
At any fixed duration, preview(1080p)=0.08×d > preview(720p)=0.05×d. The change-gate
(`not.toHaveText`) fires and `higherCents > lowerCents` holds. GREEN.

## Refutes the original author note
The C17 JSDoc / video-4k.md:369-371 claim that "available video models may price 720p==1080p" is
FALSE for veo-3.1-lite specifically: its live SKUs give 720p (0.05) distinct from 1080p (0.08 via
flat fallback). The founder's 2026-07-20 ruling is consistent with live data. No synthetic model needed.
