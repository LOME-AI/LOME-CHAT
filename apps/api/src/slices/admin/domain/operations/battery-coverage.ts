/**
 * Static discovery of which admin ops ship the `describeAdminOp` reversibility
 * battery, derived from the operation test sources. The aggregate coverage test
 * asserts the returned set equals `ADMIN_OP_NAMES`, so a registered op without a
 * battery fails CI — inverse *coverage* becomes enforced, not conventional.
 *
 * Source-scanning is deliberate over a runtime module set: Vitest isolates each
 * test file in its own module registry, so a set mutated by `describeAdminOp` in
 * one file is unreadable from an aggregate test in another without re-running the
 * whole admin DB suite. The call sites are the single source of truth.
 *
 * Every op test binds its contract as `const X = ADMIN_OP_CONTRACTS['<name>']`
 * and passes `contract: X` (or the inline subscript) to `describeAdminOp`; both
 * forms are resolved to the op name below.
 */

const CONTRACT_BINDING = /const\s+(\w+)\s*=\s*ADMIN_OP_CONTRACTS\[\s*'([^']+)'\s*\]/g;
const BATTERY_CALL = /describeAdminOp\(\s*\{/g;
const CONTRACT_ARG = /\bcontract:\s*(?:ADMIN_OP_CONTRACTS\[\s*'([^']+)'\s*\]|(\w+))/;

/** Maps every `const X = ADMIN_OP_CONTRACTS['name']` binding to its op name. */
function contractBindings(source: string): ReadonlyMap<string, string> {
  const bindings = new Map<string, string>();
  for (const [, identifier, name] of source.matchAll(CONTRACT_BINDING)) {
    // Both capture groups are non-optional in CONTRACT_BINDING, so a match always
    // carries them; this guard narrows the `string | undefined` match type and its
    // false arm is unreachable — hence the coverage-ignore.
    /* v8 ignore next 3 -- unreachable: CONTRACT_BINDING's two capture groups are required */
    if (identifier !== undefined && name !== undefined) {
      bindings.set(identifier, name);
    }
  }
  return bindings;
}

/** Resolves one battery call's `contract` argument (inline or bound) to its op name. */
function resolveContractName(
  scope: string,
  bindings: ReadonlyMap<string, string>
): string | undefined {
  const contract = CONTRACT_ARG.exec(scope);
  if (contract === null) {
    return undefined;
  }
  const [, inlineName, identifier] = contract;
  if (inlineName !== undefined) {
    return inlineName;
  }
  // Reached only when the identifier alternative matched (inlineName absent), so
  // `identifier` is present; the undefined arm is unreachable — hence the coverage-ignore.
  /* v8 ignore next -- unreachable: identifier is defined whenever inlineName is not */
  return identifier === undefined ? undefined : bindings.get(identifier);
}

/**
 * The op names whose test sources invoke `describeAdminOp`. Each call's contract
 * lookup is bounded to before the next call so multi-op files stay precise;
 * unresolvable references are skipped — a stray name never in `ADMIN_OP_NAMES`
 * would fail the aggregate equality check loudly.
 */
export function collectAdminOpBatteryCoverage(sources: readonly string[]): ReadonlySet<string> {
  const covered = new Set<string>();

  for (const source of sources) {
    const bindings = contractBindings(source);

    for (const call of source.matchAll(BATTERY_CALL)) {
      const afterCall = source.slice(call.index + call[0].length);
      const nextCall = afterCall.search(BATTERY_CALL);
      const scope = nextCall === -1 ? afterCall : afterCall.slice(0, nextCall);

      const name = resolveContractName(scope, bindings);
      if (name !== undefined) {
        covered.add(name);
      }
    }
  }

  return covered;
}
