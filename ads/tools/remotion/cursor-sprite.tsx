import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

import type { CaptureLog } from '../capture/types.js';

interface CursorSpriteProps {
  log: CaptureLog;
  /** Scale from capture CSS px to composition px. */
  scale: number;
  color?: string;
}

/**
 * Brand-styled cursor following the capture action log. Playwright videos
 * contain no OS cursor, so this sprite IS the cursor — driven by ground
 * truth, eased here, and scaled down briefly on each click.
 */
export const CursorSprite: React.FC<CursorSpriteProps> = ({ log, scale, color = '#ffffff' }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tMs = (frame / fps) * 1000;

  const moves = log.actions.filter((a) => a.kind === 'move' || a.kind === 'click');
  const first = moves[0];
  if (!first) return null;

  let previous = first;
  let next = moves.at(-1) ?? first;
  for (const move of moves) {
    if (move.t <= tMs) previous = move;
    if (move.t >= tMs) {
      next = move;
      break;
    }
  }
  const p = previous.t === next.t ? 1 : (tMs - previous.t) / (next.t - previous.t);
  const x = (previous.x + (next.x - previous.x) * p) * scale;
  const y = (previous.y + (next.y - previous.y) * p) * scale;

  const lastClick = log.actions.toReversed().find((a) => a.kind === 'click' && a.t <= tMs);
  const clickFrame = lastClick ? Math.round((lastClick.t / 1000) * fps) : null;
  const press =
    clickFrame === null
      ? 0
      : spring({ frame: frame - clickFrame, fps, config: { damping: 12, mass: 0.4 } });
  const size = interpolate(press, [0, 0.35, 1], [22, 17, 22]);

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: size,
        height: size,
        marginLeft: -size / 2,
        marginTop: -size / 2,
        borderRadius: '50%',
        background: color,
        opacity: 0.9,
        boxShadow: '0 2px 10px rgba(0,0,0,0.45)',
      }}
    />
  );
};
