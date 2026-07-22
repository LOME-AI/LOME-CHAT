# T7 — fix round (3 validated audit findings) — impl report 2

## Objective

Fix brief's three findings: (1) two route-level regression pins for the
`body.models === undefined && reasoningEffort === 'auto' && !webSearchEnabled`
gate (test-only, must pass against current code); (2) dedupe the classifier
effort scale in `mock-directives.ts` via `z.enum(CLASSIFIER_EFFORT_LEVELS)`;
(3) implement the founder's hard-off ruling on the Smart Model composite path
— selection `none` wires `{ enabled: false }` explicitly to each
reasoning-capable non-mandatory candidate (mandatory candidates get no off
wire — they cannot disable; documented), B = 0, caps unchanged, and correct
the ambiguous-to-wrong comment.

## Files changed

- `apps/api/src/slices/chat/routes.integration.test.ts` — finding-1 pins
  (auto+webSearch → regular tool turn + placeholder wire, no composite;
  auto+models → 2 modelCall siblings + placeholder wires, no composite) +
  finding-3 route pin (SMART+none → composite params carry `{enabled:false}`,
  no classify dimension).
- `packages/shared/src/mock-directives.ts` — finding 2: `classifierEffort`
  enum now `z.enum(CLASSIFIER_EFFORT_LEVELS)` (imported from
  `./smart-model/effort-dimension.js`; no cycle — that module imports only
  `resolve`/`reasoning-effort`/`estimate/reasoning-plan`).
- `apps/api/src/slices/chat/domain/smart-model-turn.ts` — finding 3 build
  side: `SmartModelTurnParams.reasoningOff` (doc comment carries the
  mandatory-candidate rule); `buildSmartModelTurn` composes answer params and
  stamps `reasoning: { enabled: false } satisfies ReasoningWire` when set;
  `CompileSmartModelOptions.reasoningOff` + pass-through; both
  `buildSmartModelTurnDefinition` and `buildTrialSmartModelTurnDefinition`
  accept and thread `reasoningOff`.
- `apps/api/src/slices/workflows/nodes/smart-model-execution.ts` — finding 3
  runtime side: `paramsRespectingHardOff` applies the shared off wire per
  RESOLVED candidate — `planReasoningOff` (the ONE shared feasibility
  authority) keeps the wire for reasoning-capable non-mandatory models and
  strips it for mandatory (cannot disable; keeps reasoning rather than
  failing the server-picked composite) and non-reasoning (nothing to turn
  off) candidates; hooked into `answerParamsWithEffort`'s effort-free arm.
- `apps/api/src/slices/chat/routes.ts` — both smart builders receive
  `reasoningOff: body.reasoningEffort === 'none'` (paid + trial); the
  `engagedReasoningRefusal` doc comment now states the actual behavior
  (explicit hard-off wire on the composite; mandatory candidates keep
  reasoning) instead of "the composite turn sends none".
- `apps/api/src/slices/chat/domain/smart-model-turn.test.ts` — build-level
  hard-off stamp test (cap untouched alongside the wire).
- `apps/api/src/slices/chat/domain/smart-model-turn.integration.test.ts` —
  trial builder `reasoningOff` stamps the wire, no classify dimension.

## Tests added (name — behavior — finding)

- routes.integration: "keeps web search + auto on the regular tool turn (no
  composite — placeholder wire)" — tools ['webSearch'] + `{effort:'medium'}`
  placeholder, zero smartModel nodes — F1.
- routes.integration: "keeps multi-model + auto as N modelCall siblings with
  placeholder wires (no composite)" — 2 siblings, per-model medium wires
  (effort-word + budget-native), zero smartModel nodes — F1.
- routes.integration: "stamps the explicit hard-off wire on a Smart Model +
  none send (201)" — composite params `{enabled:false}`, classify absent — F3.
- smart-model-turn: "stamps the explicit hard-off reasoning wire into the
  node params when reasoningOff is set" — wire + unchanged cap — F3.
- smart-model-turn.integration: "stamps the hard-off wire on a trial Smart
  turn when the send selected none" — trial threading — F3.
- smart-model-execution (new describe "hard-off wire"): off wire sent to a
  reasoning-capable non-mandatory resolved candidate (cap unchanged); wire
  STRIPPED for a mandatory-reasoning candidate; wire STRIPPED for a
  non-reasoning candidate; a non-off reasoning param passes through untouched
  (branch pin) — F3.

## Self-gate (scoped per §Gate-policy-amendment; no full-package runs)

- Finding-1 pins vs CURRENT code — pass (2/2 first run; the gate holds, no
  flag needed).
- `pnpm test:watch src/slices/chat/routes.integration.test.ts --run` — pass
  (180/180, full file).
- `pnpm test:watch src/slices/chat/domain/smart-model-turn.test.ts --run` —
  pass (35/35).
- `pnpm test:watch src/slices/chat/domain/smart-model-turn.integration.test.ts --run`
  — pass (5/5).
- `pnpm test:watch src/slices/workflows/nodes/smart-model-execution.test.ts --run`
  — pass (39/39).
- shared `src/mock-directives.test.ts` — pass (9/9).
- `npx tsc --noEmit` from packages/shared and apps/api — pass (exit 0 both).
- `npx eslint` on all 7 touched files, run from the package dirs AFTER the
  final edit (incl. a re-lint after the last test addition) — pass (exit 0).

## Acceptance criteria (per the fix brief)

- F1 two route pins, watch-pass — MET (both passed first run against
  unmodified route code; neither conjunct has regressed).
- F2 one-line dedup via `z.enum(CLASSIFIER_EFFORT_LEVELS)`, no cycle — MET.
- F3 hard-off ruling on the composite path — MET: `none` stamps the explicit
  `{enabled:false}` wire (never omission) applied per resolved candidate;
  mandatory candidates get no off wire (documented in `SmartModelTurnParams`,
  `paramsRespectingHardOff`, and the route comment); B = 0 and caps unchanged
  (the stamp adds no cap term; `nodeReasoningBudgetTokens` reads the off wire
  as 0; test-pinned cap equality); comment fixed; new wire TDD'd (build test
  RED → GREEN; the two execution strip tests RED → GREEN; route test RED →
  GREEN). Diff well under the ~60-line stop bound (~45 non-test lines).

## Deviations, with reasons

1. **Trial composite also wires hard-off.** The ruling is model-scoped, not
   route-scoped, and the trial Smart turn is the same composite; threading
   was 4 plumbing lines through the shared compile tail. Raised for the
   auditor in case the orchestrator meant paid-only.
2. The `{ enabled: false }` literal in `buildSmartModelTurn` is typed
   `satisfies ReasoningWire` against the ONE shared wire schema rather than
   imported as a constant — exporting a shared constant would edit
   T16-owned `reasoning-plan.ts`, outside T7's files. TS pins the shape.

## Concerns and limitations

- TDD note: the trial-builder threading and the non-off-wire pass-through
  branch were pinned by tests written after their (already-green) plumbing —
  the load-bearing behaviors (stamp, per-candidate strip, route seam) all had
  observed REDs.
- A `none` Smart turn can still produce reasoning when the classifier
  resolves a MANDATORY-reasoning candidate — the documented consequence of
  "one candidate cannot refuse the server-picked composite" (the plain path,
  by contrast, refuses the whole turn). Product-visible; flagged for the
  auditor as the ruling's edge.
- Per-file coverage not re-measured (full gates run once at Phase-4 close per
  the amendment); every new branch is exercised both ways by the tests above.

## Confidence

high — all three findings are test-pinned at the layer they live (route
integration for the gate pins and the seam, build unit + trial integration
for the stamp, execution unit for per-candidate application), and all scoped
gates (tests, tsc, eslint-after-final-edit) are green.
