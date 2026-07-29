import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule, { PENDING_CONSUMER_CLOSURES } from './money-internals-owners-only.rule.js';

/**
 * The ratchet. `PENDING_CONSUMER_CLOSURES` is a debt list, and a debt list with
 * no downward pressure becomes furniture — nine entries that nobody ever has a
 * reason to revisit. Lowering this number as reaches close is the intended
 * edit; raising it is possible but never silent, which is the whole mechanism.
 */
const MAX_PENDING_CONSUMER_CLOSURES = 8;

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

const OWNER = 'apps/api/src/slices/models/domain/estimate-run.ts';
const NON_OWNER = 'apps/api/src/slices/chat/domain/runtime.ts';

describe('the pending-closure ratchet', () => {
  it('holds no more pending consumer reaches than the recorded debt', () => {
    expect(PENDING_CONSUMER_CLOSURES.length).toBeLessThanOrEqual(MAX_PENDING_CONSUMER_CLOSURES);
  });

  it('lists each pending file once, so a duplicate cannot hide under the cap', () => {
    expect(new Set(PENDING_CONSUMER_CLOSURES).size).toBe(PENDING_CONSUMER_CLOSURES.length);
  });
});

describe('money-internals-owners-only', () => {
  it('flags a walled subpath import from a non-owner api file', () => {
    const project = projectWith({
      [NON_OWNER]:
        "import { evaluateManifest } from '@hushbox/shared/affordability/estimate/reducers';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: `/${NON_OWNER}`, line: 1 });
    expect(violations[0]?.message).toContain('estimate/reducers');
  });

  it('flags a walled subpath RE-EXPORT, which no import-only scan sees', () => {
    const project = projectWith({
      [NON_OWNER]:
        "export { CHARS_PER_TOKEN_CONSERVATIVE as CLASSIFIER_CHARS_PER_TOKEN } from '@hushbox/shared/affordability/constants';\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a walled subpath reached through a dynamic import or vi.mock', () => {
    const project = projectWith({
      [NON_OWNER]:
        "const m = await import('@hushbox/shared/affordability/estimate/price-request');\n" +
        "vi.mock('@hushbox/shared/affordability/estimate/reducers');\n",
    });

    expect(rule.check(project)).toHaveLength(2);
  });

  it('passes the affordability barrel itself from a non-owner file', () => {
    const project = projectWith({
      [NON_OWNER]: "import { priceableModelFrom } from '@hushbox/shared/affordability';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes the package root barrel from a non-owner file', () => {
    const project = projectWith({
      [NON_OWNER]: "import { getTurnOptions } from '@hushbox/shared';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a walled subpath from a designated price owner', () => {
    const project = projectWith({
      [OWNER]:
        "import { reservationCeiling } from '@hushbox/shared/affordability/estimate/reducers';\n" +
        "export { ratesFromPricing } from '@hushbox/shared/affordability/estimate/run-ceiling';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it("passes an owner's colocated test, which drives the same arithmetic", () => {
    const project = projectWith({
      'apps/api/src/slices/models/domain/estimate-run.test.ts':
        "import { classifierReserveChars } from '@hushbox/shared/affordability/estimate/classifier-line-item';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a file on the pending-closure list', () => {
    const project = projectWith({
      'apps/api/src/slices/workflows/nodes/turn-decision.ts':
        "import { parseClassifierAnswer } from '@hushbox/shared/affordability/smart-model/effort-dimension';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it("ignores files outside apps/api — apps/web is out of this rule's scope, the module is its own", () => {
    const project = projectWith({
      'apps/web/src/hooks/billing/use-prompt-budget.ts':
        "import { estimateTokensForTier } from '@hushbox/shared/affordability/estimate/pre-adapters';\n",
      'packages/shared/src/affordability/turn-options.ts':
        "import { reservationCeiling } from './estimate/reducers.js';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reports one violation per reach, at its own line', () => {
    const project = projectWith({
      [NON_OWNER]:
        "import { MINIMUM_OUTPUT_TOKENS } from '@hushbox/shared/affordability/constants';\n" +
        "import { priceRequest } from '@hushbox/shared/affordability/estimate/price-request';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(2);
    expect(violations.map((violation) => violation.line)).toEqual([1, 2]);
  });
});
