import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame } from 'remotion';

import { expandRect } from './screen-track.js';
import type { ScreenReplaceScene } from './ad-spec.js';

/**
 * Keys a UI capture into the green screen of an AI phone plate. The plate
 * renders full-frame underneath (bezel, stand, room stay real); the UI sits on
 * top, fit to the tracked screen rect for this frame — overshot so it bleeds
 * past the green and rounded so it tucks under the bezel. Because the seeded
 * tracker already localized the screen, the composite is pure geometry and
 * renders exactly.
 */
export const ScreenReplace: React.FC<{ scene: ScreenReplaceScene }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const index = Math.min(Math.max(frame, 0), scene.track.length - 1);
  const rect = expandRect(
    scene.track[index] ?? { x: 0, y: 0, width: 0, height: 0 },
    scene.overshoot
  );

  return (
    <AbsoluteFill>
      <OffthreadVideo
        src={staticFile(scene.plateSrc)}
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
      <div
        style={{
          position: 'absolute',
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
          borderRadius: rect.width * scene.cornerRadiusRatio,
          overflow: 'hidden',
        }}
      >
        <OffthreadVideo
          src={staticFile(scene.screenSrc)}
          muted
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </div>
    </AbsoluteFill>
  );
};
