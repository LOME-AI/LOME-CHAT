import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createCanvas, GlobalFonts, loadImage, type Image } from '@napi-rs/canvas';
import { getBrandColors } from './readme/brand.js';
import { withCache } from './readme/cache.js';
import { isMainModule } from './lib/is-main.js';

/** Open Graph card dimensions mandated by Facebook/Twitter for `summary_large_image`. */
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** Tagline rendered on the card. Source of truth for the marketing OG image copy. */
export const OG_TAGLINE = 'One interface. Every feature. Private.';

const WORDMARK_TEXT = 'HushBox';
const WORDMARK_FONT_SIZE = 96;
const TAGLINE_FONT_SIZE = 40;
const LOGO_SIZE = 220;
const SANS_FONT_FAMILY = 'Merriweather';

const REPO_FONTS_DIR_FROM_ROOT = 'apps/web/public/fonts';
const LOGO_PATH_FROM_ROOT = 'packages/ui/src/assets/HushBoxLogo.png';

/**
 * Register the same web font the browser uses so the Node-side canvas renders
 * the wordmark with matching glyph metrics. Mirrors generate-banner.ts.
 */
function registerFonts(root: string): void {
  GlobalFonts.registerFromPath(
    path.join(root, REPO_FONTS_DIR_FROM_ROOT, 'merriweather-latin.woff2'),
    SANS_FONT_FAMILY
  );
}

function renderOgImage(brandRed: string, logo: Image): Buffer {
  const canvas = createCanvas(OG_WIDTH, OG_HEIGHT);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = brandRed;
  ctx.fillRect(0, 0, OG_WIDTH, OG_HEIGHT);

  const centerX = OG_WIDTH / 2;
  const logoY = 120;
  // The brand logo mark is red-on-transparent, which vanishes against the red
  // card. Recolor its opaque pixels white via source-in compositing on an
  // offscreen canvas, then draw the white mark onto the card.
  const logoCanvas = createCanvas(LOGO_SIZE, LOGO_SIZE);
  const logoCtx = logoCanvas.getContext('2d');
  logoCtx.drawImage(logo, 0, 0, LOGO_SIZE, LOGO_SIZE);
  logoCtx.globalCompositeOperation = 'source-in';
  logoCtx.fillStyle = '#ffffff';
  logoCtx.fillRect(0, 0, LOGO_SIZE, LOGO_SIZE);
  ctx.drawImage(logoCanvas, centerX - LOGO_SIZE / 2, logoY);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';

  ctx.font = `bold ${String(WORDMARK_FONT_SIZE)}px "${SANS_FONT_FAMILY}"`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(WORDMARK_TEXT, centerX, logoY + LOGO_SIZE + 110);

  ctx.font = `${String(TAGLINE_FONT_SIZE)}px "${SANS_FONT_FAMILY}"`;
  ctx.fillText(OG_TAGLINE, centerX, logoY + LOGO_SIZE + 180);

  return canvas.toBuffer('image/png');
}

/**
 * Files whose contents determine the OG image output. A change to any of these
 * invalidates the cache and forces regeneration.
 */
export function collectOgInputs(repoRoot: string): string[] {
  return [
    path.join(repoRoot, 'scripts/generate-og-image.ts'),
    path.join(repoRoot, 'scripts/readme/brand.ts'),
    path.join(repoRoot, 'packages/config/tailwind/index.css'),
    path.join(repoRoot, LOGO_PATH_FROM_ROOT),
    path.join(repoRoot, REPO_FONTS_DIR_FROM_ROOT, 'merriweather-latin.woff2'),
  ];
}

/**
 * Generate `og-default.png` into outputDir. Cached against its inputs.
 *
 * Async because @napi-rs/canvas only decodes image pixels through loadImage;
 * the synchronous `new Image().src = buffer` path populates width/height from
 * the PNG header but leaves the bitmap empty, so the logo mark would render
 * blank. The decode runs before withCache so its body stays synchronous.
 */
export async function generateOgDefault(outputDir: string, repoRoot?: string): Promise<void> {
  const root = repoRoot ?? process.cwd();
  const output = path.join(outputDir, 'og-default.png');
  const brand = getBrandColors(root);
  const logo = await loadImage(path.join(root, LOGO_PATH_FROM_ROOT));

  withCache(
    {
      label: 'OG image',
      hashPath: path.join(root, '.github/readme/.cache/og-image.hash'),
      inputs: collectOgInputs(root),
      outputs: [output],
    },
    () => {
      mkdirSync(outputDir, { recursive: true });
      registerFonts(root);
      writeFileSync(output, renderOgImage(brand.light.brandRed, logo));
    }
  );
}

const DEFAULT_OUTPUT = path.resolve(import.meta.dirname, '../apps/marketing/public');

/* v8 ignore start -- CLI entry point */
if (isMainModule(import.meta.url)) {
  await generateOgDefault(DEFAULT_OUTPUT);
}
/* v8 ignore stop */
