import { useCurrentFrame, useVideoConfig } from 'remotion';

import { cursorPosition, cursorPressSize } from './cursor-position.js';
import type { CaptureLog } from '../capture/types.js';

interface CursorSpriteProps {
  log: CaptureLog;
  /** Scale from capture CSS px to composition px. */
  scale: number;
  color?: string;
}

/**
 * Brand-styled cursor following the capture action log. Playwright videos
 * contain no OS cursor, so this sprite IS the cursor — position and press-size
 * math live in cursor-position (tested); this renders the sprite.
 */
export const CursorSprite: React.FC<CursorSpriteProps> = ({ log, scale, color = '#ffffff' }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const point = cursorPosition(log, (frame / fps) * 1000, scale);
  if (point === null) return null;
  const size = cursorPressSize(log, frame, fps);

  return (
    <div
      style={{
        position: 'absolute',
        left: point.x,
        top: point.y,
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
