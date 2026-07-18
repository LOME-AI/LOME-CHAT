import { useCurrentFrame, useVideoConfig } from 'remotion';

import { zoomTransform, type ZoomTarget } from './zoom-transform.js';
import type { PropsWithChildren } from 'react';

interface ZoomFollowProps {
  /** Chronological zoom targets, usually derived from the capture log's clicks. */
  targets: ZoomTarget[];
  width: number;
  height: number;
}

/**
 * The Screen-Studio move: eased zoom toward interaction points. The transform
 * math lives in zoomTransform (tested); this wrapper only applies it as a CSS
 * transform around its children.
 */
export const ZoomFollow: React.FC<PropsWithChildren<ZoomFollowProps>> = ({
  targets,
  width,
  height,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { tx, ty, zoom } = zoomTransform(targets, frame, fps, { width, height });

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
