import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as lucideStatic from 'lucide-static';
import { isMainModule } from '../lib/is-main.js';
import { TOTAL_FEE_RATE } from '../../packages/shared/src/constants.js';
import { FEE_CATEGORIES, formatFeePercent } from '../../packages/shared/src/fees.js';
import {
  FREE_ALLOWANCE_CENTS_VALUE,
  TRIAL_MESSAGE_LIMIT,
} from '../../packages/shared/src/tiers.js';
import { COMPARISON_ROWS } from '../../packages/shared/src/comparison.js';
import { SHIPPED_FEATURES, COMING_SOON_FEATURES } from '../../packages/shared/src/features.js';
import { getBrandColors, type ThemeColors } from './brand.js';
import { withCache } from './cache.js';

const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const ROW_HEIGHT = 48;
const HEADER_HEIGHT = 56;
const PADDING_X = 24;
const RADIUS = 12;

interface TableOptions {
  width: number;
  theme: ThemeColors;
}

function checkMark(x: number, y: number, color: string): string {
  return `<path d="M${String(x - 7)} ${String(y)} L${String(x - 2)} ${String(y + 5)} L${String(x + 7)} ${String(y - 4)}" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
}

function crossMark(x: number, y: number, color: string): string {
  return `<path d="M${String(x - 5)} ${String(y - 5)} L${String(x + 5)} ${String(y + 5)} M${String(x + 5)} ${String(y - 5)} L${String(x - 5)} ${String(y + 5)}" stroke="${color}" stroke-width="2.5" stroke-linecap="round" fill="none"/>`;
}

interface SectionLabelParameters {
  x: number;
  y: number;
  color: string;
  label: string;
  fontSize?: number;
}

function sectionLabel(parameters: SectionLabelParameters): string {
  const { x, y, color, label, fontSize = 13 } = parameters;
  return `<text x="${String(x)}" y="${String(y)}" font-family='${FONT_STACK}' font-size="${String(fontSize)}" font-weight="600" fill="${color}" letter-spacing="0.08em">${label}</text>`;
}

export function generateComparisonSvg(options: TableOptions): string {
  const { width, theme } = options;
  const rowCount = COMPARISON_ROWS.length;
  const height = HEADER_HEIGHT + rowCount * ROW_HEIGHT + 16;

  const col1Width = width * 0.6;
  const col2X = col1Width + (width - col1Width) * 0.25;
  const col3X = col1Width + (width - col1Width) * 0.75;

  const rows = COMPARISON_ROWS.map((row, index) => {
    const y = HEADER_HEIGHT + index * ROW_HEIGHT;
    const midY = y + ROW_HEIGHT / 2;
    const textY = midY + 5;
    const stripe =
      index % 2 === 0
        ? `<rect x="0" y="${String(y)}" width="${String(width)}" height="${String(ROW_HEIGHT)}" fill="${theme.backgroundPaper}"/>`
        : '';
    /* v8 ignore next 3 -- every COMPARISON_ROW has others:false, so the checkMark side is dead for this data */
    const others = row.others
      ? checkMark(col2X, midY, theme.brandRed)
      : crossMark(col2X, midY, theme.foregroundMuted);
    /* v8 ignore next 3 -- every COMPARISON_ROW has hushbox:true, so the crossMark side is dead for this data */
    const hushbox = row.hushbox
      ? checkMark(col3X, midY, theme.brandRed)
      : crossMark(col3X, midY, theme.foregroundMuted);
    return `
    ${stripe}
    <text x="${String(PADDING_X)}" y="${String(textY)}" font-family='${FONT_STACK}' font-size="15" fill="${theme.foreground}">${escapeXml(row.label)}</text>
    ${others}
    ${hushbox}`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(width)} ${String(height)}" width="100%">
  <rect x="0.5" y="0.5" width="${String(width - 1)}" height="${String(height - 1)}" rx="${String(RADIUS)}" fill="${theme.background}" stroke="${theme.border}"/>
  <text x="${String(PADDING_X)}" y="35" font-family='${FONT_STACK}' font-size="13" font-weight="600" fill="${theme.foregroundMuted}" letter-spacing="0.08em" text-transform="uppercase">FEATURE</text>
  <text x="${String(col2X)}" y="35" font-family='${FONT_STACK}' font-size="13" font-weight="600" fill="${theme.foregroundMuted}" text-anchor="middle" letter-spacing="0.08em">OTHERS</text>
  <text x="${String(col3X)}" y="35" font-family='${FONT_STACK}' font-size="13" font-weight="600" fill="${theme.brandRed}" text-anchor="middle" letter-spacing="0.08em">HUSHBOX</text>
  <line x1="0" y1="${String(HEADER_HEIGHT - 1)}" x2="${String(width)}" y2="${String(HEADER_HEIGHT - 1)}" stroke="${theme.border}"/>
  ${rows}
</svg>`;
}

export function generatePricingSvg(options: TableOptions): string {
  const { width, theme } = options;
  const rows: { label: string; rate: string; desc: string; isTotal?: boolean }[] = [
    ...FEE_CATEGORIES.map((category) => ({
      label: category.shortLabel,
      rate: formatFeePercent(category.rate),
      desc: category.description,
    })),
    {
      label: 'Total',
      rate: formatFeePercent(TOTAL_FEE_RATE),
      desc: 'On AI model usage',
      isTotal: true,
    },
  ];
  const height = HEADER_HEIGHT + rows.length * ROW_HEIGHT + 16;

  const rateX = width * 0.5;
  const descX = width * 0.58;

  const body = rows
    .map((row, index) => {
      const y = HEADER_HEIGHT + index * ROW_HEIGHT;
      const midY = y + ROW_HEIGHT / 2;
      const textY = midY + 5;
      const isTotal = row.isTotal === true;
      const stripe =
        index % 2 === 0 && !isTotal
          ? `<rect x="0" y="${String(y)}" width="${String(width)}" height="${String(ROW_HEIGHT)}" fill="${theme.backgroundPaper}"/>`
          : '';
      const topBorder = isTotal
        ? `<line x1="0" y1="${String(y)}" x2="${String(width)}" y2="${String(y)}" stroke="${theme.border}"/>`
        : '';
      const weight = isTotal ? '700' : '500';
      const rateColor = isTotal ? theme.brandRed : theme.foreground;
      return `
    ${stripe}
    ${topBorder}
    <text x="${String(PADDING_X)}" y="${String(textY)}" font-family='${FONT_STACK}' font-size="15" font-weight="${weight}" fill="${theme.foreground}">${escapeXml(row.label)}</text>
    <text x="${String(rateX)}" y="${String(textY)}" font-family='${FONT_STACK}' font-size="15" font-weight="${weight}" fill="${rateColor}" text-anchor="end">${escapeXml(row.rate)}</text>
    <text x="${String(descX)}" y="${String(textY)}" font-family='${FONT_STACK}' font-size="14" fill="${theme.foregroundMuted}">${escapeXml(row.desc)}</text>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(width)} ${String(height)}" width="100%">
  <rect x="0.5" y="0.5" width="${String(width - 1)}" height="${String(height - 1)}" rx="${String(RADIUS)}" fill="${theme.background}" stroke="${theme.border}"/>
  <text x="${String(PADDING_X)}" y="35" font-family='${FONT_STACK}' font-size="13" font-weight="600" fill="${theme.foregroundMuted}" letter-spacing="0.08em">SLICE</text>
  <text x="${String(rateX)}" y="35" font-family='${FONT_STACK}' font-size="13" font-weight="600" fill="${theme.foregroundMuted}" text-anchor="end" letter-spacing="0.08em">RATE</text>
  <text x="${String(descX)}" y="35" font-family='${FONT_STACK}' font-size="13" font-weight="600" fill="${theme.foregroundMuted}" letter-spacing="0.08em">WHAT IT COVERS</text>
  <line x1="0" y1="${String(HEADER_HEIGHT - 1)}" x2="${String(width)}" y2="${String(HEADER_HEIGHT - 1)}" stroke="${theme.border}"/>
  ${body}
</svg>`;
}

export function generateTiersSvg(options: TableOptions): string {
  const { width, theme } = options;
  const freeAllowance = `$${(FREE_ALLOWANCE_CENTS_VALUE / 100).toFixed(2)}`;

  const rows = [
    { label: 'Account required', values: ['No', 'Yes', 'Yes'] },
    { label: 'Models', values: ['Basic', 'Basic', 'All'] },
    {
      label: 'Daily limit',
      values: [
        `${String(TRIAL_MESSAGE_LIMIT)} messages`,
        `${freeAllowance} allowance`,
        'Your balance',
      ],
    },
    { label: 'History', values: ['None', 'Encrypted', 'Encrypted'] },
    { label: 'Group chats', values: ['No', 'Yes', 'Yes'] },
  ];
  const headers = ['Trial', 'Free', 'Paid'];
  const height = HEADER_HEIGHT + rows.length * ROW_HEIGHT + 16;

  const col1Width = width * 0.35;
  const tierColWidth = (width - col1Width) / 3;

  const headerRow = headers
    .map((h, index) => {
      const x = col1Width + tierColWidth * index + tierColWidth / 2;
      const color = index === 2 ? theme.brandRed : theme.foregroundMuted;
      return `<text x="${String(x)}" y="35" font-family='${FONT_STACK}' font-size="13" font-weight="600" fill="${color}" text-anchor="middle" letter-spacing="0.08em">${escapeXml(h.toUpperCase())}</text>`;
    })
    .join('');

  const body = rows
    .map((row, index) => {
      const y = HEADER_HEIGHT + index * ROW_HEIGHT;
      const midY = y + ROW_HEIGHT / 2;
      const textY = midY + 5;
      const stripe =
        index % 2 === 0
          ? `<rect x="0" y="${String(y)}" width="${String(width)}" height="${String(ROW_HEIGHT)}" fill="${theme.backgroundPaper}"/>`
          : '';
      const cells = row.values
        .map((v, index_) => {
          const x = col1Width + tierColWidth * index_ + tierColWidth / 2;
          return `<text x="${String(x)}" y="${String(textY)}" font-family='${FONT_STACK}' font-size="14" fill="${theme.foreground}" text-anchor="middle">${escapeXml(v)}</text>`;
        })
        .join('');
      return `
    ${stripe}
    <text x="${String(PADDING_X)}" y="${String(textY)}" font-family='${FONT_STACK}' font-size="15" font-weight="500" fill="${theme.foreground}">${escapeXml(row.label)}</text>
    ${cells}`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(width)} ${String(height)}" width="100%">
  <rect x="0.5" y="0.5" width="${String(width - 1)}" height="${String(height - 1)}" rx="${String(RADIUS)}" fill="${theme.background}" stroke="${theme.border}"/>
  ${headerRow}
  <line x1="0" y1="${String(HEADER_HEIGHT - 1)}" x2="${String(width)}" y2="${String(HEADER_HEIGHT - 1)}" stroke="${theme.border}"/>
  ${body}
</svg>`;
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const TECH_DETAILS: readonly { component: string; implementation: string }[] = [
  {
    component: 'Message encryption',
    implementation: 'XChaCha20-Poly1305 (AEAD) via @noble/ciphers',
  },
  { component: 'Key exchange', implementation: 'X25519 ECDH + HKDF-SHA256 via @noble/curves' },
  { component: 'Password auth', implementation: 'OPAQUE-P256 via @cloudflare/opaque-ts' },
  {
    component: 'Key derivation',
    implementation: 'Argon2id (64 MB, 3 iters, 4 threads) via hash-wasm',
  },
  {
    component: 'Recovery phrase',
    implementation: '12-word BIP39 mnemonic (128-bit entropy) via @scure/bip39',
  },
  { component: '2FA', implementation: 'TOTP with encrypted secret storage via otplib' },
  { component: 'Sessions', implementation: 'Encrypted cookies via iron-session' },
  { component: 'Compression', implementation: 'Raw deflate before encryption via fflate' },
];

const TECH_ROW_HEIGHT = 44;
const MONO_FONT_STACK =
  '"JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace';

export function generateTechnicalDetailsSvg(options: TableOptions): string {
  const { width, theme } = options;
  const rowCount = TECH_DETAILS.length;
  const height = HEADER_HEIGHT + rowCount * TECH_ROW_HEIGHT + 16;
  const componentX = PADDING_X;
  const implementationX = width * 0.32;

  const rows = TECH_DETAILS.map((row, index) => {
    const y = HEADER_HEIGHT + index * TECH_ROW_HEIGHT;
    const midY = y + TECH_ROW_HEIGHT / 2;
    const textY = midY + 5;
    const stripe =
      index % 2 === 0
        ? `<rect x="0" y="${String(y)}" width="${String(width)}" height="${String(TECH_ROW_HEIGHT)}" fill="${theme.backgroundPaper}"/>`
        : '';
    return `
    ${stripe}
    <text x="${String(componentX)}" y="${String(textY)}" font-family='${FONT_STACK}' font-size="14" font-weight="500" fill="${theme.foreground}">${escapeXml(row.component)}</text>
    <text x="${String(implementationX)}" y="${String(textY)}" font-family='${MONO_FONT_STACK}' font-size="12" fill="${theme.foregroundMuted}">${escapeXml(row.implementation)}</text>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(width)} ${String(height)}" width="100%">
  <rect x="0.5" y="0.5" width="${String(width - 1)}" height="${String(height - 1)}" rx="${String(RADIUS)}" fill="${theme.background}" stroke="${theme.border}"/>
  ${sectionLabel({ x: componentX, y: 35, color: theme.foregroundMuted, label: 'COMPONENT' })}
  ${sectionLabel({ x: implementationX, y: 35, color: theme.foregroundMuted, label: 'IMPLEMENTATION' })}
  <line x1="0" y1="${String(HEADER_HEIGHT - 1)}" x2="${String(width)}" y2="${String(HEADER_HEIGHT - 1)}" stroke="${theme.border}"/>
  ${rows}
</svg>`;
}

/** Extract the inner elements (paths, circles, etc) from a lucide-static SVG string. */
function extractIconInner(lucideIconName: string): string {
  const raw = (lucideStatic as Record<string, string>)[lucideIconName];
  /* v8 ignore next -- defensive: only ever called with icon names known to exist in lucide-static */
  if (!raw) throw new Error(`Lucide icon "${lucideIconName}" not found`);
  // Strip outer <svg ...> and closing </svg>, drop class attr/whitespace
  return raw
    .replace(/^\s*<svg[\s\S]*?>/, '')
    .replace(/<\/svg>\s*$/, '')
    .trim();
}

interface IconSvgParameters {
  lucideIconName: string;
  x: number;
  y: number;
  size: number;
  color: string;
}

function iconSvg(parameters: IconSvgParameters): string {
  const { lucideIconName, x, y, size, color } = parameters;
  const inner = extractIconInner(lucideIconName);
  return `<svg x="${String(x)}" y="${String(y)}" width="${String(size)}" height="${String(size)}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

export function generateFeatureCardsSvg(options: TableOptions): string {
  const { width, theme } = options;
  const cols = 3;
  const rows = Math.ceil(SHIPPED_FEATURES.length / cols);
  const cardPadding = 20;
  const cardSpacing = 16;
  const cardW = (width - cardSpacing * (cols - 1) - cardPadding * 2) / cols;
  const cardH = 130;
  const headerY = 44;
  const height = headerY + 20 + rows * (cardH + cardSpacing) - cardSpacing + cardPadding;

  const cards = SHIPPED_FEATURES.map((f, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const cx = cardPadding + col * (cardW + cardSpacing);
    const cy = headerY + 20 + row * (cardH + cardSpacing);

    const icon = iconSvg({
      lucideIconName: f.lucideIcon,
      x: cx + 20,
      y: cy + 20,
      size: 24,
      color: theme.brandRed,
    });

    // Word-wrap description at ~40 chars
    const words = f.description.split(' ');
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      if ((current + word).length > 38) {
        /* v8 ignore next -- no SHIPPED_FEATURES description opens with a >38-char word, so `current` is always non-empty here */
        if (current) lines.push(current.trim());
        current = `${word} `;
      } else {
        current += `${word} `;
      }
    }
    /* v8 ignore next -- every SHIPPED_FEATURES description leaves a non-empty trailing line */
    if (current) lines.push(current.trim());

    const descLines = lines
      .slice(0, 3)
      .map(
        (line, index_) =>
          `<text x="${String(cx + 20)}" y="${String(cy + 84 + index_ * 17)}" font-family='${FONT_STACK}' font-size="12" fill="${theme.foregroundMuted}">${escapeXml(line)}</text>`
      )
      .join('');

    return `
    <g>
      <rect x="${String(cx)}" y="${String(cy)}" width="${String(cardW)}" height="${String(cardH)}" rx="10" fill="${theme.backgroundPaper}" stroke="${theme.border}" stroke-width="1"/>
      ${icon}
      <text x="${String(cx + 20)}" y="${String(cy + 62)}" font-family='${FONT_STACK}' font-size="14" font-weight="600" fill="${theme.foreground}">${escapeXml(f.name)}</text>
      ${descLines}
    </g>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(width)} ${String(height)}" width="100%">
  <rect x="0.5" y="0.5" width="${String(width - 1)}" height="${String(height - 1)}" rx="${String(RADIUS)}" fill="${theme.background}" stroke="${theme.border}"/>
  ${sectionLabel({ x: cardPadding, y: headerY - 10, color: theme.foregroundMuted, label: 'SHIPPED FEATURES' })}
  ${cards}
</svg>`;
}

export function generateComingSoonSvg(options: TableOptions): string {
  const { width, theme } = options;
  const cols = 4;
  const rows = Math.ceil(COMING_SOON_FEATURES.length / cols);
  const cardPadding = 20;
  const cardSpacing = 12;
  const cardW = (width - cardSpacing * (cols - 1) - cardPadding * 2) / cols;
  const cardH = 64;
  const headerY = 44;
  const height = headerY + 20 + rows * (cardH + cardSpacing) - cardSpacing + cardPadding;

  const cards = COMING_SOON_FEATURES.map((f, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const cx = cardPadding + col * (cardW + cardSpacing);
    const cy = headerY + 20 + row * (cardH + cardSpacing);
    const icon = iconSvg({
      lucideIconName: f.lucideIcon,
      x: cx + 16,
      y: cy + 20,
      size: 20,
      color: theme.foregroundMuted,
    });
    return `
    <g>
      <rect x="${String(cx)}" y="${String(cy)}" width="${String(cardW)}" height="${String(cardH)}" rx="10" fill="none" stroke="${theme.border}" stroke-width="1" stroke-dasharray="4 4"/>
      ${icon}
      <text x="${String(cx + 48)}" y="${String(cy + 37)}" font-family='${FONT_STACK}' font-size="13" font-weight="500" fill="${theme.foreground}">${escapeXml(f.name)}</text>
    </g>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(width)} ${String(height)}" width="100%">
  <rect x="0.5" y="0.5" width="${String(width - 1)}" height="${String(height - 1)}" rx="${String(RADIUS)}" fill="${theme.background}" stroke="${theme.border}"/>
  ${sectionLabel({ x: cardPadding, y: headerY - 10, color: theme.foregroundMuted, label: 'COMING SOON' })}
  ${cards}
</svg>`;
}

/**
 * Files whose contents determine the table output.
 */
export function collectTableInputs(repoRoot: string): string[] {
  return [
    path.join(repoRoot, 'scripts/readme/generate-tables.ts'),
    path.join(repoRoot, 'scripts/readme/brand.ts'),
    path.join(repoRoot, 'packages/shared/src/features.ts'),
    path.join(repoRoot, 'packages/shared/src/comparison.ts'),
    path.join(repoRoot, 'packages/shared/src/constants.ts'),
    path.join(repoRoot, 'packages/shared/src/fees.ts'),
    path.join(repoRoot, 'packages/shared/src/tiers.ts'),
    path.join(repoRoot, 'packages/config/tailwind/index.css'),
    path.join(repoRoot, 'node_modules/lucide-static/package.json'),
  ];
}

const TABLE_BASENAMES = [
  'comparison',
  'pricing',
  'tiers',
  'features',
  'coming-soon',
  'technical-details',
] as const;

/**
 * Generate all table SVG files (comparison, pricing, tiers, features,
 * coming-soon, technical-details × dark/light). Cached: skips when inputs
 * and outputs are unchanged.
 */
export function generateTables(outputDir: string, repoRoot?: string): void {
  const root = repoRoot ?? process.cwd();
  const themes = [
    ['light', undefined as unknown as ThemeColors],
    ['dark', undefined as unknown as ThemeColors],
  ] as const;
  const outputs = themes.flatMap(([themeName]) =>
    TABLE_BASENAMES.map((name) => path.join(outputDir, `${name}-${themeName}.svg`))
  );

  withCache(
    {
      label: 'Tables',
      hashPath: path.join(root, '.github/readme/.cache/tables.hash'),
      inputs: collectTableInputs(root),
      outputs,
    },
    () => {
      mkdirSync(outputDir, { recursive: true });
      const brand = getBrandColors(root);
      const width = 960;

      for (const [themeName, theme] of [
        ['light', brand.light],
        ['dark', brand.dark],
      ] as const) {
        writeFileSync(
          path.join(outputDir, `comparison-${themeName}.svg`),
          generateComparisonSvg({ width, theme })
        );
        writeFileSync(
          path.join(outputDir, `pricing-${themeName}.svg`),
          generatePricingSvg({ width, theme })
        );
        writeFileSync(
          path.join(outputDir, `tiers-${themeName}.svg`),
          generateTiersSvg({ width, theme })
        );
        writeFileSync(
          path.join(outputDir, `features-${themeName}.svg`),
          generateFeatureCardsSvg({ width, theme })
        );
        writeFileSync(
          path.join(outputDir, `coming-soon-${themeName}.svg`),
          generateComingSoonSvg({ width, theme })
        );
        writeFileSync(
          path.join(outputDir, `technical-details-${themeName}.svg`),
          generateTechnicalDetailsSvg({ width, theme })
        );
      }

      console.log(`✓ Generated 12 table SVGs in ${outputDir}`);
    }
  );
}

const DEFAULT_OUTPUT = path.resolve(import.meta.dirname, '../../.github/readme');

/* v8 ignore start -- CLI wiring; the generator is covered via unit tests */
const isMain = isMainModule(import.meta.url);
if (isMain) generateTables(DEFAULT_OUTPUT);
/* v8 ignore stop */
