import { test as setup, expect } from '@playwright/test';
import type { DevPersonasResponse, DevPersona } from '@lome-chat/shared';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authDir = path.join(__dirname, '.auth');
const API_URL = 'http://localhost:8787';

// Ensure auth directory exists
setup.beforeAll(() => {
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }
});

/**
 * Extracts the persona name from email (e.g., alice@dev.lome-chat.com → alice)
 */
function getPersonaName(persona: DevPersona): string {
  const match = /^([^@]+)@/.exec(persona.email);
  return match?.[1] ?? persona.id;
}

/**
 * Fetches test personas from the API (used for E2E tests to avoid polluting dev personas)
 */
async function fetchTestPersonas(): Promise<DevPersona[]> {
  const response = await fetch(`${API_URL}/dev/personas?type=test`);
  if (!response.ok) {
    throw new Error(`Failed to fetch test personas: ${String(response.status)}`);
  }
  const data = (await response.json()) as DevPersonasResponse;
  return data.personas;
}

// Setup test that authenticates each verified test persona
setup('authenticate all personas', async ({ page }) => {
  // Fetch test personas from API (separate from dev personas to avoid data pollution)
  const personas = await fetchTestPersonas();

  // Only authenticate verified personas (unverified cannot log in)
  const verifiedPersonas = personas.filter((persona) => persona.emailVerified);

  expect(verifiedPersonas.length).toBeGreaterThan(0);

  for (const persona of verifiedPersonas) {
    const personaName = getPersonaName(persona);

    // Navigate to personas page with type=test to see test personas
    await page.goto('/dev/personas?type=test');

    // Wait for personas to load
    await page.waitForSelector(`[data-persona="${persona.id}"]`);

    // Click the persona card
    await page.click(`[data-persona="${persona.id}"]`);

    // Wait for navigation to /chat (successful login) or error message
    try {
      await page.waitForURL('/chat', { timeout: 15000 });
    } catch {
      // If we didn't navigate, check for error state
      const pageContent = await page.content();
      console.error(`Login failed for ${personaName}. Page content:`, pageContent.slice(0, 1000));
      throw new Error(`Login failed for ${personaName} - did not navigate to /chat`);
    }

    // Save storage state for this persona
    await page.context().storageState({ path: path.join(authDir, `${personaName}.json`) });

    // Clear storage state for next persona
    await page.context().clearCookies();
  }
});
