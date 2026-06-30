import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getBrandColors, type ThemeColors } from './brand.js';
import { withCache } from './cache.js';
import { isMainModule } from '../lib/is-main.js';

const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

const STEPS = [
  { number: '1', text: 'New model drops' },
  { number: '2', text: 'Sign up, pay' },
  { number: '3', text: 'Learn another UI' },
  { number: '4', text: 'History stuck' },
  { number: '5', text: 'Repeat' },
] as const;

const WIDTH = 960;
const HEIGHT = 200;

/**
 * Generate a horizontal cycle of 5 numbered steps, connected by arrows, with a
 * dashed loop-back arrow from the last step to the first. Static (no animation).
 */
export function generateProblemFlowSvg(theme: ThemeColors): string {
  const stepCount = STEPS.length;
  const outerPadding = 28;
  const boxGap = 18;
  const usableWidth = WIDTH - outerPadding * 2;
  const boxWidth = Math.floor((usableWidth - boxGap * (stepCount - 1)) / stepCount);
  const boxHeight = 72;
  const boxY = 72;

  const boxes = STEPS.map((step, index) => {
    const x = outerPadding + index * (boxWidth + boxGap);
    return `
    <g>
      <rect x="${String(x)}" y="${String(boxY)}" width="${String(boxWidth)}" height="${String(boxHeight)}" rx="10" fill="${theme.backgroundPaper}" stroke="${theme.border}" stroke-width="1.5"/>
      <text x="${String(x + 20)}" y="${String(boxY + 44)}" font-family='${FONT_STACK}' font-size="28" font-weight="700" fill="${theme.brandRed}">${step.number}</text>
      <text x="${String(x + 48)}" y="${String(boxY + boxHeight / 2 + 5)}" font-family='${FONT_STACK}' font-size="13" font-weight="500" fill="${theme.foreground}">${escapeXml(step.text)}</text>
    </g>`;
  }).join('');

  const arrows = STEPS.slice(0, -1)
    .map((_, index) => {
      const startX = outerPadding + index * (boxWidth + boxGap) + boxWidth;
      const endX = outerPadding + (index + 1) * (boxWidth + boxGap);
      const y = boxY + boxHeight / 2;
      return `<line x1="${String(startX + 4)}" y1="${String(y)}" x2="${String(endX - 6)}" y2="${String(y)}" stroke="${theme.foregroundMuted}" stroke-width="1.5" marker-end="url(#arrow-right)"/>`;
    })
    .join('');

  // Dashed loop-back from last box bottom-center to first box bottom-center
  const firstBoxCenterX = outerPadding + boxWidth / 2;
  const lastBoxCenterX = outerPadding + (stepCount - 1) * (boxWidth + boxGap) + boxWidth / 2;
  const loopBack = `
    <path d="M ${String(lastBoxCenterX)} ${String(boxY + boxHeight + 2)}
             Q ${String(lastBoxCenterX)} ${String(HEIGHT - 18)}
               ${String((lastBoxCenterX + firstBoxCenterX) / 2)} ${String(HEIGHT - 18)}
             Q ${String(firstBoxCenterX)} ${String(HEIGHT - 18)}
               ${String(firstBoxCenterX)} ${String(boxY + boxHeight + 2)}"
          fill="none" stroke="${theme.brandRed}" stroke-width="1.5" stroke-dasharray="4 4" marker-end="url(#arrow-red)"/>
  `;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(WIDTH)} ${String(HEIGHT)}" width="100%">
  <defs>
    <marker id="arrow-right" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="${theme.foregroundMuted}"/>
    </marker>
    <marker id="arrow-red" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="${theme.brandRed}"/>
    </marker>
  </defs>
  <rect x="0.5" y="0.5" width="${String(WIDTH - 1)}" height="${String(HEIGHT - 1)}" rx="12" fill="${theme.background}" stroke="${theme.border}"/>
  <text x="${String(WIDTH / 2)}" y="40" font-family='${FONT_STACK}' font-size="12" font-weight="600" fill="${theme.foregroundMuted}" text-anchor="middle" letter-spacing="0.2em">THE AI SUBSCRIPTION CYCLE</text>
  ${arrows}
  ${boxes}
  ${loopBack}
</svg>`;
}

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Files whose contents determine the problem-flow output. */
export function collectProblemFlowInputs(repoRoot: string): string[] {
  return [
    path.join(repoRoot, 'scripts/readme/generate-problem-flow.ts'),
    path.join(repoRoot, 'scripts/readme/brand.ts'),
    path.join(repoRoot, 'packages/config/tailwind/index.css'),
  ];
}

export function generateProblemFlows(outputDir: string, repoRoot?: string): void {
  const root = repoRoot ?? process.cwd();
  const lightOut = path.join(outputDir, 'problem-flow-light.svg');
  const darkOut = path.join(outputDir, 'problem-flow-dark.svg');

  withCache(
    {
      label: 'Problem flow',
      hashPath: path.join(root, '.github/readme/.cache/problem-flow.hash'),
      inputs: collectProblemFlowInputs(root),
      outputs: [lightOut, darkOut],
    },
    () => {
      mkdirSync(outputDir, { recursive: true });
      const brand = getBrandColors(root);
      writeFileSync(lightOut, generateProblemFlowSvg(brand.light));
      writeFileSync(darkOut, generateProblemFlowSvg(brand.dark));
      console.log(`✓ Generated 2 problem-flow SVGs in ${outputDir}`);
    }
  );
}

const DEFAULT_OUTPUT = path.resolve(import.meta.dirname, '../../.github/readme');

/* v8 ignore start -- CLI wiring; the generator is covered via unit tests */
const isMain = isMainModule(import.meta.url);
if (isMain) generateProblemFlows(DEFAULT_OUTPUT);
/* v8 ignore stop */
