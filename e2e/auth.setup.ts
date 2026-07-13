import { test as setup, expect } from '@playwright/test';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_IDS } from '@hushbox/shared';
import { withRequestRetry } from './helpers/resilient-request.js';
import {
  BASE_TEST_PERSONAS,
  TEST_2FA_TOTP_SECRET,
  E2E_PROJECT_NAMES,
  testPersonaName,
  type E2EProjectName,
} from '../scripts/seed.js';
import { DEV_PASSWORD } from '../packages/shared/src/constants.js';
import { clearAuthRateLimits, generateTOTPCode } from './helpers/auth.js';
import { TIMEOUTS } from './config/timeouts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authDir = path.join(__dirname, '.auth');

const verifiedPersonas = BASE_TEST_PERSONAS.filter((p) => p.emailVerified);
const standardPersonas = verifiedPersonas.filter((p) => !p.totpSecret);
const twoFactorPersonas = verifiedPersonas.filter((p) => p.totpSecret);

/** `setup-chromium` → `chromium`. */
function projectFromSetupName(setupProjectName: string): E2EProjectName {
  const stripped = setupProjectName.replace(/^setup-/, '');
  const match = E2E_PROJECT_NAMES.find((p) => p === stripped);
  if (!match) {
    throw new Error(
      `auth.setup.ts: cannot map setup project "${setupProjectName}" to a known e2e project`
    );
  }
  return match;
}

function projectAuthDir(projectName: E2EProjectName): string {
  const dir = path.join(authDir, projectName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

setup.beforeAll(() => {
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }
});

interface FinishSetupArgs {
  context: import('@playwright/test').BrowserContext;
  page: import('@playwright/test').Page;
  project: E2EProjectName;
  basePersonaName: string;
  personaName: string;
}

async function finishSetup({
  context,
  page,
  project,
  basePersonaName,
  personaName,
}: FinishSetupArgs): Promise<void> {
  await page.waitForURL('/chat', { timeout: TIMEOUTS.ROUTE });

  const verifyResponse = await withRequestRetry(page.request).get('/conversations');
  if (verifyResponse.status() === 401) {
    throw new Error(
      `Session verification failed for ${personaName}: session not persisted in Redis`
    );
  }

  const outputPath = path.join(projectAuthDir(project), `${basePersonaName}.json`);
  await context.storageState({ path: outputPath });
  await context.close();
}

// Standard personas: fast login via persona card. Project-specific persona
// resolved at runtime from testInfo.project.name.
for (const basePersona of standardPersonas) {
  setup(`authenticate ${basePersona.name}`, async ({ browser, request }, testInfo) => {
    const project = projectFromSetupName(testInfo.project.name);
    const personaName = testPersonaName(basePersona.name, project);

    // The persona card performs a real OPAQUE login (`/auth/login/init`),
    // which is IP-rate-limited. Every setup project logs in from the same
    // localhost IP, so without clearing first the shared bucket accumulates
    // across all projects' logins, 429s mid-run, and strands the page off
    // `/chat`. The 2FA setup below clears for the same reason.
    await clearAuthRateLimits(request);

    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('/dev/personas?type=test', { waitUntil: 'domcontentloaded' });
    await page.locator(`[data-testid="persona-card-${personaName}"]`).click();

    await finishSetup({ context, page, project, basePersonaName: basePersona.name, personaName });
  });
}

for (const basePersona of twoFactorPersonas) {
  setup(`authenticate ${basePersona.name}`, async ({ browser, request }, testInfo) => {
    const project = projectFromSetupName(testInfo.project.name);
    const personaName = testPersonaName(basePersona.name, project);

    await clearAuthRateLimits(request);

    const context = await browser.newContext();
    const page = await context.newPage();

    const email = `${personaName}@test.hushbox.ai`;

    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Email or Username').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
    await page.getByLabel('Keep me signed in').check();
    await page.getByRole('button', { name: 'Log in' }).click();

    const otpModal = page.getByTestId(TEST_IDS.twoFactorInputModal);
    await expect(otpModal).toBeVisible({ timeout: TIMEOUTS.ROUTE });

    const code = generateTOTPCode(TEST_2FA_TOTP_SECRET);
    await otpModal.getByTestId(TEST_IDS.otpInput).pressSequentially(code);

    await finishSetup({ context, page, project, basePersonaName: basePersona.name, personaName });
  });
}
