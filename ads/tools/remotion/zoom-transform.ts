import { spring } from 'remotion';

export interface ZoomTarget {
  /** Composition frame at which this zoom begins easing in. */
  frame: number;
  /** Focus point in composition px. */
  x: number;
  y: number;
  zoom: number;
}

export interface ZoomState {
  /** Translate applied before the scale (composition px). */
  tx: number;
  ty: number;
  zoom: number;
}

export interface Dimensions {
  width: number;
  height: number;
}

/**
 * The Screen-Studio move: eased camera state at `frame`, springing from the
 * previous target toward each reached target. A final target with zoom 1
 * returns to the full frame. Pure so the transform math is tested without a
 * component; `spring` is a standalone Remotion function, safe to call here.
 */
export function zoomTransform(
  targets: readonly ZoomTarget[],
  frame: number,
  fps: number,
  size: Dimensions
): ZoomState {
  let zoom = 1;
  let cx = size.width / 2;
  let cy = size.height / 2;
  for (const target of targets) {
    if (frame < target.frame) break;
    const progress = spring({
      frame: frame - target.frame,
      fps,
      config: { damping: 22, mass: 0.9 },
    });
    zoom += (target.zoom - zoom) * progress;
    cx += (target.x - cx) * progress;
    cy += (target.y - cy) * progress;
  }
  return { tx: size.width / 2 - cx * zoom, ty: size.height / 2 - cy * zoom, zoom };
}
