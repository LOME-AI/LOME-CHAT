import { z } from 'zod';

import { wavDurationSeconds } from './wav.js';

/**
 * The timing map is the machine-readable form of the copy deck — the single
 * source of truth the Remotion composition renders from. Cuts, overlay text,
 * and VO placement all come from here; there is no second timing source to
 * drift against.
 */
export const sceneTimingSchema = z.object({
  id: z.string(),
  /** Seconds from ad start. */
  start: z.number().nonnegative(),
  duration: z.number().positive(),
  /** Overlay line — also the subtitle and the VO text, by design. */
  line: z.string(),
  /** Absolute path to the picked VO take; absent for silent scenes. */
  voFile: z.string().optional(),
  /** 'center' places VO in the middle of the slot; a number = lead-in seconds. */
  voPlacement: z.union([z.literal('center'), z.number().nonnegative()]).default('center'),
  videoFile: z.string(),
});

export const timingMapSchema = z.object({
  fps: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  scenes: z.array(sceneTimingSchema).min(1),
});

export type SceneTiming = z.infer<typeof sceneTimingSchema>;
export type TimingMap = z.infer<typeof timingMapSchema>;

export interface VoFit {
  sceneId: string;
  voSeconds: number;
  slotSeconds: number;
  /** Seconds from ad start where the VO begins. */
  voStart: number;
}

/**
 * Validates every VO take fits its scene slot and computes placement.
 * A line longer than its slot is a hard error — regenerate the take, never
 * squeeze the audio.
 */
export function fitVoiceovers(map: TimingMap): VoFit[] {
  const fits: VoFit[] = [];
  for (const scene of map.scenes) {
    if (scene.voFile === undefined) continue;
    const voSeconds = wavDurationSeconds(scene.voFile);
    if (voSeconds > scene.duration) {
      throw new Error(
        `VO for scene "${scene.id}" is ${voSeconds.toFixed(2)}s but the slot is ` +
          `${scene.duration.toFixed(2)}s — regenerate the take, never squeeze the audio`
      );
    }
    const lead =
      scene.voPlacement === 'center' ? (scene.duration - voSeconds) / 2 : scene.voPlacement;
    fits.push({
      sceneId: scene.id,
      voSeconds,
      slotSeconds: scene.duration,
      voStart: scene.start + lead,
    });
  }
  return fits;
}
