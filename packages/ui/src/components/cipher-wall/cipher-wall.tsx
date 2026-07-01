import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { useCipherWall } from './use-cipher-wall';
import { CELL_WIDTH, CELL_HEIGHT, EXCLUSION_STRIDE } from './cipher-wall-engine';
import type { ThemeColors } from './cipher-wall-engine';

interface CipherWallProps {
  /**
   * Required pool of strings the wall reveals (animated mode) or bakes in
   * (frozen mode). See PageHero.astro and splash-screen.tsx for examples;
   * there is no fallback default by design.
   */
  messages: readonly string[];
  frozen?: boolean;
  themeOverride?: ThemeColors;
  cipherOpacity?: number;
  /**
   * Shift the frozen messages off grid center (negative row = up, positive
   * col = right). Default 0; only affects `frozen` mode.
   */
  messageRowOffset?: number;
  messageColOffset?: number;
  fadeMask?: 'left' | 'radial' | 'none';
  fadeMaskTarget?: string;
  className?: string;
  style?: React.CSSProperties;
}

const FADE_MASK_PADDING_X = 12;
const FADE_MASK_PADDING_Y = 24;
const EXCLUSION_THRESHOLD_SQ = 1.21; // 1.1² — excludes just past the transparent edge of the mask

export interface ExclusionZoneInput {
  targetRect: { left: number; top: number; width: number; height: number };
  canvasRect: { left: number; top: number; width: number; height: number };
}

export function computeExclusionZone(input: ExclusionZoneInput): Set<number> {
  const { targetRect, canvasRect } = input;

  const rx = Math.round(targetRect.width / 2) + FADE_MASK_PADDING_X;
  const ry = Math.round(targetRect.height / 2) + FADE_MASK_PADDING_Y;

  const cx = (targetRect.left + targetRect.width / 2 - canvasRect.left) / CELL_WIDTH;
  const cy = (targetRect.top + targetRect.height / 2 - canvasRect.top) / CELL_HEIGHT;

  const gridRx = rx / CELL_WIDTH;
  const gridRy = ry / CELL_HEIGHT;

  const totalCols = Math.floor(canvasRect.width / CELL_WIDTH);
  const totalRows = Math.floor(canvasRect.height / CELL_HEIGHT);

  const zone = new Set<number>();
  const thresholdFactor = Math.sqrt(EXCLUSION_THRESHOLD_SQ);
  const rowStart = Math.max(0, Math.floor(cy - gridRy * thresholdFactor));
  const rowEnd = Math.min(totalRows, Math.ceil(cy + gridRy * thresholdFactor));
  const colStart = Math.max(0, Math.floor(cx - gridRx * thresholdFactor));
  const colEnd = Math.min(totalCols, Math.ceil(cx + gridRx * thresholdFactor));

  for (let r = rowStart; r < rowEnd; r++) {
    for (let c = colStart; c < colEnd; c++) {
      const dx = (c + 0.5 - cx) / gridRx;
      const dy = (r + 0.5 - cy) / gridRy;
      if (dx * dx + dy * dy <= EXCLUSION_THRESHOLD_SQ) {
        zone.add(r * EXCLUSION_STRIDE + c);
      }
    }
  }

  return zone;
}

function getMaskStyles(
  fadeMask: 'left' | 'radial' | 'none' | undefined,
  frozen: boolean | undefined
): React.CSSProperties | undefined {
  if (frozen) return undefined;
  switch (fadeMask ?? 'left') {
    case 'left': {
      return {
        maskImage: 'linear-gradient(to right, transparent 0%, black 15%)',
        WebkitMaskImage: 'linear-gradient(to right, transparent 0%, black 15%)',
      };
    }
    case 'radial':
    case 'none': {
      return undefined;
    }
  }
}

interface RadialMaskResult {
  maskStyles: React.CSSProperties | undefined;
  exclusionZone: Set<number> | null;
}

export function useRadialMask(
  fadeMask: CipherWallProps['fadeMask'],
  fadeMaskTarget: string | undefined,
  frozen: boolean | undefined,
  canvasRef: React.RefObject<HTMLCanvasElement | null>
): RadialMaskResult {
  const [dynamicMask, setDynamicMask] = React.useState<React.CSSProperties | undefined>();
  const [exclusionZone, setExclusionZone] = React.useState<Set<number> | null>(null);

  React.useLayoutEffect(() => {
    if (fadeMask !== 'radial' || frozen) return;

    if (!fadeMaskTarget) {
      throw new Error('CipherWall: fadeMask="radial" requires fadeMaskTarget selector');
    }

    const targetCandidate = document.querySelector(fadeMaskTarget);
    if (!targetCandidate) {
      throw new Error(`CipherWall: fadeMaskTarget "${fadeMaskTarget}" not found in DOM`);
    }
    const target = targetCandidate;

    function updateMask(): void {
      const rect = target.getBoundingClientRect();
      const rx = Math.round(rect.width / 2) + FADE_MASK_PADDING_X;
      const ry = Math.round(rect.height / 2) + FADE_MASK_PADDING_Y;
      const gradient = `radial-gradient(${String(rx)}px ${String(ry)}px at center, transparent 100%, black 140%)`;
      setDynamicMask({ maskImage: gradient, WebkitMaskImage: gradient });

      const canvasEl = canvasRef.current;
      if (canvasEl) {
        const canvasRect = canvasEl.getBoundingClientRect();
        setExclusionZone(computeExclusionZone({ targetRect: rect, canvasRect }));
      }
    }

    updateMask();

    const ro = new ResizeObserver(() => {
      updateMask();
    });
    ro.observe(target);
    return (): void => {
      ro.disconnect();
    };
  }, [fadeMask, fadeMaskTarget, frozen, canvasRef]);

  return { maskStyles: dynamicMask, exclusionZone };
}

export function CipherWall(props: Readonly<CipherWallProps>): React.JSX.Element {
  const { className, style, fadeMask, fadeMaskTarget, ...options } = props;
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  const { maskStyles: dynamicMaskStyles, exclusionZone } = useRadialMask(
    fadeMask,
    fadeMaskTarget,
    options.frozen,
    canvasRef
  );
  useCipherWall({ ...options, exclusionZone }, canvasRef);
  const maskStyles = dynamicMaskStyles ?? getMaskStyles(fadeMask, options.frozen);

  return (
    <canvas
      ref={canvasRef}
      data-testid={TEST_IDS.cipherWall}
      role="img"
      aria-label="Animated cipher wall showing messages being encrypted and decrypted"
      className={className ?? 'h-full w-full'}
      style={{
        ...maskStyles,
        ...style,
      }}
    />
  );
}
