import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// No DOM harness renders `.astro` files in this app, so hydration directives are
// asserted against the page source. This file lives outside `src/pages/` because
// Astro routes every file under that directory, so a page test placed there is
// built as a junk route.
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(currentDir, '../pages/blog/[slug].astro'), 'utf8');

describe('[slug].astro reader hydration', () => {
  it('hydrates BlogReadAloud at first paint, not on scroll', () => {
    // The control is on screen from first paint and is inert until its island
    // hydrates, so waiting on an intersection observer only lengthens the window
    // in which a click does nothing.
    expect(source).toContain('<BlogReadAloud client:load />');
    expect(source).not.toContain('<BlogReadAloud client:visible');
  });
});
