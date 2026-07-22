import { z } from 'zod';
import { Edge, NodeId, PortId, PortRef } from './type-tag.js';

/**
 * WorkflowDefinition: a serializable, Zod-validated JSON DAG
 * over the closed v1 node set. Definitions are DATA; node implementations
 * live in the versioned code registry keyed `(type, version)`. Runtime node
 * schemas are derived from declared ports via `zodFor` — never hand-written
 * here (this file validates definition *shape*, not channel values).
 */
export const NODE_TYPES = [
  'modelCall',
  'transform',
  'fanOut',
  'fanIn',
  'branch',
  'loop',
  'subWorkflow',
  'smartModel',
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

/**
 * Base fields on EVERY variant: `version` pins impls (CI fails on a
 * dangling (type,version)); `out` makes every node's output addressable by
 * an Edge; `optional` + `onError` are the typed optional branches — billable
 * when the run succeeds.
 */
const nodeBase = {
  id: NodeId,
  version: z.number().int().min(1),
  out: PortId,
  optional: z.boolean().default(false),
  onError: z.enum(['fail', 'skip']).default('fail'),
};

export const Node = z.discriminatedUnion('type', [
  z.object({
    ...nodeBase,
    type: z.literal('modelCall'),
    model: z.string().min(1),
    params: z.record(z.string(), z.unknown()),
    in: PortRef,
    // Server-side tool names the call may use during its agentic loop, resolved
    // against the closed tool registry at execution wiring (e.g. `webSearch`).
    // Definition data, not client intent — server-derived, so it does not
    // perturb the request body hash. Empty is the plain (no-tool) call.
    tools: z.array(z.string().min(1)).default([]),
    // Agentic loops: the declared max feeds admission like fanOut width.
    maxSteps: z.number().int().min(1).default(1),
    // Admission-only: the estimated prompt input-token count that bounds the
    // input leg of the admission ceiling. Server-derived like `maxSteps`, it
    // lives on the node (NOT in `params`) and is NEVER forwarded to the
    // provider — it is not a call parameter. Absent ⇒ the estimator falls back
    // to the full context window (fail-closed over-reserve).
    promptInputTokens: z.number().int().nonnegative().optional(),
  }),
  z.object({
    ...nodeBase,
    type: z.literal('transform'),
    transform: z.string().min(1),
    in: PortRef,
  }),
  z.object({
    ...nodeBase,
    type: z.literal('fanOut'),
    over: PortRef,
    body: NodeId,
    // Admission prices the declared max width.
    maxWidth: z.number().int().min(1),
  }),
  z.object({
    ...nodeBase,
    type: z.literal('fanIn'),
    reducer: z.string().min(1),
    ins: z.array(PortRef).min(1),
  }),
  z.object({
    ...nodeBase,
    type: z.literal('branch'),
    predicate: z.string().min(1),
    // N-way (Smart Model needs it); targets may be the 'end' sentinel.
    cases: z.record(z.string(), NodeId),
    else: NodeId,
  }),
  z.object({
    ...nodeBase,
    type: z.literal('loop'),
    body: NodeId,
    until: z.string().min(1),
    // Admission multiplies by the declared bound.
    maxIterations: z.number().int().min(1),
  }),
  z.object({ ...nodeBase, type: z.literal('subWorkflow'), ref: z.string().min(1) }),
  z.object({
    ...nodeBase,
    type: z.literal('smartModel'),
    // The cheapest candidate doubles as classifier and fallback; both fields
    // are server-derived definition data (never client intent), so they do
    // not perturb the request body hash.
    classifierModelId: z.string().min(1),
    candidates: z
      .array(
        z.object({
          id: z.string().min(1),
          // Feeds the classifier prompt line; absent renders id-only.
          description: z.string().optional(),
        })
      )
      .min(1),
    /**
     * The classifier dimensions this node requests (D3, dimension-composed):
     * `model` routes among the candidates, `effort` classifies the canonical
     * reasoning-effort scale. Absent = `{ model: true, effort: false }` — the
     * legacy Smart Model shape. A pinned-model auto-effort turn declares
     * `{ model: false, effort: true }` over its single candidate. Strict so a
     * misspelled dimension fails the parse instead of silently not running.
     */
    classify: z.strictObject({ model: z.boolean(), effort: z.boolean() }).optional(),
    /** Answer-call parameters (the classifier call sets only its output cap). */
    params: z.record(z.string(), z.unknown()).default({}),
    // Admission-only prompt input-token count for the candidate answer legs —
    // same role and constraints as the modelCall field above (node-level,
    // never forwarded to the provider).
    promptInputTokens: z.number().int().nonnegative().optional(),
    in: PortRef,
  }),
]);

export type Node = z.infer<typeof Node>;

/**
 * The dimensions a smartModel node's classifier call ACTUALLY classifies —
 * the single authority admission's classifier-reserve condition and the node
 * execution both derive from, so the reserve can never disagree with whether
 * a generation happens. The declared `model` dimension deactivates on a
 * single candidate (nothing to route — the short-circuit); `effort` is
 * active exactly as declared. The classifier call runs iff either dimension
 * is active.
 */
export function smartModelClassifierDimensions(node: Extract<Node, { type: 'smartModel' }>): {
  readonly model: boolean;
  readonly effort: boolean;
} {
  const declared = node.classify ?? { model: true, effort: false };
  return { model: declared.model && node.candidates.length > 1, effort: declared.effort };
}

/**
 * Instance-deadline classes: the deadline alarm is run *control* —
 * at breach the executor stops the stream and settles any billable partial.
 */
export const DEADLINE_CLASSES = ['text', 'media'] as const;
export type DeadlineClass = (typeof DEADLINE_CLASSES)[number];

export const DEADLINE_CLASS_MS: Record<DeadlineClass, number> = {
  text: 5 * 60 * 1000,
  media: 15 * 60 * 1000,
};

/** Admission-hook name: chat = balance check + Redis hold; trial = quota. */
export const AdmissionHookName = z.string().min(1).brand<'AdmissionHookName'>();
export type AdmissionHookName = z.infer<typeof AdmissionHookName>;

/** Settlement-hook name: chat = saveChatTurn + chargeWithinTx(SettlementTx, …). */
export const SettlementHookName = z.string().min(1).brand<'SettlementHookName'>();
export type SettlementHookName = z.infer<typeof SettlementHookName>;

/**
 * The two typed policy hooks every definition declares — the
 * anti-duplication seam: no run starts or settles except through these.
 */
export const PolicyHooks = z.object({
  admission: AdmissionHookName,
  settlement: SettlementHookName,
});

export type PolicyHooks = z.infer<typeof PolicyHooks>;

/**
 * The admission-only storage stamp a PERSISTING turn carries on its definition:
 * the prompt character count and the payer's tier the estimator needs to add the
 * storage settlement will bill to the admission ceiling. It rides the DEFINITION
 * rather than the run transport because the payer tier is a route-time funding
 * decision that never reaches the conversation DO, where the per-run estimate is
 * computed — the definition is the only server-built value that both crosses that
 * boundary and is re-validated there, so a definition field transports for free.
 * Admission-only and NEVER forwarded to a provider (unlike node `params`), which
 * is why it is a typed definition field, not a params entry. It carries a count
 * and a tier, no user content, so the "definition stays safe to log" invariant
 * holds; and being server-derived it does not perturb the request body hash. The
 * tier set mirrors the canonical `UserTier` union in `tiers.ts`.
 */
export const StorageStamp = z.object({
  inputChars: z.number().int().nonnegative(),
  tier: z.enum(['trial', 'guest', 'free', 'paid']),
});

export type StorageStamp = z.infer<typeof StorageStamp>;

export const WorkflowDefinition = z.object({
  version: z.number().int().min(1),
  deadlineClass: z.enum(DEADLINE_CLASSES),
  hooks: PolicyHooks,
  nodes: z.array(Node),
  edges: z.array(Edge),
  // Present only on persisting chat turns (stamped from the TurnBudget); a
  // general or no-persist definition omits it, so the estimator adds zero storage.
  storage: StorageStamp.optional(),
});

export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;
