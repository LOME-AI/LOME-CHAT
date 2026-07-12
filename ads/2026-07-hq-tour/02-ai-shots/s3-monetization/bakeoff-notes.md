# S3 bake-off runs — 2026-07-11

Input still for all: `s3-still.png` (fal CDN copy of the approved corner office).

| File | Model | Endpoint | Prompt | Duration/Res | Cost | Notes |
|---|---|---|---|---|---|---|
| s3-bakeoff-veo31.mp4 | Veo 3.1 | fal-ai/veo3.1/image-to-video | OLD slow push-in, "near-silent" audio clause | 6s / 1080p | $2.40 | Pre-motion-redesign; audio track present but inaudible by prompt. NOT comparable to the other two — re-run on the arc prompt if it's a finalist. req 019f5406-fb15 |
| s3-bakeoff-kling3pro.mp4 | Kling 3.0 Pro | fal-ai/kling-video/v3/pro/image-to-video | Golden-arc + audible ambience | 5s / native | $0.70 | req 019f5424-67df |
| s3-bakeoff-seedance20.mp4 | Seedance 2.0 | bytedance/seedance-2.0/image-to-video | Golden-arc + "subtle background office ambience" clause | 5s / 1080p | ~$1.20–1.50 (unit pricing opaque — check fal dashboard) | seed 1414359978. req 019f5429-fad0 |

Judge on: faithfulness to the still through the arc · motion realism (no 2.5D,
no melting at the glass corner) · ambient audio usability · obedience (nothing
moves but the light).

Veo Fast: skipped by decision (2026-07-11).

**WINNER (2026-07-11): Seedance 2.0** — chosen by the founder after review;
production scenes S1/S2/S4/S5 animate on `bytedance/seedance-2.0/image-to-video`.
