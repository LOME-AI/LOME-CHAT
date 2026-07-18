# Production Guide — "A Tour of HushBox HQ"

30-second vertical (9:16) brand film. An immaculate, empty corporate office tour:
every department that would exploit the user was never built. The tour ends at the
only thing that exists — the real app. Deadpan, defiant, every line a checkable fact.

**Phase order is generation-first:** all AI output (stills → video → voiceover)
is produced before anything else — it has the highest variance and drives every
retake loop. Screen capture, music, and the edit are deterministic and follow.

**Toolchain (one tool per step; the `create-ad` skill is canonical for process
and model choices — this guide records only what's specific to this ad):**
Nano Banana Pro stills (`fal-ai/nano-banana-pro` + `/edit`) · Seedance 2.0
video (`bytedance/seedance-2.0/image-to-video`) · MiniMax Speech 2.8 HD
(`fal-ai/minimax/speech-2.8-hd`, voiceover) · Playwright (UI capture + action
log) · Remotion (edit, composite, subtitles; approved dependency) · Sonilo
music (`sonilo/v1.1/text-to-music`) · ffmpeg (probing, encode variants).

**Budget:** fal.ai ~$10–15 actual usage (stills $0.15 each; Seedance ~$1–1.5
per 5s clip; the entire VO ≈ $0.10; music ≈ $0.08/take on Sonilo) · everything
else free/in-repo.

**Rules that govern every step:**

1. AI generates **textless environments only**. Every word on screen is added in
   the Remotion edit. AI-rendered text warps; overlaid text never does.
2. No people on screen, ever. It sidesteps AI uncanny-valley and it is thematically
   correct — nobody is watching.
3. Every take of everything is kept, filed, and named. Nothing is overwritten.
4. The anti-corny test: every line must be a plain statement of a checkable fact.
   If a line editorializes, it dies.

---

## Phase 0 — The locked copy deck

Overlay text and VO are the same words. VO delivery for every line: flat, dry,
unhurried, faintly amused. Like a museum guide who has given this tour a thousand
times and still finds one thing funny about it.

| # | Time | Scene | Line (overlay + VO) |
|---|------|-------|---------------------|
| 1 | 0:00–0:03 | The doors | "Welcome to HushBox. Let us show you around." |
| 2 | 0:03–0:08 | Ad targeting | "Ad targeting. — No one works here." |
| 3 | 0:08–0:13 | Data monetization | "Data monetization. — It's encrypted before it reaches us. There's nothing to monetize." |
| 4 | 0:13–0:18 | The unbuilt floor | "The floor for reading your messages. — Never built." |
| 5 | 0:18–0:26 | The only room | "We built one thing." *(then silence — the UI speaks)* |
| 6 | 0:26–0:30 | The receipt | "A hundred models. One cut of usage. That's the whole business." |

The em-dashes are beats: ~0.8s of silence. The beat is where the joke lives; do not
rush it.

Save the final approved deck as `01-brief/copy-deck.md` before generating anything.
Every downstream phase reads from it.

---

## Phase 1 — AI shots (fal.ai, image-first)

**The workflow is image-first:** lock each scene's composition as a cheap still
(cents, seconds), then pay video prices only for motion. Our shots are static
rooms with one slow camera move each — image-to-video's sweet spot — and stills
give a checkpoint to catch signage, warped geometry, and a non-blank phone
screen BEFORE video money is spent. It also makes coherence structural: every
scene still is derived from one master image of one building.

All endpoints below are fal.ai model pages with a no-code **Playground** tab:
open `fal.ai/models/<endpoint>`, paste the prompt, set the settings listed,
click Run. Download and file every result immediately — fal's history is not
our archive.

**Decided: the ad is five separately generated clips, stitched.** Not a
single-pass 30s oner — the comedy lives in the hard cuts, the copy deck needs
frame-exact scene timing, and the ad contains cuts regardless (full-frame UI at
0:20, receipt card at 0:26). The oner is an optional alternate cut after the
master ships (see 1f).

### 1a. The master still — one building, generated once

Model: **`fal-ai/nano-banana-pro`** (Google — ranked #1 for architectural
interiors; supports 9:16 and up to 4K).

1. Open `fal.ai/models/fal-ai/nano-banana-pro` → Playground.
2. Settings: `aspect_ratio: 9:16` · `resolution: 2K` · output format PNG.
3. Prompt (this is the establishing wide — S1's interior — and the DNA of the
   whole building):
   > Vast empty modern office floor seen straight-on from its entrance,
   > symmetrical one-point perspective down the central aisle, hushed blue-hour
   > light just before sunrise, floor-to-ceiling windows with low fog outside
   > and a faint city skyline, rows of pristine identical matte charcoal desks
   > with slim anonymous black flat-screen monitors powered off, dark
   > smoked-oak floor, frameless glass, deep muted near-monochrome palette with
   > a whisper of warm light at the horizon, quiet and still atmosphere,
   > photorealistic architectural photography, no people, no readable text, no
   > signage, no logos.
   (Approved master: `master-cand2.png` → `master-reference.png`.
   Material tokens for all downstream prompts: dark smoked-oak floor, matte
   charcoal desks, blue-hour light.)
4. Generate 6–10 variations (cents each). Save ALL to `02-ai-shots/master/`.
5. Pick the building — judge floor material, window wall, light temperature,
   desk design. The chosen file becomes
   `02-ai-shots/master/master-reference.png`. Every other image in this ad
   derives from it.

### 1b. The five scene stills — derived, not re-rolled

Model: **`fal-ai/nano-banana-pro/edit`** (same model, conversational editing —
feed it the master plus an instruction; it keeps the building).

For each scene: upload `master-reference.png` as the input image, same settings
as 1a, use the scene's still prompt below. Iterate until perfect — edits cost
cents. File as `02-ai-shots/s<N>-<slug>/s<N>-still.png` (keep rejected
iterations too: `s<N>-still-alt<M>.png`).

**Per-still acceptance checklist (all five, before any video money):**
- [ ] Same building — floor, glass, light all match the master
- [ ] Zero people, zero readable text, zero signage/logos anywhere
- [ ] Straight lines are straight (desk edges, window mullions, door frames)
- [ ] S5 only: the phone is notchless and the screen is a perfectly uniform
      chroma-key green — **no gradient, no icons, no reflections, and no green
      cast on the desk or room** (prompt the spill to stay neutral). If the
      model won't comply, run another edit pass or retouch in GIMP — the still
      is an environment plate, retouching is legal.

Still prompts (edit instructions against the master):

- **S1 — The doors:** "Show this same office from just outside its entrance:
  tall frameless glass doors standing open in the foreground, the dawn office
  floor visible through them."
- **S2 — Ad targeting:** "A closer view inside this same office: a single long
  row of identical empty desks receding to the side, ergonomic chairs neatly
  tucked, monitors off, cool neutral light."
- **S3 — Data monetization:** "A luxurious empty corner office in this same
  building: large bare executive desk, city skyline through the same
  floor-to-ceiling windows, a single healthy potted plant, desk phone with cord
  neatly wrapped, no computer, no papers, warm late-afternoon light."
- **S4 — The unbuilt floor:** "An unfinished floor of this same building: raw
  concrete columns and floor, hanging electrical cables, unglazed window
  openings with the same skyline beyond, faint construction dust in the air,
  dim ambient daylight, no equipment, no furniture." (This still is *supposed*
  to break the pristine look — the contrast is the joke; only the skyline and
  window rhythm need to match the master.)
- **S5 — The only room:** "A dark room in this same office at night: a
  smartphone propped upright on a small stand on a desk, its screen glowing
  softly as the only light source, the screen showing only a plain dim
  dark-gray surface with a faint even glow — no icons, no text, no interface,
  no wallpaper."

S5 screen decision (final): the phone screen is a **uniform chroma-key green**
on a notchless phone, with the prompt explicitly pinning the room's light spill
to stay neutral warm-gray (the model complies even though it's physically
inconsistent). The uniform green is what the Phase 5c tracker seeds on — a
flood-fill from a seed point keys the screen region per frame. Brightness of
the pasted dark-theme UI still needs matching against the plate's spill in the
edit.

### 1c. Video model & the S3 motion prompt

Video for this ad is **Seedance 2.0** (`bytedance/seedance-2.0/image-to-video`)
— the model choice lives in the `create-ad` skill. The
`02-ai-shots/s3-monetization/s3-bakeoff-*.mp4` files are retained comparison
artifacts from selecting it, not part of the live pipeline.

S3 is the most demanding shot (glass, skyline, warm light); its motion prompt,
reused when animating in 1d:

> Slow cinematic orbital arc around the bare desk, the low golden sun behind
> the corner glass raking across the lens as the angle changes, soft flare
> edges sweeping the desk surface, the plant's shadow wheeling slowly across
> the floor, nothing in the scene moves except the light. Audio: warm quiet
> room tone, faint city murmur through glass, no music, no voices.

**Audio-clause lesson:** "near-silent room tone" produces a technically-present
but inaudible track. Always prompt audible, specific ambience — the standard
clause is **"subtle background office ambience — soft HVAC, faint city murmur
through glass, no music, no voices"** — quiet but unmistakably present.

### 1d. Animate all five scenes

On the winning endpoint, per scene: upload `s<N>-still.png` as the image input ·
audio generation ON · 1080p · duration = nearest available option ≥ the scene's
target (trim down in the edit) · the scene's motion prompt below · 2–4 takes,
all kept as `02-ai-shots/s<N>-<slug>/s<N>-take<M>-<model>.mp4`.

A take that drifts from its still, warps geometry, or invents signage or people
is dead on arrival, no matter how pretty. Regenerate.

Motion system: every scene still travels forward or
along (cuts stitch mid-move into mid-move), but each owns one attention
device — ramp (S1), occlusion rhythm (S2), light rake (S3), near-field
pass-through (S4), settle (S5). Escalating intimacy, de-escalating speed: the
ad slows to a stop on the product. Fancier moves raise i2v difficulty (arcs
and near-lens occlusion are where models invent geometry) — that is what the
2–4 takes budget is for.

- **S1 — surge-and-settle (target 4s):** "Camera starts deep in the dark lobby
  and accelerates forward through the open glass doorway, the bright doorway
  swelling to fill the frame, dark doorframe edges wiping past the lens at the
  threshold, then decelerates into a calm steady glide inside the office as
  the room opens up. Audio: quiet lobby room tone swelling slightly as the
  camera crosses into the open floor, soft HVAC presence, no music, no
  voices." — If the model can't invent the deeper interior convincingly past
  the threshold, fall back to text-to-video for this one scene (Veo 3.1's
  text-to-video endpoint, 1a's master prompt plus this camera move); one t2v
  scene doesn't break coherence if the grade holds.
- **S2 — low track with foreground wipes (target 5s):** "Low lateral tracking
  shot at desk height moving along the row, close enough that desk edges and
  monitor backs sweep past as dark out-of-focus foreground shapes, strong
  parallax against the fog-wrapped windows; midway, one office chair slowly
  spins a few degrees as if just vacated; nothing else moves. Audio: present
  office room tone, low HVAC rumble, a single soft chair creak, no music, no
  voices." — The chair is the eccentric detail; if it won't cooperate in 3
  takes, drop it — the empty row carries the line alone.
- **S3 — the golden arc (target 5s):** the S3 motion prompt from 1c; that
  take may already be the keeper.
- **S4 — through the cables (target 3s):** "Camera dollies forward toward the
  fog-wrapped windows with hanging cable bundles passing close to the lens as
  dark near-field silhouettes, dust motes drifting through the flat gray
  light, one distant cable swaying slightly. Audio: hollow concrete
  reverberance, a single distant cable tap, muffled deep-building quiet, no
  music, no voices." (The approved still kept the windows glazed — sealed
  interior tone, no wind.)
- **S5 — the settle (target 3–4s):** "Camera starts slightly high and
  off-axis, then drifts down and squares up to a dead-frontal framing as it
  slowly closes on the phone, settling completely still; the phone screen
  stays a perfectly flat uniform green throughout; the dark background desks
  gently defocus as the phone fills the frame. Audio: near-field quiet, a
  faint electrical hum, the building's air handling barely audible, no music,
  no voices." — Reject any take where the green gains gradients, icons, or
  reflections mid-move, where green light bleeds onto the desk, or where the
  final framing isn't flat-on and still; it is the compositing surface and the
  demo handoff.

### 1e. Coherence & transitions

Image-first already does the heavy lifting: one master → five derived stills →
one video model. Two residual levers:

1. **Frozen wording.** If you edit any prompt, keep described materials
   identical (same pale wood floor, same frameless glass) — never paraphrase.
2. **One color grade in post.** A single grade/LUT across the whole Remotion
   timeline flattens whatever drift the pipeline lets through.

**Transitions:** hard cuts only, carried by two continuities — the
level-matched room tone (Phase 5b) and **motion direction**: every scene is a
slow forward or lateral glide, so cut mid-move into mid-move and the tour feels
like one continuous drift through the building. No dissolves, no wipes —
softness reads corporate; the hard cut is the deadpan.

### 1f. Optional, after the master ships — the oner alternate cut

Seedance 2.5's native 30s single pass could attempt the whole tour as one
unbroken steadicam move — but **2.5 is not on fal.ai yet** (only Seedance 2.0
is live there, and it caps well short of 30s). Revisit only if 2.5 lands on fal
after the stitched master is exported: 1–2 attempts, feeding the five scene
stills as reference inputs, purely as a second, moodier edit for A/B testing.
Nothing about the flagship waits on this.

---

## Phase 2 — Voiceover (MiniMax Speech 2.8 HD on fal)

Same MCP, approval flow, and archive discipline as video. Pin the exact
endpoint ID with `search_models` + `get_model_schema` on first use. The full
VO is ~1,000 characters ≈ a dime.

1. Pick a voice: mid-register, dry, zero announcer energy. The reference
   is a documentary narrator who is slightly bored, not a movie trailer.
2. Generate each line from the copy deck **separately** (per-line files give the
   edit full control of the beats): `04-voiceover/line<N>-take<M>.flac`.
3. Direction per line: flat pitch, no smile in the voice except line 2's second
   half ("No one works here") which may carry the faintest amusement.
4. Export WAV, 48 kHz. Generate 3+ takes per line; pick in the edit, not here.
   Measure durations with ffprobe; a line longer than its scene slot is
   regenerated, never squeezed.

Line 5 ("We built one thing.") is the last spoken words — lines land, then the UI
demo runs silent over ambient. Line 6 returns over the receipt card.

---

## Phase 3 — Screen capture (the real app, Scene 5 — Playwright)

Captured by a **Playwright script** (in-repo): drives the app by test-id with
smooth interpolated mouse moves, records video natively, and logs every action
as `{t, x, y, action}` JSON — that ground truth drives the zoom/pan effects in
the Remotion edit (no screen-recorder app involved).

**Setup — capture the app phone-shaped**, because the ad is 9:16 and the AI shot
it composites into is a phone on a desk:

1. `pnpm dev`, open the app in Chrome.
2. DevTools → device toolbar → 390×844 viewport, DPR 3 (crisp pixels).
3. Dark theme. Seed a conversation with **written-for-the-ad content** — no real
   personal chats, nothing you wouldn't put on a billboard. Good seed prompt: a
   question a person would only ask somewhere private (keep it tasteful; it flashes
   by).
4. Hide bookmarks bar, notifications off, clean cursor.

**The demo beats — one continuous ~10s take** (record long, trim in edit):

1. Conversation open, a reply already on screen. (1s hold)
2. Open the model dropdown. (auto-zoom lands here)
3. Switch to a different model **mid-conversation**.
4. New reply streams in.
5. End on a frame where the encryption state and real cost are both visible. (1s hold)

Record 5+ takes. Cursor speed is the whole game: slow, deliberate, no hesitation.
File as `03-screen-capture/demo-take<N>.webm`. Pick the take where the dropdown
click, the stream-in, and the final hold all feel unhurried.

Also record a 5s **static** take (no cursor movement, reply streaming) as a safety
for the composite — tracking a moving cursor inside a corner-pinned screen is
harder to sell.

---

## Phase 4 — Music & sound

- **Ambient/SFX:** already inside the AI takes (that's why the audio clauses).
  Keep them as the bed.
- **Music:** ONE element only — a slow felt-piano note or low synth pulse every
  ~2s. Enters at S1, swells slightly into the S5 push-in, **hard cuts to silence**
  on the receipt card. The silence is the punchline's frame.
- Source: **Sonilo v1.1** (`sonilo/v1.1/text-to-music`, fal MCP) — licensed,
  commercial-use-safe output at exact duration. Generate per the skill's
  approval/cost/archive discipline; file takes under `06-music/`.

Mix targets (set in Remotion): VO −14 LUFS-ish dominant · ambient bed low
(−30 dB-ish under VO) · music one notch above ambient. When in doubt, quieter —
the ad's register is quiet confidence.

---

## Phase 5 — The edit (Remotion)

A Remotion project in `07-project/` (scaffold on first edit session; new
packages: `remotion`, `@remotion/cli`, Zod props helpers). The composition is
driven entirely by data: the copy-deck timing JSON places cuts, overlays
(which ARE the subtitles), VO starts, and the receipt card; the Playwright
action JSON drives zoom/pan on the UI capture; brand type/tokens import from
`packages/ui`. Hook variants and aspect crops are props/render configs.
The sections below record the editorial intent and compositing principles —
implement them as composition layers, not timeline tracks.

### 5a. Project

- Composition: **1080×1920, 30fps**. Seedance 2.0 outputs 1080×1920 natively,
  so there's no 4K headroom — crop the 1:1/16:9 variants from the 1080 master.
- Layer order (top→bottom): text/overlays · UI capture (composite) · AI
  shots; audio: VO · native ambient (from the AI clips) · music.

### 5b. Assembly

Sequence the picked takes in scene order against the timing map (Phase 0 table).
Trim each AI shot to its slot; simple cuts between scenes — the room-tone
continuity does the joining, no transition effects anywhere. Ungroup audio from
the AI clips onto A2 and level-match them so the room tone doesn't jump between
scenes.

### 5c. The screen replace (S5 → real UI)

1. AI phone shot as the base layer, chosen UI capture (the **static** safety
   take) as the composite layer.
2. **Track the green screen offline, then pin the UI in.** A precompute step
   (`tools/remotion/generate-track.ts`) seeds a flood-fill on the screen's
   green, keys the connected region per frame within a colour tolerance, and
   writes a smoothed per-frame rectangle track to `05-props/s5.track.json`.
   No per-pixel keying at render time and no hand-keyframing.
3. At render, map the UI capture into the tracked rectangle per frame
   (`tools/remotion/screen-replace.tsx` reads the track; position/scale come
   from each frame's rect).
4. Make the paste sit *in* the phone, not on it — three cheap tricks:
   - **Overshoot the pin** by 1–2% so the capture's edges tuck under the phone's
     bezel; no AI screen peeks out at the borders.
   - **Round the corners**: apply an alpha/rounded-corner mask to the capture layer so
     its corners match the phone screen's — a sharp-cornered rectangle inside a
     round-cornered phone is the tell that breaks the illusion.
   - Add a slight **Gaussian blur** (0.5–1px) and lower **brightness** a touch on
     the capture layer for the first half, animating both back to zero as the screen grows —
     the UI sharpens as you arrive at it. Optionally lay a very faint white
     diagonal gradient at low opacity over the pinned capture to fake the glass
     reflection the real screen would have.

   Leave the AI shot's own glow-spill on the desk untouched — it's outside the
   screen rectangle, and that spill is what makes the composite believable.
5. When the pinned screen reaches ~90% of frame width: hard cut to the full-frame
   UI capture (the cursor take, full resolution). The push-in's motion carries the
   viewer across the cut — this is the seamless part.
6. Run the full-frame demo ~6s: dropdown → model switch → stream-in → hold on
   encryption + cost.

### 5d. Text overlays & captions

- Text components on the overlay layer, brand typeface, white, small, lower-third area; sizes and
  face per `docs/DESIGN.md`.
- Fade in 6 frames, hold per copy-deck timing, fade out 6 frames. No motion
  beyond opacity. The type never animates — stillness is the voice.
- HushBox logomark: small, a corner, **from frame one** (opening-frame logo lifts
  ad performance ~69%).
- Captions of the VO are the overlays themselves (same words by design) — no
  second caption layer needed. Muted-feed viewers lose nothing.

### 5e. The receipt card (S6)

Full-frame flat brand-color card, built as a title clip: three lines set like an
invoice line item —

> A hundred models. One interface.
> Encrypted before we could ever read it.
> We take a cut of usage. That's the whole business.

Logo + App Store / Play badges below. One 6-frame fade in. Music hard-cuts to
silence at this cut; VO line 6 reads over the silence. No CTA button, no
"download now" — the refusal to ask is the personality.

---

## Phase 6 — Export, variants, QA

### Export

Remotion render: MP4 (H.264 + AAC), 1080×1920, 30fps, high bitrate
(~16–20 Mbps), to `08-exports/hq-tour-9x16-master.mp4`.

### Variants (ffmpeg, from the master)

```bash
# 1:1 feed variant (center crop)
ffmpeg -i hq-tour-9x16-master.mp4 -vf "crop=1080:1080" -c:a copy hq-tour-1x1.mp4
# 16:9 (pillarboxed on brand-color background — build properly in Remotion if this looks cheap)
ffmpeg -i hq-tour-9x16-master.mp4 -vf "pad=1920:1080:(ow-iw)/2:0:color=#0d0d0f" -c:a copy hq-tour-16x9.mp4
```

Check the 1:1 crop scene by scene — if an overlay or the phone falls outside the
square, re-render that variant from Remotion with nudged positions instead.

### QA checklist — every box, before anything ships

- [ ] Watch **muted**: every beat lands from text alone
- [ ] Watch **audio only**: the tour still makes sense
- [ ] Freeze-frame every AI shot: no ghost people, no warped text, no hallucinated
      signage anywhere
- [ ] The UI shown is the real app, current build, nothing mocked
- [ ] Every line passes the checkable-fact test (encrypted client-side; no data
      monetization; usage-cut business model — all per `docs/PRODUCT.md`)
- [ ] S4 reads as the same building unfinished (skyline/window rhythm match)
- [ ] Logo visible from frame one
- [ ] Phone/1:1/16:9 variants each checked full-screen on an actual phone
- [ ] Nothing in the ad asks, hypes, or pleads

---

## Phase 7 — Hook variants (for paid testing, later)

Keep one body, swap only S1's overlay/VO. Ready alternates:

1. "Welcome to HushBox. Let us show you around." *(master)*
2. "This is a tour of the departments we refused to build."
3. "Our headquarters. Notice anything missing?"

File as separate exports: `08-exports/hq-tour-9x16-hook<N>.mp4`.

---

## Folder map (recap)

```
01-brief/           copy-deck.md, this guide's approvals
02-ai-shots/        master/ (all candidates + master-reference.png) ·
                    s<N>-<slug>/: s<N>-still.png (+ -alt<M> rejects) and
                    s<N>-take<M>-<model>.mp4 — every take, forever
03-screen-capture/  demo-take<N>.webm + the static safety take (.webm)
04-voiceover/       line<N>-take<M>.flac + final picks
05-props/           generated assets (s5.track.json — the S5 screen track)
06-music/           Sonilo bed takes (bed-<model>-take<M>.<ext>)
07-project/         Remotion project (composition, timing JSON, render configs)
08-exports/         masters + variants + hook alternates
```
