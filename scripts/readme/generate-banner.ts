import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import GIFEncoder from 'gif-encoder-2';
import seedrandom from 'seedrandom';
import { LANDING_CIPHER_MESSAGES } from '@hushbox/shared/cipher-messages';
import { isMainModule } from '../lib/is-main.js';
import {
  createGrid,
  seedInitialReveals,
  renderFrame,
  updateState,
  CELL_WIDTH,
  CELL_HEIGHT,
  EXCLUSION_STRIDE,
  type ThemeColors as EngineColors,
} from '../../packages/ui/src/components/cipher-wall/cipher-wall-engine.js';
import { getBrandColors, type ThemeColors } from './brand.js';
import { withCache } from './cache.js';

const DISPLAY_WIDTH = 800;
const DISPLAY_HEIGHT = 220;
const DPR = 2;
const FPS = 10;
const DURATION_SECONDS = 40; // long enough to cycle through all 16 engine messages
const SEED_ADVANCE_FRAMES = 30;
const CROSSFADE_FRAMES = 12; // ~1.2s blend at end of loop back to start — hides the seam

const REPO_FONTS_DIR = path.resolve(import.meta.dirname, '../../apps/web/public/fonts');
const MONO_FONT_FAMILY = 'JetBrains Mono';
const SANS_FONT_FAMILY = 'Merriweather';
const WORDMARK_FONT_SIZE = 48;

/**
 * Oval dimensions in display coordinates (scaled by DPR at render time).
 * Exclusion zone uses these same dimensions. Pushing OVAL_RY above ~50 starts
 * blocking rows 2 and 7 (the only rows the engine can place messages in after
 * MARGIN_ROWS=2 on a 10-row grid), which kills the animation.
 */
const OVAL_RX = 260;
const OVAL_RY = 50;

/**
 * Register the same web fonts the browser uses, so the Node-side canvas renders
 * characters with the same glyph metrics as the React CipherWall on the marketing
 * site. Reading from apps/web/public/fonts/ avoids duplicating font files.
 */
function registerFonts(): void {
  GlobalFonts.registerFromPath(
    path.join(REPO_FONTS_DIR, 'jetbrains-mono-latin.woff2'),
    MONO_FONT_FAMILY
  );
  GlobalFonts.registerFromPath(
    path.join(REPO_FONTS_DIR, 'merriweather-latin.woff2'),
    SANS_FONT_FAMILY
  );
}

export function patchCryptoWithSeed(seed: string): void {
  const rng = seedrandom(seed);
  (globalThis as unknown as { crypto: Crypto }).crypto.getRandomValues = <
    T extends ArrayBufferView,
  >(
    buffer: T
  ): T => {
    const view = buffer as unknown as { length: number; [index: number]: number };
    for (let index = 0; index < view.length; index++) {
      view[index] = Math.floor(rng() * 0x1_00_00_00_00) >>> 0;
    }
    return buffer;
  };
}

function toEngineColors(theme: ThemeColors): EngineColors {
  return {
    background: theme.background,
    foreground: theme.foreground,
    foregroundMuted: theme.foregroundMuted,
    brandRed: theme.brandRed,
  };
}

function hexToRgba(hex: string, alpha: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${String(r)}, ${String(g)}, ${String(b)}, ${alpha.toFixed(3)})`;
}

/**
 * Compute exclusion zone as an oval centered on the wordmark. Cells whose
 * centers fall inside the scaled ellipse (plus ~10% padding) are excluded
 * from reveal spawning. Mirrors computeExclusionZone from cipher-wall.tsx.
 */
export interface OvalExclusionParameters {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export function computeOvalExclusion(parameters: OvalExclusionParameters): Set<number> {
  const { cols, rows, cellW, cellH, cx, cy, rx, ry } = parameters;
  const zone = new Set<number>();
  const THRESHOLD_SQ = 1.21; // 1.1² — matches marketing's EXCLUSION_THRESHOLD_SQ
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = c * cellW + cellW / 2;
      const py = r * cellH + cellH / 2;
      const dx = (px - cx) / rx;
      const dy = (py - cy) / ry;
      if (dx * dx + dy * dy <= THRESHOLD_SQ) {
        zone.add(r * EXCLUSION_STRIDE + c);
      }
    }
  }
  return zone;
}

export interface GenerateBannerGifOptions {
  seed: string;
  displayWidth?: number;
  displayHeight?: number;
  fps?: number;
  durationSeconds?: number;
}

interface BannerDimensions {
  dispW: number;
  dispH: number;
  internalW: number;
  internalH: number;
  cellW: number;
  cellH: number;
  fps: number;
  totalFrames: number;
  dt: number;
}

function resolveDimensions(options: GenerateBannerGifOptions): BannerDimensions {
  const dispW = options.displayWidth ?? DISPLAY_WIDTH;
  const dispH = options.displayHeight ?? DISPLAY_HEIGHT;
  const fps = options.fps ?? FPS;
  const durationSeconds = options.durationSeconds ?? DURATION_SECONDS;
  return {
    dispW,
    dispH,
    internalW: dispW * DPR,
    internalH: dispH * DPR,
    cellW: CELL_WIDTH * DPR,
    cellH: CELL_HEIGHT * DPR,
    fps,
    totalFrames: fps * durationSeconds,
    dt: 1 / fps,
  };
}

function drawWordmark(
  ictx: ReturnType<typeof createCanvas>['getContext'] extends (id: '2d') => infer C ? C : never,
  theme: ThemeColors,
  dimensions: Pick<BannerDimensions, 'dispW' | 'dispH'>
): void {
  const { dispW, dispH } = dimensions;

  // Radial oval fade behind the wordmark: opaque bg at center, fading to
  // transparent at the rim. Matches the marketing site's fadeMask="radial".
  ictx.save();
  ictx.translate(dispW / 2, dispH / 2);
  ictx.scale(OVAL_RX / OVAL_RY, 1);
  const gradient = ictx.createRadialGradient(0, 0, 0, 0, 0, OVAL_RY);
  gradient.addColorStop(0, theme.background);
  gradient.addColorStop(0.55, theme.background);
  gradient.addColorStop(1, hexToRgba(theme.background, 0));
  ictx.fillStyle = gradient as unknown as CanvasGradient;
  ictx.beginPath();
  ictx.arc(0, 0, OVAL_RY, 0, Math.PI * 2);
  ictx.fill();
  ictx.restore();

  ictx.save();
  ictx.font = `bold ${String(WORDMARK_FONT_SIZE)}px "${SANS_FONT_FAMILY}"`;
  ictx.textAlign = 'center';
  ictx.textBaseline = 'middle';
  ictx.fillStyle = theme.brandRed;
  ictx.fillText('HushBox', dispW / 2, dispH / 2);
  ictx.restore();

  // Composite theme.background behind everything so cipher-char alpha
  // blends into the final pixel color.
  ictx.save();
  ictx.globalCompositeOperation = 'destination-over';
  ictx.fillStyle = theme.background;
  ictx.fillRect(0, 0, dispW, dispH);
  ictx.restore();
}

interface CrossfadeParameters {
  ectx: ReturnType<typeof createCanvas>['getContext'] extends (id: '2d') => infer C ? C : never;
  target: Uint8ClampedArray;
  blendT: number;
  dispW: number;
  dispH: number;
}

function blendCrossfadeFrame(parameters: CrossfadeParameters): void {
  const { ectx, target, blendT, dispW, dispH } = parameters;
  const imageData = ectx.getImageData(0, 0, dispW, dispH);
  const data = imageData.data;
  const oneMinusT = 1 - blendT;
  /* v8 ignore start -- index is bounded by data.length and target is the same size, so every pixel lookup is defined */
  for (let index = 0; index < data.length; index += 4) {
    data[index] = Math.round((data[index] ?? 0) * oneMinusT + (target[index] ?? 0) * blendT);
    data[index + 1] = Math.round(
      (data[index + 1] ?? 0) * oneMinusT + (target[index + 1] ?? 0) * blendT
    );
    data[index + 2] = Math.round(
      (data[index + 2] ?? 0) * oneMinusT + (target[index + 2] ?? 0) * blendT
    );
  }
  /* v8 ignore stop */
  ectx.putImageData(imageData, 0, 0);
}

export function generateBannerGif(
  outputPath: string,
  theme: ThemeColors,
  options?: GenerateBannerGifOptions
): void {
  const resolvedOptions = options ?? { seed: 'hushbox' };
  const dimensions = resolveDimensions(resolvedOptions);
  const { dispW, dispH, internalW, internalH, cellW, cellH, fps, totalFrames, dt } = dimensions;

  patchCryptoWithSeed(resolvedOptions.seed);

  const cols = Math.floor(internalW / cellW);
  const rows = Math.floor(internalH / cellH);
  const state = createGrid(cols, rows, LANDING_CIPHER_MESSAGES);

  // Exclusion oval is tighter than the visual oval so messages don't spawn
  // under the wordmark but rows above and below remain placeable.
  state.exclusionZone = computeOvalExclusion({
    cols,
    rows,
    cellW,
    cellH,
    cx: internalW / 2,
    cy: internalH / 2,
    rx: OVAL_RX * DPR,
    ry: OVAL_RY * DPR,
  });

  seedInitialReveals(state);
  for (let index = 0; index < SEED_ADVANCE_FRAMES; index++) {
    updateState(state, dt);
  }

  const internalCanvas = createCanvas(internalW, internalH);
  const ictx = internalCanvas.getContext('2d');
  ictx.scale(DPR, DPR);

  const encodeCanvas = createCanvas(dispW, dispH);
  const ectx = encodeCanvas.getContext('2d');

  const engineColors = toEngineColors(theme);

  const encoder = new GIFEncoder(dispW, dispH, 'octree', true);
  encoder.setDelay(Math.round(1000 / fps));
  encoder.setRepeat(0);
  encoder.setQuality(10);
  const bgInt = Number.parseInt(theme.background.slice(1), 16);
  encoder.setTransparent(bgInt);
  encoder.start();

  const earlyFrames: Uint8ClampedArray[] = [];
  const crossfadeStart = totalFrames - CROSSFADE_FRAMES;

  for (let frame = 0; frame < totalFrames; frame++) {
    renderFrame({
      ctx: ictx as unknown as CanvasRenderingContext2D,
      state,
      colors: engineColors,
      width: dispW,
      height: dispH,
      logoMask: null,
      cipherOpacity: 1,
    });

    drawWordmark(ictx, theme, { dispW, dispH });

    ectx.fillStyle = theme.background;
    ectx.fillRect(0, 0, dispW, dispH);
    ectx.drawImage(internalCanvas, 0, 0, dispW, dispH);

    if (frame < CROSSFADE_FRAMES) {
      earlyFrames.push(new Uint8ClampedArray(ectx.getImageData(0, 0, dispW, dispH).data));
    }

    if (frame >= crossfadeStart) {
      const targetIndex = frame - crossfadeStart;
      const blendT = (targetIndex + 1) / CROSSFADE_FRAMES;
      const target = earlyFrames[targetIndex];
      if (target) {
        blendCrossfadeFrame({ ectx, target, blendT, dispW, dispH });
      }
    }

    encoder.addFrame(ectx as unknown as CanvasRenderingContext2D);
    updateState(state, dt);
  }

  encoder.finish();
  const buffer = encoder.out.getData();
  writeFileSync(outputPath, buffer);
}

/**
 * Sanity check: simulate the engine over the intended duration and count how
 * many distinct reveals were placed. Used by tests to guard against the
 * exclusion-zone-too-large regression that killed animation.
 */
export interface CountPlacedRevealsOptions {
  seed: string;
  durationSeconds?: number;
}

export function countPlacedReveals(
  _theme: ThemeColors,
  options?: CountPlacedRevealsOptions
): number {
  const resolvedOptions = options ?? { seed: 'count' };
  const durationSeconds = resolvedOptions.durationSeconds ?? DURATION_SECONDS;
  const dt = 1 / FPS;
  const totalFrames = FPS * durationSeconds;
  const internalW = DISPLAY_WIDTH * DPR;
  const internalH = DISPLAY_HEIGHT * DPR;
  const cellW = CELL_WIDTH * DPR;
  const cellH = CELL_HEIGHT * DPR;

  patchCryptoWithSeed(resolvedOptions.seed);

  const cols = Math.floor(internalW / cellW);
  const rows = Math.floor(internalH / cellH);
  const state = createGrid(cols, rows, LANDING_CIPHER_MESSAGES);
  state.exclusionZone = computeOvalExclusion({
    cols,
    rows,
    cellW,
    cellH,
    cx: internalW / 2,
    cy: internalH / 2,
    rx: OVAL_RX * DPR,
    ry: OVAL_RY * DPR,
  });

  seedInitialReveals(state);
  const seenStartIndices = new Set<number>();
  for (const r of state.reveals) seenStartIndices.add(r.startIndex);

  for (let frame = 0; frame < totalFrames; frame++) {
    updateState(state, dt);
    for (const r of state.reveals) seenStartIndices.add(r.startIndex);
  }

  return seenStartIndices.size;
}

/**
 * Files whose contents determine the banner output. Swapping a web font or
 * touching the cipher-wall engine invalidates the cache and forces rerender.
 */
export function collectBannerInputs(repoRoot: string): string[] {
  return [
    path.join(repoRoot, 'scripts/readme/generate-banner.ts'),
    path.join(repoRoot, 'scripts/readme/brand.ts'),
    path.join(repoRoot, 'packages/ui/src/components/cipher-wall/cipher-wall-engine.ts'),
    path.join(repoRoot, 'packages/shared/src/cipher-messages.ts'),
    path.join(repoRoot, 'packages/config/tailwind/index.css'),
    path.join(repoRoot, 'apps/web/public/fonts/jetbrains-mono-latin.woff2'),
    path.join(repoRoot, 'apps/web/public/fonts/merriweather-latin.woff2'),
  ];
}

export function generateBanners(outputDir: string, repoRoot?: string): void {
  const root = repoRoot ?? process.cwd();
  const darkGif = path.join(outputDir, 'banner-dark.gif');
  const lightGif = path.join(outputDir, 'banner-light.gif');

  withCache(
    {
      label: 'Banner',
      hashPath: path.join(root, '.github/readme/.cache/banner.hash'),
      inputs: collectBannerInputs(root),
      outputs: [darkGif, lightGif],
    },
    () => {
      mkdirSync(outputDir, { recursive: true });
      registerFonts();
      const brand = getBrandColors(root);
      generateBannerGif(darkGif, brand.dark, { seed: 'hushbox-banner-dark' });
      generateBannerGif(lightGif, brand.light, { seed: 'hushbox-banner-light' });
      console.log(`✓ Generated banner GIFs in ${outputDir}`);
    }
  );
}

const DEFAULT_OUTPUT = path.resolve(import.meta.dirname, '../../.github/readme');

/* v8 ignore start -- CLI wiring; generateBanners is covered via unit tests */
const isMain = isMainModule(import.meta.url);
if (isMain) generateBanners(DEFAULT_OUTPUT);
/* v8 ignore stop */
