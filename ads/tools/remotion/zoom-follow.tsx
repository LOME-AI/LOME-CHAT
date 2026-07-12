import { spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { PropsWithChildren } from 'react';

export interface ZoomTarget {
  /** Composition frame at which this zoom begins easing in. */
  frame: number;
  /** Focus point in composition px. */
  x: number;
  y: number;
  zoom: number;
}

interface ZoomFollowProps {
  /** Chronological zoom targets, usually derived from the capture log's clicks. */
  targets: ZoomTarget[];
  width: number;
  height: number;
}

/**
 * The Screen-Studio move: eased zoom toward interaction points. Each target
 * springs from the previous camera state; a final target with zoom 1 returns
 * to the full frame.
 */
export const ZoomFollow: React.FC<PropsWithChildren<ZoomFollowProps>> = ({
  targets,
  width,
  height,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  let zoom = 1;
  let cx = width / 2;
  let cy = height / 2;
  for (const t of targets) {
    if (frame < t.frame) break;
    const p = spring({ frame: frame - t.frame, fps, config: { damping: 22, mass: 0.9 } });
    zoom += (t.zoom - zoom) * p;
    cx += (t.x - cx) * p;
    cy += (t.y - cy) * p;
  }

  const tx = width / 2 - cx * zoom;
  const ty = height / 2 - cy * zoom;

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          width,
          height,
          transform: `translate(${String(tx)}px, ${String(ty)}px) scale(${String(zoom)})`,
          transformOrigin: '0 0',
        }}
      >
        {children}
      </div>
    </div>
  );
};
