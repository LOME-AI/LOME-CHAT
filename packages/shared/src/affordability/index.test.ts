import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import * as affordability from './index.js';
import * as root from '../index.js';

/**
 * One symbol per relocated unit of the money layer. The barrel and the root
 * barrel must hand back the *same* binding, which is what makes the relocation
 * a move rather than a copy.
 *
 * Each representative must be a symbol both entry points still publish, so a
 * unit whose original representative is now behind the wall
 * ({@link WALLED_EXPORTS}) is represented by another of its own exports rather
 * than dropped — the move-not-copy property is about the unit, not the symbol.
 */
const RELOCATED_UNITS = [
  'TOTAL_FEE_RATE', // constants (fee rates)
  'STORAGE_COST_PER_CHARACTER', // constants (storage cost model)
  // money — the fee helpers themselves stay off this barrel (fee-seams rule);
  // the root barrel is their one sanctioned publication site.
  'usdToNanoUsd',
  'NANO_USD_PER_CENT', // nano-usd
  'getUserTier', // tiers
  'generateNotifications', // budget
  'FEE_CATEGORIES', // fees
  'applyFees', // pricing
  'CANONICAL_REASONING_EFFORTS', // reasoning-effort
  'MODALITIES', // modality
  'compileParamSpec', // param-spec
  'callShapeFamilyFor', // model-descriptor
  'levenshtein', // string distance
  'outputTokensOf', // estimate
  'buildClassifierSystemPrompt', // smart-model
  'resolveFunding', // billing
  'resolveClientBilling', // billing (client wrapper)
] as const;

/**
 * The money layer is content-free: no export accepts a prompt, a message or a
 * history array. These two took conversation text, so they live with the caller
 * that has the text rather than behind the money barrel. Pinned on both entry
 * points, because the root barrel re-exports this one.
 */
const CONTENT_SHAPED_NAMES = ['truncateForClassifier', 'buildClassifierMessages'] as const;

/**
 * The two reasoning-plan producers, published at both entry points.
 *
 * Four of their siblings — `reasoningPlanModelFrom`, `reasoningBudgetForWire`,
 * `ReasoningWire` and `REASONING_OFF_WIRE` — were already published, so the
 * wall never protected this family; keeping only these two behind it was an
 * inconsistency rather than a policy, and it forced a caller either to reach a
 * subpath or to re-derive `B + H` for itself, which is the mirrored-formula
 * shape `docs/CODE-RULES.md` bans. What stays walled is the LADDER these plans
 * are computed from (`REASONING_BUDGET_TOKENS_BY_EFFORT`), pinned below: a
 * caller may ask for a plan, never for the budget table behind it.
 */
const REASONING_PLAN_PRODUCERS = ['planReasoning', 'planReasoningOff'] as const;

/**
 * The money layer's export wall, as symbols. `docs/BILLING.md` §Where the Code
 * Lives states it as categories — "the minimum-answer constant, tier ratios,
 * the reasoning-budget ladder, rates, manifests, reducers, per-candidate
 * ceiling solvers, clamping" — and this is that list resolved against the
 * module's actual declarations, grouped in the doc's own order so a reader can
 * check the mapping rather than trust it.
 *
 * A consumer that needs one of these is evidence a producer is missing, which
 * is the wall's whole purpose; the interim reaches those consumers hold are
 * enumerated in {@link INTERIM_UNIT_SUBPATHS}.
 */
const WALLED_EXPORTS = [
  // the minimum-answer constant
  'MINIMUM_OUTPUT_TOKENS',
  // tier ratios
  'CHARS_PER_TOKEN_CONSERVATIVE',
  'CHARS_PER_TOKEN_STANDARD',
  'charsPerTokenForTier',
  'estimateTokensForTier',
  'outputCharsPerTokenForTier',
  // the reasoning-budget ladder
  'REASONING_BUDGET_FLOOR_TOKENS',
  'REASONING_BUDGET_TOKENS_BY_EFFORT',
  'OfferedLevel',
  'offeredLevels',
  // rates
  'ModelRatesNano',
  'ratesFromPricing',
  'SEARCH_COST_PER_CALL',
  'WEB_SEARCH_RESERVATION_NANO_PER_MODEL',
  // manifests
  'BillableRequest',
  'Manifest',
  'NanoLineItem',
  'MediaBillable',
  'MediaRateKey',
  'ClassifierStage',
  'NodeStorage',
  'NO_STORAGE',
  'buildMediaLineItems',
  'callManifest',
  'classifierLineItems',
  'classifierReserveChars',
  'classifierReserveLineItems',
  'priceRequest',
  'webSearchLineItem',
  // reducers — over a manifest, and over a classifier answer
  'Affordability',
  'affordability',
  'evaluateManifest',
  'ReservationCeilingInput',
  'reservationCeiling',
  'ClassifierAnswerParts',
  'parseClassifierAnswer',
  'pickClassifiedEffortPlan',
  'resolveClassifiedEffort',
  'resolveClassifierOutput',
  // per-candidate ceiling solvers
  'DeclaredCeiling',
  'estimateRunCeilingNanoUsd',
  'PromptCapacity',
  'PromptCapacityInput',
  'computePromptCapacity',
  'PricedSmartModelCandidate',
  'PricedSmartModelPool',
  'SmartModelAdmission',
  'SmartModelCandidateId',
  'SmartModelCappedCandidate',
  'SmartModelPoolCandidate',
  'SmartModelStorageContext',
  'admitSmartModel',
  'priceSmartModelPool',
  'smartModelMinimumRequiredNanoUsd',
  'ReasoningInfeasibleReason',
  'ReasoningPlan',
  'ReasoningPlanResult',
  'EffortOption',
  'ResolvedEffort',
  'offeredEffortLabels',
  'resolveEffortForModel',
  'turnEffortOptions',
  // clamping
  'validCap',
] as const;

/**
 * The type-only members of the wall. Listed rather than inferred from casing
 * because the split decides which assertion carries the weight for a symbol: a
 * type has no runtime binding, so `Object.hasOwn` is vacuous for it and only
 * {@link publishedNames} can hold it to account.
 */
const WALLED_TYPE_ONLY_EXPORTS = new Set<string>([
  'OfferedLevel',
  'ModelRatesNano',
  'BillableRequest',
  'Manifest',
  'NanoLineItem',
  'MediaBillable',
  'MediaRateKey',
  'ClassifierStage',
  'NodeStorage',
  'Affordability',
  'ReservationCeilingInput',
  'ClassifierAnswerParts',
  'DeclaredCeiling',
  'PromptCapacity',
  'PromptCapacityInput',
  'PricedSmartModelCandidate',
  'PricedSmartModelPool',
  'SmartModelAdmission',
  'SmartModelCandidateId',
  'SmartModelCappedCandidate',
  'SmartModelPoolCandidate',
  'SmartModelStorageContext',
  'ReasoningInfeasibleReason',
  'ReasoningPlan',
  'ReasoningPlanResult',
  'EffortOption',
  'ResolvedEffort',
]);

/** The subset with a runtime binding, so `Object.hasOwn` can see it at all. */
const WALLED_VALUE_EXPORTS = WALLED_EXPORTS.filter((name) => !WALLED_TYPE_ONLY_EXPORTS.has(name));

/**
 * Consumers that still need a walled symbol reach the declaring unit directly,
 * through one subpath per unit. Every one of these exists because the producer
 * that should serve the consumer does not exist yet; when it does, the consumer
 * moves onto the barrel and its subpath goes with it. The list is pinned so
 * that neither a new reach nor a forgotten one is silent — a unit still listed
 * here is a consumer still behind the wall.
 *
 * Per-unit rather than per-directory on purpose: a `./affordability/estimate`
 * subpath would republish the whole estimator and put the wall back where it
 * started, one entry point along.
 */
const INTERIM_UNIT_SUBPATHS = [
  './affordability/budget',
  './affordability/constants',
  './affordability/estimate/classifier-line-item',
  './affordability/estimate/effort-options',
  './affordability/estimate/pre-adapters',
  './affordability/estimate/price-request',
  './affordability/estimate/reasoning-plan',
  './affordability/estimate/reducers',
  './affordability/estimate/run-ceiling',
  './affordability/estimate/search-reservation',
  './affordability/estimate/smart-model-affordability',
  './affordability/estimate/types',
  './affordability/smart-model/effort-dimension',
  './affordability/smart-model/resolve',
] as const;

const ROOT_BARREL = fileURLToPath(new URL('../index.ts', import.meta.url));
const MODULE_BARREL = fileURLToPath(new URL('index.ts', import.meta.url));

/**
 * Every name an entry point publishes, types included. The runtime `import *`
 * above sees only value bindings, and more than a third of the wall is
 * type-only — so absence is also asserted against the export graph the
 * compiler sees, by walking `export *` chains from the barrel.
 *
 * This is package-local and deliberately narrow: it reads the two barrel files
 * of this package. The equivalent static rule in the arch harness is what
 * catches a re-export added from a package that has no such test.
 */
function publishedNames(entry: string): ReadonlySet<string> {
  const names = new Set<string>();
  const visited = new Set<string>();

  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    for (const statement of source.statements) {
      for (const name of exportedNames(statement)) names.add(name);
      const target = starTargetOf(file, statement);
      if (target !== undefined) visit(target);
    }
  };

  visit(entry);
  return names;
}

/** The names one statement publishes: a re-export clause, or its own declaration. */
function exportedNames(statement: ts.Statement): readonly string[] {
  if (ts.isExportDeclaration(statement)) return reExportedNames(statement.exportClause);
  if (!isExported(statement)) return [];
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations
      .map((declaration) => declaration.name)
      .filter((name): name is ts.Identifier => ts.isIdentifier(name))
      .map((name) => name.text);
  }
  return hasDeclarationName(statement) ? [statement.name.text] : [];
}

function reExportedNames(clause: ts.NamedExportBindings | undefined): readonly string[] {
  if (clause === undefined) return [];
  if (ts.isNamedExports(clause)) return clause.elements.map((element) => element.name.text);
  return [clause.name.text];
}

function isExported(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    )
  );
}

function hasDeclarationName(statement: ts.Statement): statement is ts.Statement & {
  name: ts.Identifier;
} {
  const named = statement as ts.Statement & { readonly name?: ts.Node };
  return named.name !== undefined && ts.isIdentifier(named.name);
}

/**
 * The file an `export *` continues into. Only a relative specifier is walked: a
 * bare one leaves the package and cannot hold a money symbol.
 */
function starTargetOf(from: string, statement: ts.Statement): string | undefined {
  if (!ts.isExportDeclaration(statement) || statement.exportClause !== undefined) return undefined;
  const specifier = statement.moduleSpecifier;
  if (specifier === undefined || !ts.isStringLiteral(specifier)) return undefined;
  if (!specifier.text.startsWith('.')) return undefined;
  return path.resolve(path.dirname(from), specifier.text.replace(/\.js$/, '.ts'));
}

/**
 * `docs/BILLING.md` §The public surface: the six exports feature code touches,
 * plus the named structural seams. This pins PRESENCE at both entry points —
 * the totality pin (set equality against this list) waits until the interim
 * per-unit subpaths are gone, because until then a consumer reaching a walled
 * unit is still resolving, and a totality assertion would have to name every
 * symbol those consumers reach.
 */
const DOCUMENTED_SURFACE = [
  'getTurnOptions',
  'chooseFrom',
  'wireFor',
  'renderOptions',
  'resolveFunding',
  'notices',
  // The named structural seams.
  'STORAGE_COST_PER_CHARACTER_NANO',
  'MEDIA_STORAGE_COST_PER_BYTE_NANO',
  'getUserTier',
  'tierCanAccessPremium',
  'isPremiumModel',
  'premiumPriceThresholdNanoUsd',
  'DIMENSIONS',
  'dimensionFor',
  'buildClassifierSystemPrompt',
  'nanoUnitPriceUsd',
] as const;

/**
 * The types the surface's own signatures name. A consumer that can call
 * `getTurnOptions` and cannot name what it returns has no usable API, so these
 * travel with it.
 */
const DOCUMENTED_SURFACE_TYPES = [
  'TurnOptions',
  'OptionSet',
  'ModelEntry',
  'DimensionAvailability',
  'Availability',
  'RefusalCode',
  'Selection',
  'FundingSnapshot',
  'PromptBasis',
  'PriceableModel',
  'ModelId',
  'ChosenOptions',
  'Notice',
  'NoticeReason',
] as const;

describe('the public surface', () => {
  it.each(DOCUMENTED_SURFACE)('binds %s on the affordability barrel', (name) => {
    expect(Object.hasOwn(affordability, name)).toBe(true);
  });

  it.each(DOCUMENTED_SURFACE)('binds %s on the package root barrel', (name) => {
    expect(Object.hasOwn(root, name)).toBe(true);
  });

  it.each(DOCUMENTED_SURFACE)('hands back one binding for %s at both entry points', (name) => {
    expect((affordability as Record<string, unknown>)[name]).toBe(
      (root as Record<string, unknown>)[name]
    );
  });

  it.each(DOCUMENTED_SURFACE_TYPES)('publishes the type %s at both entry points', (name) => {
    expect(publishedNames(MODULE_BARREL).has(name)).toBe(true);
    expect(publishedNames(ROOT_BARREL).has(name)).toBe(true);
  });
});

describe('the reasoning plan producers', () => {
  it.each(REASONING_PLAN_PRODUCERS)('binds %s on the affordability barrel', (name) => {
    expect(Object.hasOwn(affordability, name)).toBe(true);
  });

  it.each(REASONING_PLAN_PRODUCERS)('binds %s on the package root barrel', (name) => {
    expect(Object.hasOwn(root, name)).toBe(true);
  });

  it.each(REASONING_PLAN_PRODUCERS)(
    'hands back one binding for %s at both entry points',
    (name) => {
      expect((affordability as Record<string, unknown>)[name]).toBe(
        (root as Record<string, unknown>)[name]
      );
    }
  );

  it('keeps the ladder the plans are built from behind the wall', () => {
    expect(Object.hasOwn(affordability, 'REASONING_BUDGET_TOKENS_BY_EFFORT')).toBe(false);
    expect(Object.hasOwn(root, 'REASONING_BUDGET_TOKENS_BY_EFFORT')).toBe(false);
  });
});

describe('affordability barrel', () => {
  it.each(RELOCATED_UNITS)('exposes %s', (name) => {
    expect(Object.hasOwn(affordability, name)).toBe(true);
  });

  it.each(CONTENT_SHAPED_NAMES)('does not export the content-shaped %s', (name) => {
    expect(Object.hasOwn(affordability, name)).toBe(false);
  });

  it.each(CONTENT_SHAPED_NAMES)('keeps the content-shaped %s off the root barrel', (name) => {
    expect(Object.hasOwn(root, name)).toBe(false);
  });

  it.each(RELOCATED_UNITS)('hands back the same binding as the root barrel for %s', (name) => {
    expect((affordability as Record<string, unknown>)[name]).toBe(
      (root as Record<string, unknown>)[name]
    );
  });
});

/**
 * One block per entry point. Both matter: a symbol absent from one and present
 * on the other is a hole, not a partial pass, because either resolves from
 * every workspace.
 */
describe('the export wall — the `@hushbox/shared/affordability` entry point', () => {
  const published = publishedNames(MODULE_BARREL);

  it('walks `export *` chains, so absence below means absence', () => {
    expect(published.has('getUserTier')).toBe(true);
    expect(published.has('FundingDecision')).toBe(true);
    expect(published.has('truncateForClassifier')).toBe(false);
  });

  it.each(WALLED_VALUE_EXPORTS)('does not bind %s', (name) => {
    expect(Object.hasOwn(affordability, name)).toBe(false);
  });

  it.each(WALLED_EXPORTS)('does not publish %s', (name) => {
    expect(published.has(name)).toBe(false);
  });
});

describe('the export wall — the package root entry point', () => {
  const published = publishedNames(ROOT_BARREL);

  it('walks `export *` chains, so absence below means absence', () => {
    expect(published.has('getUserTier')).toBe(true);
    expect(published.has('FundingDecision')).toBe(true);
    expect(published.has('truncateForClassifier')).toBe(false);
  });

  it.each(WALLED_VALUE_EXPORTS)('does not bind %s', (name) => {
    expect(Object.hasOwn(root, name)).toBe(false);
  });

  it.each(WALLED_EXPORTS)('does not publish %s', (name) => {
    expect(published.has(name)).toBe(false);
  });
});

describe('affordability subpath', () => {
  it('is declared in the package exports map and points at an existing barrel', () => {
    const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      exports: Record<string, string>;
    };

    expect(manifest.exports['./affordability']).toBe('./src/affordability/index.ts');
    expect(() =>
      readFileSync(fileURLToPath(new URL('../../src/affordability/index.ts', import.meta.url)))
    ).not.toThrow();
  });

  it('publishes exactly the enumerated interim unit subpaths beside it', () => {
    const declared = Object.keys(exportsMap()).filter((subpath) =>
      subpath.startsWith('./affordability/')
    );

    expect(declared.toSorted((a, b) => a.localeCompare(b))).toEqual(
      [...INTERIM_UNIT_SUBPATHS].toSorted((a, b) => a.localeCompare(b))
    );
  });

  it.each(INTERIM_UNIT_SUBPATHS)('resolves %s to an existing unit', (subpath) => {
    const target = `./src${subpath.slice(1)}.ts`;

    expect(exportsMap()[subpath]).toBe(target);
    expect(() =>
      readFileSync(fileURLToPath(new URL(`../../${target}`, import.meta.url)))
    ).not.toThrow();
  });
});

function exportsMap(): Record<string, string> {
  const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url));
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    exports: Record<string, string>;
  };
  return manifest.exports;
}
