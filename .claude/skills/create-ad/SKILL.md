---
name: create-ad
description: Create a HushBox video ad end-to-end through Claude Code — concept planning with the human, AI media generation via the fal MCP, voiceover, UI capture, programmatic edit, and export. Use when the user wants to create, plan, or iterate on a video ad, promo clip, or App Store preview. Trigger on "make an ad", "new ad", "ad campaign", "promo video", "video ad".
---

# Create a HushBox Ad

Everything runs through Claude Code; the human approves, Claude executes. No
manual tooling is required of the human beyond watching clips and deciding.

## Toolchain — one tool per step, no branching

| Step | The tool | Nothing else |
|---|---|---|
| Planning artifacts | Markdown in the ad folder (copy deck is the source of truth) | |
| Stills | `fal-ai/nano-banana-pro` (+ `/edit` for derivation) via fal MCP | |
| Video | `bytedance/seedance-2.0/image-to-video` via fal MCP | re-bake-off only when starting a NEW ad |
| Voiceover | **MiniMax Speech 2.8 HD on fal** (`fal-ai/minimax/speech-2.8-hd`, $0.10/1K chars; FLAC out — no WAV offered; API returns `duration_ms` for fit checks) | newest HD tier at last check — re-run `search_models` each ad; the catalog moves monthly |
| UI capture | **Playwright** (in-repo) — drives the app by test-id, records video, logs `{t,x,y,action}` JSON | harness in `ads/tools/capture/`, per-ad script in the ad's `03-screen-capture/` |
| Edit / composite / subtitles | **Remotion** (approved dependency) | |
| Music | **Artlist** (~$15/mo, cancel after) — airtight sync license for paid placements | |
| Encode / variants / probing | **ffmpeg** (system package) | |

Dependencies beyond the repo's existing stack: the Remotion packages
(`remotion`, `@remotion/cli`, zod props helpers) in the ad's project
workspace, and system `ffmpeg`. That is the complete list — everything else
(Playwright, node, Zod, brand tokens) is already in the monorepo.

## Iron rules (non-negotiable, learned the hard way)

1. **No generation without approval. One generation at a time.** Present each
   result, wait for approve/edit, then proceed. The human pre-approving a
   short sequence ("fix X then make Y") is fine; batch-generating five scenes
   is not.
2. **Report the cost after every generation** and keep a running total. Call
   `mcp__fal-ai__get_pricing` AND `mcp__fal-ai__get_model_schema` before the
   first use of any endpoint — never guess parameters or prices.
3. **Every take is archived immediately** to the ad's folder (fal's CDN history
   is not our archive). Naming: `s<N>-still.png`, `s<N>-still-alt<M>-<why>.png`,
   `s<N>-take<M>-<model>.mp4`. Download binaries with a node `fetch` script —
   shell redirection mangles binary through this harness.
4. **AI generates textless environments only.** Every on-screen word is added
   in the edit. No people on screen, ever (uncanny-valley + privacy thematics).
5. **The anti-corny gate:** every line of copy is a plain statement of a
   checkable fact. If a line editorializes, hypes, or pleads, it dies. Punch
   at the surveillance economy, never sideways; deadpan, never tantrum
   ("cope"-style lines are out).
6. Each ad gets `ads/YYYY-MM-<slug>/` with the standard numbered subfolders
   and its own `PRODUCTION-GUIDE.md` (see `ads/README.md` and the 2026-07
   hq-tour ad as the reference implementation).

## Brand mood (standing style, from the founder)

- **Competent but free**: seems like we don't care to impress; never sells,
  never asks. No CTA buttons, no "download now", no urgency.
- Deadpan defiant: dry statements, beats of silence where the joke lands.
  Hard cuts, never dissolves — softness reads corporate.
- Visual register: dark, hushed, near-monochrome, blue-hour; the app's dark
  theme made physical. One warm scene maximum, used as meaning, not variety.
- Anti-monotony rule: consecutive scenes must differ on ≥2 of {shot size,
  light temperature, dominant prop}. Repetition is the joke's skeleton;
  monotony is its failure mode.
- Motion system: slow premium moves, one attention device per scene (speed
  ramp, foreground occlusion, moving light, near-field pass-through, settle).
  Escalating intimacy, de-escalating speed — end still, on the product.
- Silence is punctuation: music is ONE sparse element that hard-cuts to
  silence at the payoff; the demo runs with no voiceover.

## Process (phases in execution order)

### 1. Plan iteratively with the human
Concept → scene list → locked copy deck (`01-brief/copy-deck.md`), all
approved before any spend. The copy deck is the single source of truth for
VO, subtitles/overlays, and scene timing. Research competitors/reference ads
if the concept is new. Write the ad's `PRODUCTION-GUIDE.md` before generating.

### 2. Generate media, image-first (fal MCP)
Stills are cents; video is dollars. Lock composition cheap, pay for motion
once:
1. **Master still** — one establishing image; it is the building/world DNA.
   Generate candidates one at a time until approved.
2. **Scene stills derived from the master** via the image model's edit
   endpoint (consistency by construction). Lessons: edit models are
   conservative — force camera repositioning explicitly ("move the camera
   three meters back; the frame edges are now X") or you get the same image
   with props pasted on. Per-still acceptance: no text/signage/people,
   straight geometry, same building.
3. **Compositing surfaces are chroma green**: any screen that will hold real
   UI is a uniform saturated green on a notchless device, with the prompt
   pinning the room's light spill to stay neutral (the model complies).
4. **Bake-off before committing**: animate the hardest still on 2–3 video
   models, same prompt; judge faithfulness, motion realism, ambient audio,
   obedience-per-dollar. Winner does all scenes — no model mixing.
5. **Audio clause standard**: "subtle background office ambience — soft HVAC,
   faint city murmur, no music, no voices." Never "near-silent" (produces an
   inaudible track). We keep native ambience as the mix bed.

### 3. Voiceover
MiniMax Speech 2.8 HD on fal (`fal-ai/minimax/speech-2.8-hd`) — same MCP, same approval flow, same archive
discipline as video. Per-line FLAC 44.1kHz (the API offers mp3/pcm/flac, no
WAV), 3+ takes each; the API's `duration_ms` drives fit checks — assert ≤ the
scene slot, never squeeze. Delivery: flat, dry, faintly amused museum guide.
Casting lessons: stock voice quality varies wildly and is unranked anywhere —
`Patient_Man` is high quality but cannot read fast enough for short slots;
when no stock voice fits the register, design one with
`fal-ai/minimax/voice-design` from the character description. Native pause
markers `<#x#>` exist — use them ONLY for beats the copy deck scripts.

### 4. UI capture (the real app — authenticity layer)
The product surface shown must be the real app; nothing AI-generated ever
stands in for UI. Drive it with **Playwright** (in-repo, test-ids) in a
phone-shaped viewport (390×844 @ 3× DPR), smooth interpolated mouse moves,
and log every action as `{t, x, y, action}` JSON — that ground truth drives
the zoom/pan effects in the edit (this replaces Screen Studio, which is
macOS-only). Playwright's recording does NOT include an OS cursor — the
cursor is drawn in the edit as a brand-styled sprite following the action
log; that is a feature (perfectly smooth, scales on click), not a gap.
Demo content is written-for-the-ad, never real conversations.

**Where the code lives:** `ads/` is the `@hushbox/ads` workspace package
(lint + typecheck gates, deliberately no test/coverage gate — media tooling).
Reusable tooling in `ads/tools/`: `capture/` (SmoothMouse, ActionLogger,
phone-viewport session), `media/` (binary-safe downloads, take naming),
`audio/` (WAV duration, the Zod timing-map schema + VO fit validation),
`remotion/` (CursorSprite, ZoomFollow, SubtitleLine, ReceiptCard,
GreenScreenVideo/keyOutGreen). Per-ad code stays thin: a demo-beat
`capture.ts` in the ad's `03-screen-capture/` and compositions + timing JSON
in its `07-project/`. Media binaries are Git-LFS-tracked via `.gitattributes`
(`git lfs install` once per clone before committing media).

### 5. Edit (Remotion — the tool)
One composition, driven entirely by data: the copy-deck/timing JSON places
cuts, overlays (which ARE the subtitles — same words as VO by design), VO
starts, and the receipt card. Green screens are chroma-keyed per-pixel (no
manual tracking even under camera motion). Zooms/pans on the UI capture come
from the Playwright action JSON. Brand type/tokens come from `packages/ui` —
the ad is rendered by the same engine as the product. Hook variants and
aspect crops are props/render configs, not re-edits; final encode and crops
go through ffmpeg. Music: one sparse Artlist element, hard-cut to silence at
the payoff.

### 6. QA + export
The ad's PRODUCTION-GUIDE QA checklist gates shipping: watch muted, watch
audio-only, freeze-frame every AI shot for artifacts/text/people, verify the
UI is the real current build, checkable-fact pass on every line, variants
checked on a real phone.

## Current preferred fal.ai models (re-verify pricing and catalog on first use each ad)

| Role | Endpoint | Notes |
|---|---|---|
| Stills | `fal-ai/nano-banana-pro` ($0.15/img) | #1 for architectural interiors; 9:16, up to 4K |
| Still edits/derivation | `fal-ai/nano-banana-pro/edit` ($0.15/img) | Keeps the building; force camera moves explicitly |
| Video (production) | `bytedance/seedance-2.0/image-to-video` (~$1.2–1.5 per 5s 1080p; unit pricing opaque — check dashboard) | reigning bake-off winner |
| Video (contender) | `fal-ai/kling-video/v3/pro/image-to-video` ($0.14/s) | Cheapest strong option; re-bake-off per ad |
| Video (premium) | `fal-ai/veo3.1/image-to-video` ($0.40/s) | Best single-shot realism; 4s/6s/8s only |
| Voiceover | `fal-ai/minimax/speech-2.8-hd` ($0.10/1K chars) | The tool — voice cast per ad via `fal-ai/minimax/voice-design` when stock voices miss the register |

Seedance 2.5 (native 30s single-pass) is not on fal yet — the one-cut version
of an ad becomes possible when it lands, but stitched-with-hard-cuts is the
house style for comedic timing regardless.

## Maintenance

This skill records the current refined process. When the process, preferred
models, pricing, or tooling change during ad production, **update this skill
in the same session** — a stale skill is a wrong comment at file scale.
