import { interpolate, spring } from 'remotion';

import type { CaptureAction, CaptureLog } from '../capture/types.js';

export interface CursorPoint {
  x: number;
  y: number;
}

/**
 * Cursor position at `tMs`, interpolated between the bracketing move/click
 * events of the capture log and scaled from capture CSS px to composition px.
 * Returns null when the log has no positional events. Pure — the sprite
 * component renders whatever this returns.
 */
export function cursorPosition(log: CaptureLog, tMs: number, scale: number): CursorPoint | null {
  const moves = log.actions.filter((a) => a.kind === 'move' || a.kind === 'click');
  const first = moves[0];
  if (first === undefined) return null;

  let previous = first;
  let next: CaptureAction | undefined;
  for (const move of moves) {
    if (move.t <= tMs) previous = move;
    if (next === undefined && move.t >= tMs) next = move;
  }
  // No event at/after tMs means the cursor rests on the last one seen.
  const target = next ?? previous;
  const progress = previous.t === target.t ? 1 : (tMs - previous.t) / (target.t - previous.t);
  return {
    x: (previous.x + (target.x - previous.x) * progress) * scale,
    y: (previous.y + (target.y - previous.y) * progress) * scale,
  };
}

/**
 * Cursor sprite diameter (px) at `frame`, dipping on each click so the pointer
 * visibly presses. Springs from the most recent click; 22px at rest.
 */
export function cursorPressSize(log: CaptureLog, frame: number, fps: number): number {
  const tMs = (frame / fps) * 1000;
  const lastClick = log.actions.toReversed().find((a) => a.kind === 'click' && a.t <= tMs);
  const press =
    lastClick === undefined
      ? 0
      : spring({
          frame: frame - Math.round((lastClick.t / 1000) * fps),
          fps,
          config: { damping: 12, mass: 0.4 },
        });
  return interpolate(press, [0, 0.35, 1], [22, 17, 22]);
}
