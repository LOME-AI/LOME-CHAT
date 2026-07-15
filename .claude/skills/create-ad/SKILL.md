---
name: create-ad
description: Create a HushBox video ad end-to-end through Claude Code — concept planning with the human, AI media generation via the fal MCP, voiceover, UI capture, programmatic edit, and export. Use when the user wants to create, plan, or iterate on a video ad, promo clip, or App Store preview. Trigger on "make an ad", "new ad", "ad campaign", "promo video", "video ad".
argument-hint: [optional additional instructions — concept, platform, scene idea, constraints, phase to start from]
---

# Create a HushBox Ad

Everything runs through Claude Code; the human approves, Claude executes. No
manual tooling is required of the human beyond watching clips and deciding.

This skill has two halves: **the strategy system** (what makes a HushBox ad
work — derived from a nine-stream research sweep of advertising history,
effectiveness science, and privacy-brand case law, curated with the founder
2026-07) and **the production process** (how to physically make it). Write
the script with the first half; build it with the second.

## Additional instructions (optional)

The skill may be invoked with additional instructions appended (e.g. the
concept, a target platform, a scene idea, constraints, or which phase to start
from). When present, treat them as inputs to Phase 1 planning: fold them into
the concept and copy deck, and surface any conflict with the iron rules or
the doctrine before spending. When absent, run the full process from the
start. Additional instructions never override the iron rules or the approval
gate.

---

# Part I — The strategy system

## Why the strategy is shaped this way (the two economic facts)

1. **Extra share of voice pays a challenger ~3× less than a leader** (~0.4%
   vs ~1.4% share growth per 10 points; Binet & Field, IPA data). We cannot
   buy reach, so memorability and earned attention are the only affordable
   growth lever. Every ad must be worth re-sharing on its own.
2. **Our register forfeits documented attention drivers** (full-face gaze, a
   hard next-step). That's a chosen handicap, not a free aesthetic — every
   script must actively compensate with sense of place, implied story, dark
   humor, sound design, and the distinctive assets, with the brand
   identifiable inside the first ~2 seconds.

And one survival rule above all creative concerns: **every anti-surveillance
brand that overclaimed got punished out of proportion** (Proton's "no IP
logs", DuckDuckGo's Microsoft carve-out, Mozilla's ad-tech pivot). The
checkable-fact discipline is not taste; it is the survival condition of the
position.

## Audience & objective

- **Wedge → mainstream.** Privacy-technical early adopters are the entry
  wedge; the real market is the mainstream viewer casually uneasy about AI.
  Every ad must be legible to the mainstream; the wedge is won by substance,
  never by insider signaling.
- **Brand fame, not activation.** Judge ads on memorability and earned
  attention, never CTR. No urgency, ever. A quiet endcard is allowed (see
  Endings); begging is not.
- **Capability first, privacy as the closer.** Lead with the rare thing (one
  interface, 100+ models, switch mid-thought); land the disqualifier ("stored
  as ciphertext we can't read"). Privacy-only messaging reaches insiders;
  better-product messaging reaches everyone (the Proton/Kagi lesson).

## The doctrine (nine laws — break one and it isn't a HushBox ad)

1. **Every line is a checkable fact.** Not opinion, not hype, not intent. If
   you can't cite it, it dies.
2. **Scope every claim to capability at its exact boundary.** We store
   ciphertext we can't decrypt; we route model calls zero-data-retention.
   Never "we never see your messages" — the server transiently handles
   plaintext to call the model. That asterisk is non-negotiable.
3. **Show the machinery.** Dramatize the surveillance mechanism
   (conversation → retained → reviewed → trained) or the product doing the
   thing. Never assert a value over a mood image (Apple "Data Auction",
   Signal's self-targeting ads are the models).
4. **One idea per ad.** One fact, one turn, one proof. A second idea is a
   second ad.
5. **Punch up at the system, never sideways or down.** The target is the
   surveillance business model and its default behaviors. Quote published
   policies verbatim when useful; don't sneer at named brands.
6. **Deadpan default, never tantrum.** Dry statement, then a beat. No winks,
   emoji, exclamation, grievance, or "cope". Restraint is the status move —
   not needing the laugh is the flex.
7. **The pause is a scripted device.** Silence gets a timestamp in the copy
   deck. Hard cuts only, never dissolves.
8. **The real app only.** The product surface is always the live UI,
   captured, never faked. The demo is the proof.
9. **Distinctive in form, differentiated in substance.** Use the asset system
   (below) relentlessly for recognition, and keep the real difference
   (encryption, ZDR, no ad business) as the payload — never one without the
   other.

## Emotional register

Deadpan is the default voice, not the only permitted emotion. Allowed range:
dry amusement, quiet dread (the 2am question sitting in a training set), awe
at the machinery, and at most one warm beat used as meaning. Banned:
fear-mongering, sentimentality, zany, grievance. The joke must *be* the
product argument (Dollar Shave Club's mechanic, our surface) or it's cut.

## People on screen

- **Real human fragments are allowed**: hands typing, a back at a desk,
  silhouettes, crowds — real footage only.
- **Full faces are rare** and only when the idea demands the attention a face
  buys — and only real people, never synthetic.
- **AI-generated humans are banned, always.** AI shots remain peopleless and
  textless (see iron rules).
- **Empty space is a tool, not a law**: reserve deserted compositions for
  when absence is the point ("nobody's watching", made literal).
- No spokesperson, no recurring character. The product UI is the protagonist;
  the recurring "face" is the motif.

## Distinctive asset system (mandatory in every ad — this is the compounding engine)

- **Signature accent: brand red `#ec4755`** (`--brand-red`, the product's own
  primary) against a dark restrained field. Everyone technical is
  dark+blue/violet; red is off-category and already ours. One decisive red
  element per ad minimum.
- **Palette:** dark, hushed, blue-hour base — the app's dark theme made
  physical — with the red accent doing the emotional work. Darkness alone is
  now a generic dev-tool look; the accent is what's ownable.
- **Type:** the product's own type and tokens from `packages/ui`, always.
  Overlays mirror any VO word-for-word. Type-only ads (Economist "Aged 42"
  register) are a valid format.
- **The machinery motif:** one recurring way of drawing the surveillance pipe
  (conversation → retained → reviewed → trained) and its opposite (wrap to
  key, lock confirms), rendered the same way across ads.
- **The hard cut and the load-bearing pause** as signature grammar.
- **The voice:** one consistent VO across all ads when VO is used — flat,
  dry, unhurried, faintly amused museum guide.
- **The tagline: "One interface. Every feature. Private."** (the README
  line). The standing single-minded proposition; every ad is one facet of it.
- **Brand inside ~2 seconds** (asset, type, or motif — small and ambient, not
  a logo card), and at the button. Never a watermark bug throughout.

Consistency compounds; changing these resets the equity. Three seconds of any
clip should be attributable to HushBox.

## Visual & editing grammar

- **Setting:** real-feeling spaces with a strong sense of place — interiors,
  night cities, ordinary desks at 2am, server rooms as they actually look.
  The screen as the only light source in a dark room is honest, cheap, and
  on-theme.
- **Composition:** negative space, centered still frames; the calm is the
  brand. One attention device per scene (speed ramp, foreground occlusion,
  moving light, near-field pass-through, settle) — never two.
- **Anti-monotony rule:** consecutive scenes must differ on ≥2 of {shot size,
  light temperature, dominant prop}. Repetition is the joke's skeleton;
  monotony is its failure mode.
- **Cut rhythm:** slow average pace, shots held slightly longer than
  comfortable, then one hard cut at the turn — the stillness/cut contrast is
  the punchline delivery system. Never montage-speed. De-escalating speed,
  escalating intimacy: end still, on the product.
- **Sound:** music is ONE sparse element whose job is to die — hard cut to
  silence at the payoff. Real room tone always present (dead-silent tracks
  read broken in-feed). Subtle mechanical detail (keys, fans, a lock) as the
  tactile layer. Build every ad to work muted; the sound-on version is the
  reward.

## Script structures & the length playbook

Two ad tracks — don't blend them into a half-demo:
(a) **demo-led** — the real UI carries the narrative (Google "Parisian Love"
rebuilt in our app: a chain of real prompts, a model switch mid-thought, one
privacy action, ordered so the viewer infers the arc);
(b) **concept-led** — the idea carries it and the product appears at the
button.

Structures that fit us: **the Turn** (mundane setup → beat → hard reveal; the
house device), **PAS** (agitate via stated fact, not adjectives), **rule of
three** (two plain facts set the pattern, the third breaks it), **the UI
sequence** (inputs as narrative). For 30s+, the "status quo stays down" arc:
the surveillance default keeps getting worse while the product line stays
flat — refuse the uplift; that refusal is the tone.

| Length | What it carries | Shape |
|---|---|---|
| 6s | The SMP in its smallest true form | [one dark fact] → beat → [hard cut to mark] |
| 15s | Exactly one turn (the workhorse) | [hook fact 0–3s] → [1–2 escalating facts 3–11s] → [reveal + mark 11–15s] |
| 30s | A micro-story (PAS / compressed spine) | [hook] → [problem] → [agitate] → [solve/demo] → [mark] |
| 45s | Triad escalation + fuller turn (hero ceiling) | three facts with scripted silences → turn → demo proof → mark; the third beat must re-hook |

Hero at 30–45s always ships with 15s and 6s cutdowns of the *same* idea.
9:16 master; 1:1 and 16:9 as render configs; compose so the center square
carries everything. Same idea on every platform — we don't do trends, duets,
or meme formats; not doing that is part of the distinctiveness.

## Hooks (no-face, no-shout menu)

Open on one of these in the first 1–3 seconds — never a logo card, never a
slow establishing shot:

- **Flat declarative fact** on a plain field ("Your AI chats are stored in
  plaintext.")
- **Stat cold-open** — one specific figure; specific reads as value, broad
  reads as clickbait.
- **Redaction / negative space** — the thing *not* happening: a blacked-out
  message, an empty log, "no results".
- **Reversal setup** — state the category norm, then cut ("Every other AI
  keeps a copy.")
- **Dry question, one-word answer waiting** — "Who can read this?" → hard cut
  → "No one." (scope: at rest)
- **Start mid-action** — the UI already in motion.
- **Silence as the interrupt** — a quiet clip in a feed built for noise.
- **The demo as its own hook** — the real UI doing one uncanny thing (a key
  rotates, a message locks, nothing logs).

The hook is a promise the body must pay. Because every line is a checkable
fact, the promise is literally true — resolve the loop by the second beat.

## Endings

A button, not a plea: the payoff of the loop the hook opened, then a quiet
endcard — the mark, the tagline, optionally `hushbox.ai`. No urgency, no
countdown, no "download now". The end is the fact landing, so it must be the
same idea the hook promised.

## The anti-corny gate (every copy line clears ALL of these; one failure kills the line)

- [ ] **Checkable?** Citable fact — opinion, hype, and adjectives fail.
- [ ] **Scoped?** True at its exact boundary (at-rest ciphertext, ZDR
      routing, no-ad-business); nothing implying "we never see anything".
- [ ] **Punching up?** At the system's default behavior — not the viewer, not
      a weaker party, not a named-brand sneer.
- [ ] **Deadpan?** Flat and faintly amused, not trying. No winks or emoji.
- [ ] **One idea?** Serves the single fact; smuggles no second message.
- [ ] **Sound-off legible?** On-screen text carries it muted, mirroring any
      VO.
- [ ] **Ownable?** Could a surveillance-funded competitor say it without
      lying? If yes, it isn't ours.
- [ ] **No banned cliché?** (below)

## Fact bank (scoped; re-verify third-party facts at ship time)

Their default behavior *(verify current wording each ship)*:
- Consumer ChatGPT trains on conversations by default; opting out is a switch
  you go find.
- Training off, chats are still retained for a window (~30 days, abuse
  monitoring) unless a zero-retention path applies.
- Feedback (a thumbs-up) can override a training opt-out for that
  conversation.
- Opt-out and deletion aren't retroactive to data already trained in.
- In 2025 a court order (NYT litigation) required OpenAI to preserve chats
  users had deleted — state in past tense; check current status.

Our architecture *(keep exact scope)*:
- Stored as ciphertext we can't decrypt (at rest; R2 holds only ciphertext,
  wrapped to epoch keys).
- Encrypted on your device before it leaves it.
- Every model call routed zero-data-retention, per request, fail-closed
  *(verify provider-granular wording)*.
- No ad business, so nothing to build a profile for.
- The source is **readable** — check the encryption instead of trusting us
  (source-available, no rights granted; never say "open source").
- We can't read your chats to train on them (scope to storage; the transient
  model-call plaintext is the honest asterisk).

## Ban list

Verbal: "you are the product" / "if it's free…" / *Social Dilemma* framing
(exhausted, disempowering); "we value your privacy", "military-grade",
"bank-grade" (uncheckable filler); intention promises ("we'd never…");
absolute claims the architecture can't guarantee ("we never see anything",
"unhackable", "100% anonymous"); "wake up" / manifesto sanctimony; dunking,
sneering, "cope"; winks, emoji, exclamation points; meme-chasing and topical
references that date on contact.

Visual: hooded hacker, Matrix rain, the giant eye, glowing red locks,
fingerprint-into-binary, Big Brother posters, CCTV montages (generic
tech-thriller, zero mechanism); horror scoring / "they're watching you RIGHT
NOW" (hunted, not informed); AI-generated humans; hard CTAs, countdowns;
red-string-corkboard paranoia. Defiant is not paranoid.

The test: does it leave the viewer *informed and slightly amused*, or *sold
to and scared*? Only the first ships.

## Reference shelf (the templates, by use)

- **Voice:** The Economist "I never read The Economist. Aged 42." — the
  reader finishes the thought.
- **Category/enemy/register:** Mullvad VPN's deadpan anti-surveillance boards.
- **Craft economy:** KFC "FCK" — one image, one flat line, total honesty.
- **UI-as-narrative:** Google "Parisian Love" — our best demo-track template.
- **Mechanism-as-drama:** Apple "Data Auction"; Signal's self-targeting ads
  (borrow the creative, not the disputed martyrdom framing).
- **No-people proof:** Honda "Cog", Sony "Balls" (structure, not palette),
  Surreal's flat billboards, Dissolve's "Generic Brand Video" (a "generic AI
  startup video" self-parody is a ready format for us).
- **Honesty flags:** Ogilvy's Rolls-Royce "+50%" and Hathaway "+65%" are
  adman lore; "Get a Mac 5%→23%" is blog inflation; Patagonia's "+30%" is
  secondhand. Never repeat inflated numbers as fact — we'd be doing the thing
  we punch at.

---

# Part II — The production process

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
4. **AI generates textless, peopleless environments only.** Every on-screen
   word is added in the edit. AI-generated humans are banned always. Real
   human fragments (hands, backs, silhouettes, crowds — real footage only)
   are permitted per the People rules in Part I; full faces are rare, real,
   and founder-approved per ad.
5. **The anti-corny gate** (Part I) runs on every line of copy before it
   enters the copy deck, and again at QA. One failed check kills the line.
6. Each ad gets `ads/YYYY-MM-<slug>/` with the standard numbered subfolders
   and its own `PRODUCTION-GUIDE.md` (see `ads/README.md` and the 2026-07
   hq-tour ad as the reference implementation).

## Process (phases in execution order)

### 1. Plan iteratively with the human
Pick ONE fact from the fact bank → choose the track (demo-led or
concept-led) and the length structure → write the hook from the menu → run
the anti-corny gate → concept → scene list → locked copy deck
(`01-brief/copy-deck.md`), all approved before any spend. The copy deck is
the single source of truth for VO, subtitles/overlays, and scene timing
(including timestamps for the scripted silences). Research
competitors/reference ads if the concept is new. Write the ad's
`PRODUCTION-GUIDE.md` before generating.

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
   straight geometry, same building, the red accent present where scripted.
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
MiniMax Speech 2.8 HD on fal (`fal-ai/minimax/speech-2.8-hd`) — same MCP,
same approval flow, same archive discipline as video. Per-line FLAC 44.1kHz
(the API offers mp3/pcm/flac, no WAV), 3+ takes each; the API's `duration_ms`
drives fit checks — assert ≤ the scene slot, never squeeze. Delivery: flat,
dry, faintly amused museum guide — one consistent voice across all ads.
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
Demo content is written-for-the-ad, never real conversations — and it must
read as genuine (realistic prompts, never lorem ipsum; the Superhuman
synthetic-inbox lesson). Stage the "task completes" beat — the answer
streaming in, the model switching mid-thought, the lock confirming — and
hold on it.

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
from the Playwright action JSON (eased push-in on the key action, hold, ease
out — never jump-zooms). Brand type/tokens come from `packages/ui` — the ad
is rendered by the same engine as the product, red accent included. Hook
variants and aspect crops are props/render configs, not re-edits; final
encode and crops go through ffmpeg. Music: one sparse Artlist element,
hard-cut to silence at the payoff.

### 6. QA + export
The ad's PRODUCTION-GUIDE QA checklist gates shipping: watch muted (the
muted cut is the primary experience), watch audio-only, freeze-frame every
AI shot for artifacts/text/people, verify the UI is the real current build,
anti-corny gate re-pass on every line (checkable + scoped + no banned
cliché), confirm the brand is identifiable inside ~2s and the endcard
carries mark + tagline, variants checked on a real phone.

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

This skill records the current refined process AND the current strategy of
record. When the process, preferred models, pricing, tooling, or a strategy
ruling changes during ad production, **update this skill in the same
session** — a stale skill is a wrong comment at file scale.
