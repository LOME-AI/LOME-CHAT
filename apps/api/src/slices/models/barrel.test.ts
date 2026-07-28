/**
 * The models slice's public barrel does not republish the money module's walled
 * types.
 *
 * `docs/BILLING.md` §Where the Code Lives keeps per-candidate ceiling solvers and
 * their shapes off the money module's entry points. Two of those shapes —
 * `DeclaredCeiling` and `NodeStorage` — reached this slice's public barrel by
 * being re-exported through its estimate modules, which puts a walled type back
 * in reach of every workspace while satisfying every test the shared package can
 * write: those read the shared package's export map, and this escape route
 * crosses a slice boundary instead. Hence a pin on this side of the boundary.
 *
 * The check is on the barrel TEXT rather than on runtime bindings, because a
 * type has no runtime presence to enumerate — an `export type` is exactly what
 * has to be absent. Reading the text catches walled values by the same
 * mechanism, so one check covers both kinds and a walled constant cannot slip
 * in behind a rule written only for types.
 *
 * A walled name can also arrive under an ALIAS: `CLASSIFIER_CHARS_PER_TOKEN` is
 * the money layer's `CHARS_PER_TOKEN_CONSERVATIVE` renamed on the way out, so
 * no search for the original name finds it here. The pin therefore lists the
 * name as this slice publishes it, not as the module declares it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Walled money names, as this slice would publish them (aliases included). */
const WALLED_MONEY_NAMES = [
  'DeclaredCeiling',
  'NodeStorage',
  'CLASSIFIER_CHARS_PER_TOKEN',
] as const;

/** Every name one barrel file publishes, whether value or type. */
function publishedNames(file: string): ReadonlySet<string> {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS
  );
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const clause = statement.exportClause;
    if (clause === undefined || !ts.isNamedExports(clause)) continue;
    for (const element of clause.elements) names.add(element.name.text);
  }
  return names;
}

describe('the models slice public barrel', () => {
  const published = publishedNames(path.join(HERE, 'index.ts'));

  it('publishes the slice API, so absence below is absence rather than an empty read', () => {
    expect(published.has('createModelsManifest')).toBe(true);
    expect(published.has('EstimateRun')).toBe(true);
  });

  it.each(WALLED_MONEY_NAMES)('does not republish the walled %s', (name) => {
    expect(published.has(name)).toBe(false);
  });
});

describe('the models domain barrel', () => {
  const published = publishedNames(path.join(HERE, 'domain', 'index.ts'));

  it('publishes the domain API, so absence below is absence', () => {
    expect(published.has('EstimateRun')).toBe(true);
  });

  it.each(WALLED_MONEY_NAMES)('does not republish the walled %s', (name) => {
    expect(published.has(name)).toBe(false);
  });
});
