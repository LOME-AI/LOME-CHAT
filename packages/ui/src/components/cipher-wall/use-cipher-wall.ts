import * as React from 'react';
import {
  createGrid,
  resizeCells,
  seedInitialReveals,
  createFrozenSnapshot,
  updateState,
  pruneExcludedReveals,
  renderFrame,
  CELL_WIDTH,
  CELL_HEIGHT,
} from './cipher-wall-engine';
import { useAnimationFrame } from '../../hooks/use-animation-frame';
import type { CipherWallState, ThemeColors } from './cipher-wall-engine';

const DPR_CAP = 2;

export interface CipherWallOptions {
  /**
   * Required pool of strings the wall reveals (animated) or bakes in
   * (frozen). Each caller declares its own list so the cipher copy stays
   * thematic to the page; there is no shared default. See PageHero.astro
   * (marketing) and splash-screen.tsx (native splash PNG) for examples.
   */
  messages: readonly string[];
  frozen?: boolean;
  themeOverride?: ThemeColors;
  cipherOpacity?: number;
  /**
   * Shift the frozen (baked-in) messages off the grid center: negative row
   * raises them toward the top, positive col moves them right. Default 0 — only
   * the frozen path reads these; the animated path is unaffected.
   */
  messageRowOffset?: number;
  messageColOffset?: number;
  exclusionZone?: Set<number> | null;
}

export function readThemeColors(): ThemeColors {
  const style = getComputedStyle(document.documentElement);
  const read = (property: string): string => style.getPropertyValue(property).trim();
  const isDark = document.documentElement.classList.contains('dark');

  return {
    background: read('--background') || (isDark ? '#1a1816' : '#faf9f6'),
    foreground: read('--foreground') || (isDark ? '#f2f1ef' : '#1a1a1a'),
    brandRed: read('--brand-red') || '#ec4755',
    foregroundMuted: read('--foreground-muted') || (isDark ? '#9a9894' : '#525252'),
  };
}

export function useCipherWall(
  options: CipherWallOptions,
  externalCanvasRef?: React.RefObject<HTMLCanvasElement | null>
): React.RefObject<HTMLCanvasElement | null> {
  const internalCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const canvasRef = externalCanvasRef ?? internalCanvasRef;
  const stateRef = React.useRef<CipherWallState | null>(null);
  const colorsRef = React.useRef<ThemeColors | null>(null);
  const tickRef = React.useRef<((time: number) => void) | null>(null);
  const logoMaskRef = React.useRef<boolean[][] | null>(null);

  const messages = options.messages;
  const frozen = options.frozen === true;
  const themeOverride = options.themeOverride;
  const cipherOpacity = options.cipherOpacity ?? 1;
  const messageRowOffset = options.messageRowOffset ?? 0;
  const messageColOffset = options.messageColOffset ?? 0;
  const exclusionZone = options.exclusionZone ?? null;

  const exclusionZoneRef = React.useRef<Set<number> | null>(exclusionZone);
  exclusionZoneRef.current = exclusionZone;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const parent = canvas.parentElement;

    colorsRef.current = themeOverride ?? readThemeColors();

    const dpr = Math.min(devicePixelRatio, DPR_CAP);

    function computeGridSize(w: number, h: number): { cols: number; rows: number } {
      return {
        cols: Math.floor(w / CELL_WIDTH),
        rows: Math.floor(h / CELL_HEIGHT),
      };
    }

    function sizeCanvas(w: number, h: number): void {
      if (!canvas || !ctx) return;
      const targetW = w * dpr;
      const targetH = h * dpr;
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }

    function tryRender(): void {
      if (!ctx || !parent || !stateRef.current || !colorsRef.current) return;
      renderFrame({
        ctx,
        state: stateRef.current,
        colors: colorsRef.current,
        width: parent.clientWidth,
        height: parent.clientHeight,
        logoMask: logoMaskRef.current,
        cipherOpacity,
      });
    }

    const initW = parent?.clientWidth ?? 0;
    const initH = parent?.clientHeight ?? 0;
    sizeCanvas(initW, initH);
    const { cols: initCols, rows: initRows } = computeGridSize(initW, initH);

    let lastCols = initCols;
    let lastRows = initRows;

    if (frozen) {
      stateRef.current = createFrozenSnapshot(initCols, initRows, messages, {
        row: messageRowOffset,
        col: messageColOffset,
      });
      tryRender();

      function handleFrozenResize(): void {
        if (!parent) return;
        const w = parent.clientWidth;
        const h = parent.clientHeight;
        sizeCanvas(w, h);
        const { cols, rows } = computeGridSize(w, h);
        if (cols !== lastCols || rows !== lastRows) {
          stateRef.current = createFrozenSnapshot(cols, rows, messages, {
            row: messageRowOffset,
            col: messageColOffset,
          });
          lastCols = cols;
          lastRows = rows;
        }
        tryRender();
      }

      window.addEventListener('resize', handleFrozenResize);

      return () => {
        window.removeEventListener('resize', handleFrozenResize);
      };
    }

    const state = createGrid(initCols, initRows, messages);
    state.exclusionZone = exclusionZoneRef.current;
    seedInitialReveals(state);
    stateRef.current = state;

    // Initial paint. Under reduced motion the rAF loop never runs, so this is
    // the only frame ever drawn; it doubles as the first frame otherwise.
    tryRender();

    let lastTime = 0;

    tickRef.current = (time: number): void => {
      // Poll dimensions each frame
      if (parent) {
        const w = parent.clientWidth;
        const h = parent.clientHeight;
        sizeCanvas(w, h);
        const { cols, rows } = computeGridSize(w, h);
        if (cols !== lastCols || rows !== lastRows) {
          if (stateRef.current) {
            resizeCells(stateRef.current, cols, rows);
          }
          lastCols = cols;
          lastRows = rows;
        }
      }

      const delta = lastTime === 0 ? 0.016 : (time - lastTime) / 1000;
      lastTime = time;

      if (stateRef.current) {
        updateState(stateRef.current, Math.min(delta, 0.1));
      }
      tryRender();
    };

    const mutationObserver = new MutationObserver(() => {
      colorsRef.current = readThemeColors();
    });
    mutationObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => {
      tickRef.current = null;
      mutationObserver.disconnect();
    };
  }, [frozen, messages, themeOverride, cipherOpacity, messageRowOffset, messageColOffset]);

  useAnimationFrame(
    (time) => {
      tickRef.current?.(time);
    },
    { paused: frozen }
  );

  React.useEffect(() => {
    if (stateRef.current) {
      stateRef.current.exclusionZone = exclusionZone;
      if (exclusionZone) {
        pruneExcludedReveals(stateRef.current);
      }
    }
  }, [exclusionZone]);

  return canvasRef;
}
