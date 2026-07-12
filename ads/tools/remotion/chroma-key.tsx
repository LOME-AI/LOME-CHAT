import { useCallback, useEffect, useRef } from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';

export interface ChromaKeyOptions {
  /** 0..1 — how green-dominant a pixel must be to become transparent. */
  similarity: number;
  /** 0..1 — softness band around the threshold. */
  smoothness: number;
}

export const DEFAULT_CHROMA: ChromaKeyOptions = { similarity: 0.35, smoothness: 0.1 };

/**
 * Per-pixel green keying. Pure function so the math is testable without a
 * browser: mutates the RGBA buffer, zeroing alpha on green-dominant pixels.
 */
export function keyOutGreen(
  data: Uint8ClampedArray,
  options: ChromaKeyOptions = DEFAULT_CHROMA
): void {
  for (let index = 0; index < data.length; index += 4) {
    const r = (data[index] ?? 0) / 255;
    const g = (data[index + 1] ?? 0) / 255;
    const b = (data[index + 2] ?? 0) / 255;
    const greenness = g - Math.max(r, b);
    if (greenness <= 0) continue;
    const t = (greenness - options.similarity) / options.smoothness;
    if (t >= 1) data[index + 3] = 0;
    else if (t > 0) data[index + 3] = Math.round((data[index + 3] ?? 0) * (1 - t));
  }
}

interface GreenScreenVideoProps {
  /** The already-mounted <video> element to key (from OffthreadVideo ref or Video). */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  options?: ChromaKeyOptions;
}

/**
 * Canvas layer that redraws the referenced video element each frame with
 * green keyed to transparency. Verify-at-first-render: Remotion's docs
 * pattern (video → canvas → putImageData) is followed here; if seeking
 * artifacts appear in renders, switch the source to <OffthreadVideo
 * transparent> per current Remotion guidance.
 */
export const GreenScreenVideo: React.FC<GreenScreenVideoProps> = ({ videoRef, options }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { width, height } = useVideoConfig();

  const draw = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    keyOutGreen(imageData.data, options ?? DEFAULT_CHROMA);
    ctx.putImageData(imageData, 0, 0);
  }, [videoRef, options]);

  useEffect(() => {
    draw();
  });

  return (
    <AbsoluteFill>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        style={{ width: '100%', height: '100%' }}
      />
    </AbsoluteFill>
  );
};
