# E2E Rules

Priorities, in order: **Proof** (if green, prod works) > **No flakes** (deterministic, survives a saturated machine) > **Enforcement** (every rule machine-checked) > **Speed**.

**Meta-rule: a rule that isn't enforced isn't a rule.** Every rule below cites its enforcement. Saturation resilience is not a separate test — it is the emergent result of the No-flakes rules (no wall-clock anything, gate on app state, globally-scalable budgets).

---

## Enforcement ladder

Attach every rule to the **highest rung achievable**. Descend only when the rung above is impossible. Rung 6 is the only doc-only tier; minimize it.

| Rung | Mechanism                 | Caught     | Blocks               |
| ---- | ------------------------- | ---------- | -------------------- |
| 1    | type system               | edit/build | build                |
| 2    | lint (pre-push + CI)      | pre-merge  | merge                |
| 3    | CI gate / contract test   | pre-merge  | merge/deploy         |
| 4    | runtime auto-fail fixture | during run | the test             |
| 5    | always-on reporting       | every run  | nothing (visible)    |
| 6    | doc + review checklist    | review     | nothing (discipline) |

**Enforcement tags:** `lint:<rule>` · `test:<path>` · `fixture:<name>` · `ci:<step>` · `config:<key>` · `type:<symbol>` · `report:<name>` · `doc`.

---

## Pillar 1 — Proof

Mock only the nondeterministic third-party edge; everything internal runs real production code.

| #   | Rule                                                                                                       | Enforcement                                                     | Rung |
| --- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---- |
| 1.1 | Internal setup uses real domain code (crypto, conversations, billing); only the LLM/payment edge is mocked | `fixture:networkAllowlist` · `doc`                              | 4/6  |
| 1.2 | The real external dependency provably ran somewhere                                                        | `ci:verify:evidence`                                            | 3    |
| 1.3 | Mocks cannot drift from prod (shape + pricing)                                                             | `test:live-catalog-drift` · mock cost derived from real catalog | 3/1  |
| 1.4 | No live third-party in the hot path; external catalogs pinned to a fixture                                 | `fixture:pinnedCatalog` · `fixture:networkAllowlist`            | 4    |
| 1.5 | State-changing flows assert the side effect (DB/storage/email/cost) via API, not just UI                   | `doc`                                                           | 6    |

---

## Pillar 2 — No flakes

Deterministic by construction. Removes the root causes of saturation flake instead of testing for them.

| #    | Rule                                                                                     | Enforcement                                                                                                                                    | Rung  |
| ---- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 2.1  | No wall-clock waits, anywhere                                                            | `lint:playwright/no-wait-for-timeout` · `lint:playwright/no-networkidle` · `lint:no-restricted-syntax(setTimeout/setInterval)`                 | 2     |
| 2.2  | Wait only on app-emitted readiness signals; signals are typed and contract-tested        | `type:signalRegistry` · `test:contracts/signals` · prefer signals over other waits `doc`                                                       | 1/3/6 |
| 2.3  | Timeouts are fixed named budgets from one module; no inline literals, no runtime scaling | `lint:no-restricted-syntax(numeric timeout:)` · `type:timeouts`                                                                                | 2     |
| 2.4  | Control time, randomness, locale, timezone                                               | `config:timezoneId=UTC` · `config:locale` · `lint:no-restricted-syntax(Math.random, bare new Date())` · `page.clock` when time-dependent `doc` | 2/3/6 |
| 2.5  | No motion in tests                                                                       | `config:VITE_E2E` (existing — forces reduced-motion app-wide) · `test:contracts/motion-off`                                                    | 3     |
| 2.6  | Total isolation; order-independent; no `serial` except an explicit allowlist             | `config:fullyParallel` · `lint:no-restricted-syntax(describe.serial)` · `lint:no-restricted-imports(@hushbox/db in specs)`                     | 2/3   |
| 2.7  | Cleanup only via fixture teardown — never `afterEach`/`afterAll` in specs                | `lint:no-restricted-syntax(afterEach/afterAll in *.spec)`                                                                                      | 2     |
| 2.8  | Web-first retrying assertions only; no point-in-time read used as an assertion           | `lint:playwright/prefer-web-first-assertions` · `lint:playwright/no-element-handle` · `lint:playwright/no-eval`                                | 2     |
| 2.9  | Explicit quiescence only — no implicit per-assertion settling race                       | `lint:no-restricted-imports(settled-expect)` · `fixture:waitForSettled`(opt-in)                                                                | 2     |
| 2.10 | Host resource-exhaustion surfaced for triage (app- vs test- vs host-flake)               | `report:resource-scan`                                                                                                                         | 5     |

---

## Pillar 3 — Enforcement

| #   | Rule                                                                                                                                                                                                                | Enforcement                                                                                                                                         | Rung |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 3.1 | Every async assertion awaited; every test makes ≥1 real assertion                                                                                                                                                   | `lint:playwright/missing-playwright-await` · `lint:playwright/expect-expect` · `lint:@typescript-eslint/no-floating-promises`                       | 1/2  |
| 3.2 | No `.only`; no in-body conditional skips — gate via tags + project/CI `grep` (`test.fixme` allowed)                                                                                                                 | `lint:playwright/no-focused-test` · `lint:playwright/no-skipped-test` · `config:tag-grep`                                                           | 2    |
| 3.3 | Semantic locators first; every test-id from the typed `TEST_IDS` registry (no literals); raw element/CSS selectors confined to page objects/helpers, never in specs; positional methods (`.first`/`.nth`) permitted | `type:TEST_IDS` · `lint:no-restricted-syntax(literal data-testid)` · `lint:playwright/no-raw-locators`(error in specs; off in page objects/helpers) | 1/2  |
| 3.4 | Specs obtain `test`/`expect` and Playwright types from the fixtures module, never raw `@playwright/test` — so every page inherits the console/network auto-fail guardrails (the two fixtures modules are exempt) | `lint:no-restricted-imports(@playwright/test in *.spec)` | 2 |

---

## Pillar 4 — Speed

| #   | Rule                                                                                   | Enforcement                                   | Rung |
| --- | -------------------------------------------------------------------------------------- | --------------------------------------------- | ---- |
| 4.1 | One user-journey per test; assert all invariants inline; split only when setup differs | `doc`                                         | 6    |
| 4.2 | Preconditions via API/dev-endpoints; reserve UI for what is under test                 | `doc` (dev endpoints are the default path)    | 6    |
| 4.3 | Right-sized, parallel-safe worker counts                                               | `config:workers`                              | 3    |
| 4.4 | No redundant waiting                                                                   | `lint:no-restricted-syntax(numeric timeout:)` | 2    |

---

## Debugging

`e2e/report/<latest>/` is the single source of truth when tests fail — use `/debug-e2e` to investigate.
