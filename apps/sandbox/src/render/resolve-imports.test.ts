import { describe, it, expect } from 'vitest';
import { rewriteBareImports } from './resolve-imports.js';

const rewrite = (code: string, pins: Record<string, string> = {}): string =>
  rewriteBareImports({ code, cdnBase: 'https://esm.sh', pins });

describe('rewriteBareImports', () => {
  it('rewrites a default import to its CDN URL', () => {
    expect(rewrite(`import confetti from 'canvas-confetti'`)).toBe(
      `import confetti from 'https://esm.sh/canvas-confetti'`
    );
  });

  it('rewrites named and namespace imports', () => {
    const code = `import { a } from "pkg-a"\nimport * as b from 'pkg-b'`;
    expect(rewrite(code)).toBe(
      `import { a } from "https://esm.sh/pkg-a"\nimport * as b from 'https://esm.sh/pkg-b'`
    );
  });

  it('rewrites a side-effect import', () => {
    expect(rewrite(`import 'katex/dist/katex.css'`)).toBe(
      `import 'https://esm.sh/katex/dist/katex.css'`
    );
  });

  it('rewrites a re-export source', () => {
    expect(rewrite(`export { x } from 'pkg-x'`)).toBe(`export { x } from 'https://esm.sh/pkg-x'`);
  });

  it('rewrites a dynamic import with a literal specifier', () => {
    expect(rewrite(`const m = await import("canvas-confetti@1.9.3")`)).toBe(
      `const m = await import("https://esm.sh/canvas-confetti@1.9.3")`
    );
  });

  it('leaves relative and absolute paths alone', () => {
    const code = `import a from './local'\nimport b from '/abs'`;
    expect(rewrite(code)).toBe(code);
  });

  it('leaves full URLs and blob specifiers alone', () => {
    const code = `import a from 'https://esm.sh/x'\nimport b from 'blob:abc'`;
    expect(rewrite(code)).toBe(code);
  });

  it('rewrites every occurrence of a specifier imported twice', () => {
    expect(rewrite(`import { a } from 'dup'\nimport { b } from 'dup'`)).toBe(
      `import { a } from 'https://esm.sh/dup'\nimport { b } from 'https://esm.sh/dup'`
    );
  });

  it('applies a version pin when the specifier declares none', () => {
    expect(rewrite(`import React from 'react'`, { react: '19.1.0' })).toBe(
      `import React from 'https://esm.sh/react@19.1.0'`
    );
  });

  it('pins the jsx-runtime subpath that transpiled react code imports', () => {
    expect(rewrite(`import { jsx as _jsx } from "react/jsx-runtime"`, { react: '19.1.0' })).toBe(
      `import { jsx as _jsx } from "https://esm.sh/react@19.1.0/jsx-runtime"`
    );
  });

  it('keeps an author-declared version over a pin', () => {
    expect(rewrite(`import x from 'react@18.2.0'`, { react: '19.1.0' })).toBe(
      `import x from 'https://esm.sh/react@18.2.0'`
    );
  });

  it('rewrites a scoped package with a subpath', () => {
    expect(rewrite(`import { q } from '@scope/pkg@2.0.0/sub'`)).toBe(
      `import { q } from 'https://esm.sh/@scope/pkg@2.0.0/sub'`
    );
  });

  it('resolves against a local stub base in test mode', () => {
    expect(
      rewriteBareImports({
        code: `import g from 'greeting-fixture'`,
        cdnBase: 'http://localhost:7400/esm-stub',
        pins: {},
      })
    ).toBe(`import g from 'http://localhost:7400/esm-stub/greeting-fixture'`);
  });

  it('returns import-free code unchanged', () => {
    expect(rewrite(`const x = 1`)).toBe(`const x = 1`);
  });

  it('leaves a computed dynamic import alone', () => {
    // Nothing static can resolve `import(name)`. It stays as written and fails at
    // run time the way any unresolvable specifier does, rather than being
    // silently rewritten into something the author did not ask for.
    const code = `const name = 'canvas-confetti'\nconst m = await import(name)`;
    expect(rewrite(code)).toBe(code);
  });
});
