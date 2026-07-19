import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES } from '@hushbox/shared';

// Recurrence pin for the email-link↔page seam. The newsletter emails link
// humans at these marketing routes (confirmation → NEWSLETTER_CONFIRMED,
// visible unsubscribe → NEWSLETTER_UNSUBSCRIBED); if a route ever names a path
// with no Astro page behind it, the emailed link 404s — the exact class of bug
// where `/newsletter/confirm` (an API verb) once shipped as a human link.
// Deriving the expected page files from ROUTES makes that drift a failing test
// instead of a silent regression. Mirrors the CSP page-existence pin in
// scripts/generate-headers.test.ts.
//
// Lives outside src/pages/ for the same reason as the other page-tests: Astro
// routes every file under that directory.
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const pagesDir = path.resolve(currentDir, '../pages');

/** The Astro page files that can serve `route` (bare page or index page). */
function candidatePages(route: string): string[] {
  const relative = route.replace(/^\//, '');
  return [path.join(pagesDir, `${relative}.astro`), path.join(pagesDir, relative, 'index.astro')];
}

// Every newsletter route an email links a human to. Derived from ROUTES so a
// renamed constant drags this pin with it.
const EMAIL_LINKED_ROUTES = [ROUTES.NEWSLETTER_CONFIRMED, ROUTES.NEWSLETTER_UNSUBSCRIBED] as const;

describe('newsletter email-linked routes have marketing pages', () => {
  for (const route of EMAIL_LINKED_ROUTES) {
    it(`serves ${route} from a real Astro page`, () => {
      const served = candidatePages(route).some((file) => existsSync(file));
      expect(served).toBe(true);
    });
  }
});
