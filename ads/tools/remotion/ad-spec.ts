import { z } from 'zod';

/**
 * The data contract an ad compiles from. A campaign folder holds one of these
 * (as data) plus its assets; the <Ad> engine renders it. All timing is in
 * composition frames so the spec is the single source of cut/overlay/audio
 * placement — there is no second timing source to drift against. Asset strings
 * are `staticFile` paths relative to the Remotion public dir (the ads root).
 */

const assetPath = z.string().min(1);
const frame = z.number().int().nonnegative();
const span = z.number().int().positive();

/** An AI shot (or any video plate), trimmed and placed on the timeline. */
const videoScene = z.object({
  type: z.literal('video'),
  id: z.string().min(1),
  from: frame,
  durationInFrames: span,
  src: assetPath,
  /** Frames trimmed off the source start (the plate is longer than its slot). */
  trimStartFrames: frame.default(0),
  /** Drop the plate's native audio (kept by default as the ambient bed). */
  muted: z.boolean().default(false),
});

/** The payoff card: invoice-style lines on a flat brand background. */
const receiptScene = z.object({
  type: z.literal('receipt'),
  id: z.string().min(1),
  from: frame,
  durationInFrames: span,
  lines: z.array(z.string().min(1)).min(1),
});

/** The phone-screen rectangle for one frame (composition px). */
const trackRect = z.object({
  x: z.number(),
  y: z.number(),
  width: span,
  height: span,
});

/**
 * The S5 composite: a UI capture keyed into the green screen of an AI phone
 * plate. `track` is the per-frame screen rectangle produced offline by the
 * seeded chroma tracker (generate-track.ts); the UI is fit to that rect,
 * overshot and rounded so its edges tuck under the bezel and no green shows.
 * The plate renders full-frame underneath.
 */
const screenReplaceScene = z.object({
  type: z.literal('screenReplace'),
  id: z.string().min(1),
  from: frame,
  durationInFrames: span,
  /** The AI phone plate (its screen is chroma-key green). */
  plateSrc: assetPath,
  /** The UI capture keyed into the screen. */
  screenSrc: assetPath,
  /** Per-frame screen rect from the tracker (index = scene-local frame). */
  track: z.array(trackRect).min(1),
  /** Corner radius as a fraction of the pin width. */
  cornerRadiusRatio: z.number().nonnegative().default(0.13),
  /** Fractional bleed past the green edges so no green peeks through. */
  overshoot: z.number().nonnegative().default(0.02),
});

const sceneSchema = z.discriminatedUnion('type', [videoScene, receiptScene, screenReplaceScene]);

/** A lower-third subtitle = the same words as the VO, by design. */
const overlaySchema = z.object({
  from: frame,
  durationInFrames: span,
  text: z.string().min(1),
  /** A word/phrase within `text` to render in the brand accent. */
  emphasis: z.string().min(1).optional(),
});

/** A voiceover line placed at a frame; its natural length plays out. */
const voiceoverSchema = z.object({
  from: frame,
  src: assetPath,
});

/**
 * The single music bed. It enters at frame 0 and hard-cuts to silence at
 * `endAtFrame` (the payoff) via the Sequence duration — the silence is a cut,
 * not a fade. Volume holds at `baseVolume`, then swells to `peakVolume` from
 * `swellFromFrame` over `swellFrames` (see music-volume.ts).
 */
const musicSchema = z.object({
  src: assetPath,
  /** Frame the bed hard-cuts to silence. Omit to play to the composition end. */
  endAtFrame: span.optional(),
  /** Volume before the swell, and the flat volume with no swell (0..1). */
  baseVolume: z.number().min(0).max(1).default(0.28),
  /** Volume at the top of the swell (0..1). */
  peakVolume: z.number().min(0).max(1).default(0.38),
  /** Frame the swell begins; omit for a flat bed. */
  swellFromFrame: frame.optional(),
  /** Frames the swell ramps base→peak over. */
  swellFrames: span.default(30),
});

export const adSpecSchema = z.object({
  id: z.string().min(1),
  width: span,
  height: span,
  fps: span,
  durationInFrames: span,
  /** Corner logomark shown for the whole ad (opening-frame logo lifts recall). */
  logo: assetPath.optional(),
  /** Single music bed; omit until a track is chosen. */
  music: musicSchema.optional(),
  scenes: z.array(sceneSchema).min(1),
  overlays: z.array(overlaySchema).default([]),
  voiceovers: z.array(voiceoverSchema).default([]),
});

export type AdSpec = z.infer<typeof adSpecSchema>;
export type AdSpecInput = z.input<typeof adSpecSchema>;
export type AdScene = z.infer<typeof sceneSchema>;
export type ScreenReplaceScene = z.infer<typeof screenReplaceScene>;
export type MusicBed = z.infer<typeof musicSchema>;
