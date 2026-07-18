# HushBox Ads

Media + tooling workspace for ad production (`@hushbox/ads` package: lint,
typecheck, and test/coverage gates). Everything produced for an ad — briefs,
generated shots, captures, voiceover, project files, exports — lives here,
alongside the reusable production tooling in `tools/` (capture harness, media
download, timing-map validation, Remotion components). Media binaries are
Git-LFS-tracked; run `git lfs install` once before committing. The full
process is documented in the `create-ad` skill.

The `tools/` toolkit is the shared, tested code an ad compiles from; an ad
folder holds assets and data, not logic. Pure tool logic is unit-tested to the
repo's 95% per-file bar — `vitest.config.ts` lists each gated module. The
Playwright capture driver, the ffmpeg encode, and the Remotion `*.tsx`
components are verified by live capture / render rather than coverage, so they
stay out of the gate; when one grows real logic, that logic moves into a gated
pure module.

## Convention

One folder per ad: `YYYY-MM-<slug>/`

```
01-brief/           concept, script, overlay copy deck, VO script
02-ai-shots/        master/ reference still + one subfolder per scene
                    (scene still + all video takes kept)
03-screen-capture/  real app UI captures (Playwright script + action logs)
04-voiceover/       VO takes + final
05-props/           props / one-off generated assets
06-music/           licensed tracks + sound design
07-project/         Remotion project (composition, timing JSON, render configs)
08-exports/         final masters: 9x16 first, then 1x1 / 16x9 crops
```

Name takes `s<scene>-take<N>-<model>.mp4` (e.g. `s3-take2-veo31.mp4`) so the
model that produced each shot is never lost.

## Ads

- `2026-07-hq-tour/` — "A Tour of HushBox HQ": empty-office tour of the
  departments that were never built; ends in the real app UI. 30s, 9:16,
  defiant-deadpan, all overlay text added in post (never AI-generated).
