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
    // Agentic loops: the declared max feeds admission like fanOut width.
    maxSteps: z.number().int().min(1).default(1),
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
    /** Answer-call parameters (the classifier call sets only its output cap). */
    params: z.record(z.string(), z.unknown()).default({}),
    in: PortRef,
  }),
]);

export type Node = z.infer<typeof Node>;

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

export const WorkflowDefinition = z.object({
  version: z.number().int().min(1),
  deadlineClass: z.enum(DEADLINE_CLASSES),
  hooks: PolicyHooks,
  nodes: z.array(Node),
  edges: z.array(Edge),
});

export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;
